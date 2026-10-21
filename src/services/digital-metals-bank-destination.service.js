import { createId } from "../lib/ids.js";
import { seal, unseal } from "../lib/crypto.js";
import { errors, AppError } from "../lib/app-error.js";
import { Customer, DigitalMetalBankDestination, User } from "../models/index.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";
import { digitalMetalsDemoBankAutoVerifyOnCreate } from "../lib/digital-metals-demo-policy.js";
import { mapAdminCustomerBrief } from "../lib/digital-metals-admin-customer-brief.js";
import { applyAdminCustomerScopeFilter } from "../lib/digital-metals-admin-scope.js";
import { paginateByIdCursor } from "../lib/digital-metals-customer-order-access.js";

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

function maskDestination(row, extras = {}) {
  if (!row) return null;
  return {
    id: row._id,
    customerId: row.customerId,
    accountHolderName: row.accountHolderName,
    accountLast4: row.accountLast4,
    ifsc: row.ifsc,
    bankName: row.bankName ?? "",
    status: row.status,
    manualVerificationNote: row.manualVerificationNote ?? "",
    verifiedAt: row.verifiedAt ?? null,
    verifiedByUserId: row.verifiedByUserId ?? null,
    verifiedByName: extras.verifiedByName ?? null,
    verificationEvidenceUploadIds: row.verificationEvidenceUploadIds ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    customer: extras.customer ?? null,
  };
}

export function buildFrozenDestinationSnapshot(row) {
  return {
    destinationId: row._id,
    accountHolderName: row.accountHolderName,
    accountLast4: row.accountLast4,
    ifsc: row.ifsc,
    bankName: row.bankName ?? "",
    verificationStatus: row.status,
    verifiedAt: row.verifiedAt ?? null,
  };
}

async function assertCustomerOwnsDestination(tenantId, customerId, destinationId) {
  const row = await DigitalMetalBankDestination.findOne({
    _id: destinationId,
    tenantId,
    customerId,
  }).lean();
  if (!row) throw errors.notFound("Bank destination");
  return row;
}

/** Demo seeds / explicit test harness: verify pending destinations (not invoked on list GET). */
export async function demoVerifyCustomerBankDestinationsForTesting(tenantId, customerId, note) {
  if (!digitalMetalsDemoBankAutoVerifyOnCreate()) {
    throw new AppError(
      "DEMO_BANK_VERIFY_DISABLED",
      "Set DIGITAL_METALS_DEMO_BANK_VERIFY=true for demo bank verification helpers.",
      409,
    );
  }
  await DigitalMetalBankDestination.updateMany(
    {
      tenantId,
      customerId,
      status: "PENDING_VERIFICATION",
    },
    {
      $set: {
        status: "ACTIVE",
        verifiedAt: new Date(),
        manualVerificationNote:
          note ?? "Demo: verified via explicit demo bank verification helper (not list GET).",
      },
    },
  );
}

export async function listCustomerBankDestinations(req) {
  const rows = await DigitalMetalBankDestination.find({
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
    status: { $ne: "DISABLED" },
  })
    .sort({ createdAt: -1 })
    .lean();
  return { items: rows.map(maskDestination) };
}

export async function createCustomerBankDestination(req) {
  const accountNumber = String(req.body.accountNumber ?? "").replace(/\s/g, "");
  const ifsc = String(req.body.ifsc ?? "").trim().toUpperCase();
  const accountHolderName = String(req.body.accountHolderName ?? "").trim();
  if (accountNumber.length < 4 || accountNumber.length > 18) {
    throw errors.validation([{ field: "accountNumber", message: "Invalid account number length." }]);
  }
  if (!IFSC_RE.test(ifsc)) {
    throw errors.validation([{ field: "ifsc", message: "Invalid IFSC format." }]);
  }
  if (accountHolderName.length < 2) {
    throw errors.validation([{ field: "accountHolderName", message: "Account holder name is required." }]);
  }
  const demoActive = digitalMetalsDemoBankAutoVerifyOnCreate();
  const row = await DigitalMetalBankDestination.create({
    _id: createId("dmbd"),
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
    accountHolderName,
    accountNumberSealed: seal(accountNumber),
    accountLast4: accountNumber.slice(-4),
    ifsc,
    bankName: String(req.body.bankName ?? "").trim().slice(0, 120),
    status: demoActive ? "ACTIVE" : "PENDING_VERIFICATION",
    ...(demoActive
      ? {
          verifiedAt: new Date(),
          manualVerificationNote: "Demo: auto-verified on create (DIGITAL_METALS_DEMO_BANK_VERIFY=true).",
        }
      : {}),
  });
  return maskDestination(row.toObject());
}

export async function patchCustomerBankDestination(req) {
  const row = await DigitalMetalBankDestination.findOne({
    _id: req.params.destinationId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  });
  if (!row) throw errors.notFound("Bank destination");
  if (row.status === "DISABLED") {
    throw new AppError("DESTINATION_DISABLED", "This bank destination is disabled.", 409);
  }
  const confirmAccountNumber = String(req.body.confirmAccountNumber ?? "").replace(/\s/g, "");
  if (confirmAccountNumber) {
    const current = unseal(row.accountNumberSealed);
    if (confirmAccountNumber !== current) {
      throw new AppError("RECONFIRMATION_FAILED", "Account number confirmation did not match.", 422);
    }
  } else if (req.body.accountNumber) {
    throw errors.validation([
      { field: "confirmAccountNumber", message: "Reconfirm account number when changing bank details." },
    ]);
  }
  if (req.body.accountHolderName) row.accountHolderName = String(req.body.accountHolderName).trim().slice(0, 120);
  if (req.body.bankName !== undefined) row.bankName = String(req.body.bankName ?? "").trim().slice(0, 120);
  if (req.body.accountNumber) {
    const accountNumber = String(req.body.accountNumber).replace(/\s/g, "");
    row.accountNumberSealed = seal(accountNumber);
    row.accountLast4 = accountNumber.slice(-4);
    row.status = "PENDING_VERIFICATION";
    row.verifiedAt = null;
    row.verifiedByUserId = null;
  }
  if (req.body.ifsc) {
    const ifsc = String(req.body.ifsc).trim().toUpperCase();
    if (!IFSC_RE.test(ifsc)) {
      throw errors.validation([{ field: "ifsc", message: "Invalid IFSC format." }]);
    }
    row.ifsc = ifsc;
    row.status = "PENDING_VERIFICATION";
  }
  await row.save();
  return maskDestination(row.toObject());
}

async function staffNameById(tenantId, userId) {
  if (!userId) return null;
  const u = await User.findOne({ _id: userId, tenantId }).select("name").lean();
  return u?.name ?? null;
}

export async function listAdminCustomerBankDestinations(req) {
  const cust = await Customer.findOne({
    _id: req.params.customerId,
    tenantId: req.auth.tenantId,
  }).lean();
  assertTenantOwnsCustomerScope(req, cust);
  const rows = await DigitalMetalBankDestination.find({
    tenantId: req.auth.tenantId,
    customerId: req.params.customerId,
  })
    .sort({ createdAt: -1 })
    .lean();
  const verifierIds = [...new Set(rows.map((r) => r.verifiedByUserId).filter(Boolean))];
  const verifiers = verifierIds.length
    ? await User.find({ tenantId: req.auth.tenantId, _id: { $in: verifierIds } }).select("name").lean()
    : [];
  const nameById = new Map(verifiers.map((u) => [u._id, u.name]));
  return {
    items: rows.map((r) =>
      maskDestination(r, { verifiedByName: nameById.get(r.verifiedByUserId) ?? null }),
    ),
  };
}

export async function listAdminBankVerificationQueue(req) {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const cursor = req.query.cursor ? String(req.query.cursor).trim() : null;
  const status = req.query.status
    ? String(req.query.status).trim()
    : "PENDING_VERIFICATION";
  const filter = { tenantId: req.auth.tenantId };
  if (status !== "ALL") filter.status = status;
  await applyAdminCustomerScopeFilter(req, filter, { customerIdQuery: req.query.customerId });
  if (cursor) filter._id = { $lt: cursor };
  const rows = await DigitalMetalBankDestination.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { items, meta } = paginateByIdCursor(rows, limit);
  const customerIds = [...new Set(items.map((r) => r.customerId).filter(Boolean))];
  const customers = customerIds.length
    ? await Customer.find({ tenantId: req.auth.tenantId, _id: { $in: customerIds } }).lean()
    : [];
  const customerById = new Map(customers.map((c) => [c._id, mapAdminCustomerBrief(c)]));
  const verifierIds = [...new Set(items.map((r) => r.verifiedByUserId).filter(Boolean))];
  const verifiers = verifierIds.length
    ? await User.find({ tenantId: req.auth.tenantId, _id: { $in: verifierIds } }).select("name").lean()
    : [];
  const nameById = new Map(verifiers.map((u) => [u._id, u.name]));
  return {
    items: items.map((r) =>
      maskDestination(r, {
        customer: customerById.get(r.customerId) ?? null,
        verifiedByName: nameById.get(r.verifiedByUserId) ?? null,
      }),
    ),
    meta,
  };
}

export async function adminVerifyBankDestination(req) {
  const row = await DigitalMetalBankDestination.findOne({
    _id: req.params.destinationId,
    tenantId: req.auth.tenantId,
    customerId: req.params.customerId,
  });
  if (!row) throw errors.notFound("Bank destination");
  if (row.status === "DISABLED") {
    throw new AppError("DESTINATION_DISABLED", "Disabled destinations cannot be verified.", 409);
  }
  const cust = await Customer.findOne({ _id: req.params.customerId, tenantId: req.auth.tenantId }).lean();
  assertTenantOwnsCustomerScope(req, cust);
  const activate = req.body.activate !== false;
  row.status = activate ? "ACTIVE" : "PENDING_VERIFICATION";
  row.manualVerificationNote = String(
    req.body.note ?? (activate ? "Manually verified by staff." : "Returned to pending verification."),
  ).slice(0, 2000);
  row.verifiedByUserId = req.auth.id;
  row.verifiedAt = new Date();
  if (Array.isArray(req.body.evidenceUploadIds)) {
    row.verificationEvidenceUploadIds = req.body.evidenceUploadIds.map(String).slice(0, 10);
  }
  await row.save();
  const verifiedByName = await staffNameById(req.auth.tenantId, row.verifiedByUserId);
  return maskDestination(row.toObject(), { customer: mapAdminCustomerBrief(cust), verifiedByName });
}

export async function adminDisableBankDestination(req) {
  const row = await DigitalMetalBankDestination.findOne({
    _id: req.params.destinationId,
    tenantId: req.auth.tenantId,
    customerId: req.params.customerId,
  });
  if (!row) throw errors.notFound("Bank destination");
  const cust = await Customer.findOne({ _id: req.params.customerId, tenantId: req.auth.tenantId }).lean();
  assertTenantOwnsCustomerScope(req, cust);
  row.status = "DISABLED";
  row.manualVerificationNote = String(req.body.note ?? "Disabled by staff.").slice(0, 2000);
  row.verifiedByUserId = req.auth.id;
  row.verifiedAt = new Date();
  if (Array.isArray(req.body.evidenceUploadIds)) {
    row.verificationEvidenceUploadIds = req.body.evidenceUploadIds.map(String).slice(0, 10);
  }
  await row.save();
  const verifiedByName = await staffNameById(req.auth.tenantId, row.verifiedByUserId);
  return maskDestination(row.toObject(), { customer: mapAdminCustomerBrief(cust), verifiedByName });
}

export async function loadActiveBankDestinationForCustomer(tenantId, customerId, destinationId) {
  const row = await assertCustomerOwnsDestination(tenantId, customerId, destinationId);
  if (row.status !== "ACTIVE") {
    throw new AppError(
      "BANK_DESTINATION_NOT_VERIFIED",
      "Bank destination must be manually verified before sell confirmation.",
      409,
      { destinationId, status: row.status },
    );
  }
  return row;
}
