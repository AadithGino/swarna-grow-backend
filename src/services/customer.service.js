import { AuditEntityType, CustomerStatus, KycStatus } from "../constants/enums.js";
import { Branch, Customer, LedgerEntry, Message, Payment, Scheme } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { effectiveScope, searchRegex } from "../lib/query-filters.js";
import { writeAudit } from "./audit.service.js";
import { nextSequence } from "./sequence.service.js";
import { canonicalMobile, mobileLookupVariants } from "../lib/mobile.js";
import { appErrorFromDuplicateKey } from "../lib/mongo-duplicate.js";

const STATUS_LABELS = { ACTIVE: "Active", BLOCKED: "Blocked", INACTIVE: "Inactive" };

export async function customerAnalytics(req) {
  const scope = effectiveScope(req);
  const match = { ...scope };
  const [
    total,
    active,
    blocked,
    inactive,
    kycVerified,
    kycPending,
    byStatus,
    byBranch,
    registrationTrend,
    withActiveScheme,
  ] = await Promise.all([
    Customer.countDocuments(match),
    Customer.countDocuments({ ...match, status: CustomerStatus.ACTIVE }),
    Customer.countDocuments({ ...match, status: CustomerStatus.BLOCKED }),
    Customer.countDocuments({ ...match, status: CustomerStatus.INACTIVE }),
    Customer.countDocuments({ ...match, "kyc.status": KycStatus.VERIFIED }),
    Customer.countDocuments({ ...match, "kyc.status": { $in: [KycStatus.SUBMITTED, KycStatus.NOT_SUBMITTED] } }),
    Customer.aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    scope.branchId
      ? Promise.resolve([])
      : Customer.aggregate([{ $match: match }, { $group: { _id: "$branchId", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Customer.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "Asia/Kolkata" } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $limit: 12 },
    ]),
    Scheme.distinct("customerId", { ...match, status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] } }).then((ids) => ids.length),
  ]);

  const branchIds = byBranch.map((row) => row._id).filter(Boolean);
  const branches = branchIds.length
    ? await Branch.find({ _id: { $in: branchIds }, tenantId: scope.tenantId }).select("_id name code").lean()
    : [];
  const branchName = new Map(branches.map((row) => [row._id, row.name || row.code || row._id]));

  const summary = [
    { key: "TOTAL", label: "Total customers", value: total, valueType: "count" },
    { key: "ACTIVE", label: "Active", value: active, valueType: "count" },
    { key: "BLOCKED", label: "Blocked", value: blocked, valueType: "count", severity: blocked > 0 ? "WARNING" : undefined },
    { key: "KYC_VERIFIED", label: "KYC verified", value: kycVerified, valueType: "count" },
    { key: "KYC_PENDING", label: "KYC pending", value: kycPending, valueType: "count" },
    { key: "WITH_ACTIVE_SCHEME", label: "With active scheme", value: withActiveScheme, valueType: "count" },
  ];

  const charts = {
    customerStatusDistribution: {
      chartType: "donut",
      title: "Customer status",
      yAxis: { type: "count", label: "Customers" },
      series: [{
        key: "STATUS",
        name: "Customers",
        data: byStatus.map((row) => ({
          x: STATUS_LABELS[row._id] ?? row._id ?? "Unknown",
          y: row.count,
          yDisplay: String(row.count),
          modeKey: row._id,
        })),
      }],
    },
    registrationTrend: {
      chartType: "line",
      title: "Registrations",
      yAxis: { type: "count", label: "Customers" },
      series: [{
        key: "REG",
        name: "Customers",
        data: registrationTrend.map((row) => ({
          x: row._id,
          y: row.count,
          yDisplay: String(row.count),
        })),
      }],
    },
  };

  if (!scope.branchId) {
    charts.customersByBranch = {
      chartType: "horizontalBar",
      title: "Customers by branch",
      yAxis: { type: "count", label: "Customers" },
      series: [{
        key: "BRANCH",
        name: "Customers",
        data: byBranch.map((row) => ({
          x: branchName.get(row._id) ?? row._id ?? "Unassigned",
          y: row.count,
          yDisplay: String(row.count),
        })),
      }],
    };
  }

  return {
    total,
    active,
    blocked,
    inactive,
    kycVerified,
    kycPending,
    withActiveScheme,
    customersByBranch: byBranch.map((row) => ({
      branchId: row._id,
      name: branchName.get(row._id) ?? row._id,
      count: row.count,
    })),
    summary,
    charts,
  };
}

export async function listCustomers(req) {
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  const scope = effectiveScope(req);
  const kycStatus = req.query.kycStatus ?? req.query.kyc;
  if (kycStatus) filters["kyc.status"] = kycStatus;
  const pattern = searchRegex(req.query.q);
  if (pattern) {
    filters.$or = [{ name: pattern }, { mobile: pattern }, { customerNumber: pattern }, { passbookNumber: pattern }, { email: pattern }];
  }
  const result = await paginate(Customer, {
    scope,
    filters,
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: req.query.sort ?? "createdAt:desc",
  });
  if (!result.data.length) return result;

  const customerIds = result.data.map((row) => row._id);
  const branchIds = [...new Set(result.data.map((row) => row.branchId).filter(Boolean))];
  const [branches, schemes] = await Promise.all([
    Branch.find({ _id: { $in: branchIds }, tenantId: req.auth.tenantId }).select("_id name code").lean(),
    Scheme.find({
      tenantId: req.auth.tenantId,
      customerId: { $in: customerIds },
      status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED", "MATURED"] },
    })
      .select("_id customerId status enrollmentNumber installmentAmountPaise installments maturityDate")
      .lean(),
  ]);
  const branchMap = new Map(branches.map((row) => [row._id, row]));
  const schemesByCustomer = new Map();
  for (const scheme of schemes) {
    const list = schemesByCustomer.get(scheme.customerId) ?? [];
    list.push(scheme);
    schemesByCustomer.set(scheme.customerId, list);
  }

  const today = new Date().toISOString().slice(0, 10);
  result.data = result.data.map((customer) => {
    const branch = branchMap.get(customer.branchId);
    const customerSchemes = schemesByCustomer.get(customer._id) ?? [];
    const activeSchemes = customerSchemes.filter((row) =>
      ["ACTIVE", "LOCKED", "DEFAULTED"].includes(row.status),
    );
    let nextDue = null;
    let overduePaise = 0;
    for (const scheme of activeSchemes) {
      for (const inst of scheme.installments ?? []) {
        if (["PAID", "WAIVED"].includes(inst.status)) continue;
        const remaining = Math.max(0, Number(inst.amountPaise ?? 0) - Number(inst.paidPaise ?? 0));
        if (!remaining) continue;
        if (inst.status === "OVERDUE" || (inst.dueDate && inst.dueDate < today && ["DUE", "PARTIALLY_PAID", "PENDING"].includes(inst.status))) {
          overduePaise += remaining;
        }
        if (
          !nextDue ||
          (inst.dueDate && (!nextDue.date || inst.dueDate < nextDue.date))
        ) {
          nextDue = {
            date: inst.dueDate ?? null,
            amountPaise: remaining || scheme.installmentAmountPaise || 0,
            schemeId: scheme._id,
            enrollmentNumber: scheme.enrollmentNumber,
          };
        }
      }
      if (!nextDue && scheme.maturityDate) {
        nextDue = {
          date: scheme.maturityDate,
          amountPaise: scheme.installmentAmountPaise || 0,
          schemeId: scheme._id,
          enrollmentNumber: scheme.enrollmentNumber,
        };
      }
    }
    return {
      ...customer,
      branch: branch
        ? { _id: branch._id, id: branch._id, name: branch.name, code: branch.code }
        : null,
      schemeSummary: {
        active: activeSchemes.length,
        total: customerSchemes.length,
      },
      nextDue,
      overdue: { amountPaise: overduePaise },
    };
  });
  return result;
}
function customerMobileConflictError() {
  return new AppError(
    "CUSTOMER_MOBILE_EXISTS",
    "This mobile number is already registered for a customer in this jewellery.",
    409,
    [
      {
        field: "body.mobile",
        message:
          "This mobile number is already registered for a customer in this jewellery.",
      },
    ],
  );
}

function buildCustomerWritePayload(body, { branchId }) {
  const mobile = canonicalMobile(body.mobile);
  const payload = {
    name: body.name,
    mobile,
    branchId,
  };
  if (body.email != null && String(body.email).trim()) {
    payload.email = String(body.email).trim();
  }
  if (body.dateOfBirth != null && String(body.dateOfBirth).trim()) {
    payload.dateOfBirth = String(body.dateOfBirth).trim();
  }
  if (body.address != null && String(body.address).trim()) {
    payload.address = String(body.address).trim();
  }
  if (body.passbookNumber != null && String(body.passbookNumber).trim()) {
    payload.passbookNumber = String(body.passbookNumber).trim();
  }
  return payload;
}

async function assertCustomerMobileAvailable(
  tenantId,
  mobile,
  { session, excludeCustomerId } = {},
) {
  const variants = mobileLookupVariants(mobile);
  if (!variants.length) return;
  const filter = { tenantId, mobile: { $in: variants } };
  if (excludeCustomerId) filter._id = { $ne: excludeCustomerId };
  const existing = await Customer.findOne(filter)
    .session(session ?? null)
    .select("_id name customerNumber mobile")
    .lean();
  if (!existing) return;
  throw customerMobileConflictError();
}

export async function createCustomer(req) {
  const branchId = req.scope.branchId ?? req.body.branchId;
  const writePayload = buildCustomerWritePayload(req.body, { branchId });

  await assertCustomerMobileAvailable(req.auth.tenantId, writePayload.mobile);

  return withTransaction(async (session) => {
    await assertCustomerMobileAvailable(req.auth.tenantId, writePayload.mobile, {
      session,
    });
    const number = await nextSequence(req.auth.tenantId, "customer", session);
    let customer;
    try {
      customer = (
        await Customer.create(
          [
            {
              _id: createId("customer"),
              tenantId: req.auth.tenantId,
              customerNumber: `CUS-${String(number).padStart(6, "0")}`,
              ...writePayload,
              createdBy: req.auth.id,
            },
          ],
          { session },
        )
      )[0];
    } catch (error) {
      if (error?.code === 11000) {
        const variants = mobileLookupVariants(writePayload.mobile);
        const dupMobile = await Customer.findOne({
          tenantId: req.auth.tenantId,
          mobile: { $in: variants },
        })
          .session(session)
          .select("_id")
          .lean();
        if (dupMobile) throw customerMobileConflictError();
        throw appErrorFromDuplicateKey(error);
      }
      throw error;
    }
    const auditEventId = await writeAudit({
      req,
      action: "CUSTOMER_CREATED",
      entityType: AuditEntityType.CUSTOMER,
      entityId: customer._id,
      after: customer.toObject(),
      session,
    });
    return { ...customer.toObject(), auditEventId };
  });
}
export async function getCustomer(req) { const customer = await Customer.findOne({ _id: req.params.customerId, ...req.scope }).lean(); if (!customer) throw errors.notFound("Customer"); return customer; }
export async function customer360(req) {
  const customer = await getCustomer(req);
  const [schemes, payments, ledgers, branch] = await Promise.all([
    Scheme.find({ tenantId: customer.tenantId, customerId: customer._id }).lean(),
    Payment.find({ tenantId: customer.tenantId, customerId: customer._id, status: "SUCCESS" }).lean(),
    LedgerEntry.find({ tenantId: customer.tenantId, customerId: customer._id }).lean(),
    customer.branchId
      ? Branch.findOne({ _id: customer.branchId, tenantId: customer.tenantId }).select("_id name code").lean()
      : null,
  ]);
  const lifetimePaidPaise = ledgers
    .filter((row) => ["INSTALLMENT_PAYMENT", "FREE_WINDOW_PAYMENT"].includes(row.type))
    .reduce((sum, row) => sum + row.amountPaise, 0);
  const activeSchemes = schemes.filter((row) => ["ACTIVE", "LOCKED", "DEFAULTED"].includes(row.status));
  const today = new Date().toISOString().slice(0, 10);
  let nextDue = null;
  let overduePaise = 0;
  for (const scheme of activeSchemes) {
    for (const inst of scheme.installments ?? []) {
      if (["PAID", "WAIVED"].includes(inst.status)) continue;
      const remaining = Math.max(0, Number(inst.amountPaise ?? 0) - Number(inst.paidPaise ?? 0));
      if (!remaining) continue;
      if (
        inst.status === "OVERDUE" ||
        (inst.dueDate && inst.dueDate < today && ["DUE", "PARTIALLY_PAID", "PENDING"].includes(inst.status))
      ) {
        overduePaise += remaining;
      }
      if (!nextDue || (inst.dueDate && (!nextDue.date || inst.dueDate < nextDue.date))) {
        nextDue = {
          date: inst.dueDate ?? null,
          amountPaise: remaining || scheme.installmentAmountPaise || 0,
          schemeId: scheme._id,
          enrollmentNumber: scheme.enrollmentNumber,
        };
      }
    }
  }
  return {
    ...customer,
    branch: branch
      ? { _id: branch._id, id: branch._id, name: branch.name, code: branch.code }
      : null,
    nextDue,
    overdue: { amountPaise: overduePaise },
    schemeSummary: { active: activeSchemes.length, total: schemes.length },
    summary: {
      activeSchemes: activeSchemes.length,
      pastSchemes: schemes.filter((row) => ["REDEEMED", "CLOSED_PREMATURE"].includes(row.status)).length,
      lifetimePaidPaise,
      paymentCount: payments.length,
    },
    schemes,
  };
}
export async function updateKyc(req, verify = false) {
  return withTransaction(async (session) => {
    const customer = await Customer.findOne({ _id: req.params.customerId, ...req.scope }).session(session); if (!customer) throw errors.notFound("Customer");
    const before = customer.toObject();
    if (verify) { if (customer.kyc?.status !== KycStatus.SUBMITTED) throw new AppError("KYC_NOT_SUBMITTED", "KYC must be submitted before verification.", 422); customer.kyc.status = req.body.status ?? KycStatus.VERIFIED; customer.kyc.verifiedAt = new Date(); customer.kyc.verifiedBy = req.auth.id; customer.kyc.rejectionReason = req.body.rejectionReason; }
    else customer.kyc = { ...req.body, status: KycStatus.SUBMITTED, submittedAt: new Date() };
    customer.version += 1; await customer.save({ session }); const auditEventId = await writeAudit({ req, action: verify ? "CUSTOMER_KYC_REVIEWED" : "CUSTOMER_KYC_SUBMITTED", entityType: AuditEntityType.CUSTOMER, entityId: customer._id, before, after: customer.toObject(), session }); return { ...customer.toObject(), auditEventId };
  });
}
export async function setNominee(req, remove = false) {
  return withTransaction(async (session) => {
    const customer = await Customer.findOne({ _id: req.params.customerId, ...req.scope }).session(session); if (!customer) throw errors.notFound("Customer");
    if (Number(req.body.expectedVersion ?? req.query.expectedVersion) !== customer.version) throw new AppError("VERSION_CONFLICT", "This customer changed. Refresh and try again.", 409);
    const before = customer.toObject(); customer.nominee = remove ? null : req.body; customer.version += 1; await customer.save({ session });
    const auditEventId = await writeAudit({ req, action: remove ? "CUSTOMER_NOMINEE_REMOVED" : "CUSTOMER_NOMINEE_UPDATED", entityType: AuditEntityType.CUSTOMER, entityId: customer._id, before, after: customer.toObject(), session }); return { nominee: customer.nominee, version: customer.version, auditEventId };
  });
}
export async function blockCustomer(req, blocked = true) { return withTransaction(async (session) => { const customer = await Customer.findOneAndUpdate({ _id: req.params.customerId, ...req.scope }, { $set: { status: blocked ? CustomerStatus.BLOCKED : CustomerStatus.ACTIVE }, $inc: { version: 1 } }, { new: true, session }); if (!customer) throw errors.notFound("Customer"); const auditEventId = await writeAudit({ req, action: blocked ? "CUSTOMER_BLOCKED" : "CUSTOMER_UNBLOCKED", entityType: AuditEntityType.CUSTOMER, entityId: customer._id, after: customer.toObject(), session }); return { id: customer._id, status: customer.status, auditEventId }; }); }
export async function updateCustomer(req) {
  return withTransaction(async (session) => {
    const customer = await Customer.findOne({ _id: req.params.customerId, ...req.scope }).session(session);
    if (!customer) throw errors.notFound("Customer");
    if (req.body.expectedVersion != null && Number(req.body.expectedVersion) !== customer.version) {
      throw new AppError("VERSION_CONFLICT", "This customer changed. Refresh and try again.", 409);
    }
    const before = customer.toObject();
    if (req.body.mobile !== undefined) {
      const nextMobile = canonicalMobile(req.body.mobile);
      if (nextMobile !== customer.mobile) {
        await assertCustomerMobileAvailable(req.auth.tenantId, nextMobile, {
          session,
          excludeCustomerId: customer._id,
        });
        customer.mobile = nextMobile;
      }
    }
    for (const key of ["name", "email", "dateOfBirth", "address", "branchId"]) {
      if (req.body[key] !== undefined) customer[key] = req.body[key];
    }
    if (req.body.passbookNumber !== undefined) {
      const trimmed = String(req.body.passbookNumber ?? "").trim();
      customer.passbookNumber = trimmed || undefined;
    }
    if (req.body.email !== undefined && !String(req.body.email).trim()) {
      customer.email = undefined;
    }
    customer.version += 1;
    await customer.save({ session });
    const auditEventId = await writeAudit({
      req,
      action: "CUSTOMER_UPDATED",
      entityType: AuditEntityType.CUSTOMER,
      entityId: customer._id,
      before,
      after: customer.toObject(),
      session,
    });
    return { ...customer.toObject(), auditEventId };
  });
}
export async function setWhatsappOpt(req) { const optedOut = req.body.optedIn === false; const customer = await Customer.findOneAndUpdate({ _id: req.params.customerId, ...req.scope }, { $set: { whatsappOptedOutAt: optedOut ? new Date() : null }, $inc: { version: 1 } }, { new: true }); if (!customer) throw errors.notFound("Customer"); return { customerId: customer._id, optedIn: !customer.whatsappOptedOutAt, version: customer.version }; }
export async function addNote(req) { const customer = await getCustomer(req); const auditEventId = await writeAudit({ req, action: "CUSTOMER_NOTE_ADDED", entityType: AuditEntityType.CUSTOMER, entityId: customer._id, metadata: { note: req.body.note } }); return { customerId: customer._id, auditEventId }; }
export async function listCustomerRelations(req, relation) {
  await getCustomer(req);
  const query = { tenantId: req.auth.tenantId, customerId: req.params.customerId };
  if (relation === "schemes") {
    const result = await paginate(Scheme, { scope: query, filters: {}, cursor: req.query.cursor, limit: req.query.limit, sort: "createdAt:desc" });
    result.data = result.data.map((scheme) => ({
      ...scheme,
      plan: scheme.planSnapshot
        ? {
            _id: scheme.planId,
            id: scheme.planId,
            name: scheme.planSnapshot.name,
            durationMonths: scheme.planSnapshot.durationMonths,
            valueBasis: scheme.planSnapshot.valueBasis,
            paymentPattern: scheme.planSnapshot.paymentPattern,
          }
        : undefined,
      displayMode:
        scheme.paymentPattern === "FIXED"
          ? "FIXED"
          : scheme.flexiblePhase === "FLEXIBLE"
            ? "FLEXIBLE_FREE_WINDOW"
            : "FLEXIBLE_LOCK_WINDOW",
    }));
    return result;
  }
  if (relation === "payments") {
    const result = await paginate(Payment, { scope: query, filters: {}, cursor: req.query.cursor, limit: req.query.limit, sort: "paidAt:desc" });
    if (!result.data.length) return result;
    const schemeIds = [...new Set(result.data.map((row) => row.schemeId).filter(Boolean))];
    const schemes = await Scheme.find({ _id: { $in: schemeIds } }).select("_id enrollmentNumber planSnapshot.name").lean();
    const schemeMap = new Map(schemes.map((row) => [row._id, row]));
    result.data = result.data.map((row) => {
      const scheme = schemeMap.get(row.schemeId);
      return {
        ...row,
        amount: { amountPaise: row.amountPaise },
        scheme: scheme
          ? {
              _id: scheme._id,
              id: scheme._id,
              enrollmentNumber: scheme.enrollmentNumber,
              schemeNumber: scheme.enrollmentNumber,
              name: scheme.planSnapshot?.name,
            }
          : undefined,
      };
    });
    return result;
  }
  return paginate(Message, { scope: query, filters: {}, cursor: req.query.cursor, limit: req.query.limit, sort: "createdAt:desc" });
}
