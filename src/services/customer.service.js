import { AuditEntityType, CustomerStatus, KycStatus } from "../constants/enums.js";
import { Customer, LedgerEntry, Message, Payment, Scheme } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { writeAudit } from "./audit.service.js";
import { nextSequence } from "./sequence.service.js";

const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export async function listCustomers(req) {
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.branchId && !req.scope.branchId) filters.branchId = req.query.branchId;
  if (req.query.q) { const pattern = new RegExp(escaped(req.query.q), "i"); filters.$or = [{ name: pattern }, { mobile: pattern }, { customerNumber: pattern }, { passbookNumber: pattern }]; }
  return paginate(Customer, { scope: req.scope, filters, cursor: req.query.cursor, limit: req.query.limit, sort: req.query.sort ?? "createdAt:desc" });
}
export async function createCustomer(req) {
  return withTransaction(async (session) => {
    const number = await nextSequence(req.auth.tenantId, "customer", session);
    const customer = (await Customer.create([{ _id: createId("customer"), tenantId: req.auth.tenantId, branchId: req.scope.branchId ?? req.body.branchId, customerNumber: `CUS-${String(number).padStart(6, "0")}`, ...req.body, createdBy: req.auth.id }], { session }))[0];
    const auditEventId = await writeAudit({ req, action: "CUSTOMER_CREATED", entityType: AuditEntityType.CUSTOMER, entityId: customer._id, after: customer.toObject(), session }); return { ...customer.toObject(), auditEventId };
  });
}
export async function getCustomer(req) { const customer = await Customer.findOne({ _id: req.params.customerId, ...req.scope }).lean(); if (!customer) throw errors.notFound("Customer"); return customer; }
export async function customer360(req) {
  const customer = await getCustomer(req);
  const [schemes, payments, ledgers] = await Promise.all([Scheme.find({ tenantId: customer.tenantId, customerId: customer._id }).lean(), Payment.find({ tenantId: customer.tenantId, customerId: customer._id, status: "SUCCESS" }).lean(), LedgerEntry.find({ tenantId: customer.tenantId, customerId: customer._id }).lean()]);
  const lifetimePaidPaise = ledgers.filter((row) => ["INSTALLMENT_PAYMENT", "FREE_WINDOW_PAYMENT"].includes(row.type)).reduce((sum, row) => sum + row.amountPaise, 0);
  return { ...customer, summary: { activeSchemes: schemes.filter((row) => ["ACTIVE", "LOCKED", "DEFAULTED"].includes(row.status)).length, pastSchemes: schemes.filter((row) => ["REDEEMED", "CLOSED_PREMATURE"].includes(row.status)).length, lifetimePaidPaise, paymentCount: payments.length }, schemes };
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
export async function updateCustomer(req) { return withTransaction(async (session) => { const customer = await Customer.findOne({ _id: req.params.customerId, ...req.scope }).session(session); if (!customer) throw errors.notFound("Customer"); if (req.body.expectedVersion != null && Number(req.body.expectedVersion) !== customer.version) throw new AppError("VERSION_CONFLICT", "This customer changed. Refresh and try again.", 409); const before = customer.toObject(); for (const key of ["name", "email", "dateOfBirth", "address", "branchId", "passbookNumber"]) if (req.body[key] !== undefined) customer[key] = req.body[key]; customer.version += 1; await customer.save({ session }); const auditEventId = await writeAudit({ req, action: "CUSTOMER_UPDATED", entityType: AuditEntityType.CUSTOMER, entityId: customer._id, before, after: customer.toObject(), session }); return { ...customer.toObject(), auditEventId }; }); }
export async function setWhatsappOpt(req) { const optedOut = req.body.optedIn === false; const customer = await Customer.findOneAndUpdate({ _id: req.params.customerId, ...req.scope }, { $set: { whatsappOptedOutAt: optedOut ? new Date() : null }, $inc: { version: 1 } }, { new: true }); if (!customer) throw errors.notFound("Customer"); return { customerId: customer._id, optedIn: !customer.whatsappOptedOutAt, version: customer.version }; }
export async function addNote(req) { const customer = await getCustomer(req); const auditEventId = await writeAudit({ req, action: "CUSTOMER_NOTE_ADDED", entityType: AuditEntityType.CUSTOMER, entityId: customer._id, metadata: { note: req.body.note } }); return { customerId: customer._id, auditEventId }; }
export async function listCustomerRelations(req, relation) {
  await getCustomer(req); const query = { tenantId: req.auth.tenantId, customerId: req.params.customerId };
  if (relation === "schemes") return paginate(Scheme, { scope: query, filters: {}, cursor: req.query.cursor, limit: req.query.limit, sort: "createdAt:desc" });
  if (relation === "payments") return paginate(Payment, { scope: query, filters: {}, cursor: req.query.cursor, limit: req.query.limit, sort: "paidAt:desc" });
  return paginate(Message, { scope: query, filters: {}, cursor: req.query.cursor, limit: req.query.limit, sort: "createdAt:desc" });
}
