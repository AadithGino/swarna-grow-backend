import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import {
  Customer,
  DigitalMetalBankDestination,
  DigitalMetalPayable,
  DigitalMetalPayout,
  DigitalMetalSellOrder,
} from "../models/index.js";
import { buildFrozenDestinationSnapshot } from "./digital-metals-bank-destination.service.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";
import { applyAdminCustomerScopeFilter } from "../lib/digital-metals-admin-scope.js";
import { enqueuePayoutCustomerNotice } from "../lib/digital-metals-customer-notice.js";
import {
  paginateByIdCursor,
  parseAdminScopedListQuery,
} from "../lib/digital-metals-customer-order-access.js";
import { OPEN_PAYOUT_IN_FLIGHT_STATUSES } from "../lib/digital-metals-open-work-statuses.js";

const BLOCKING_PAYOUT_STATUSES = new Set(OPEN_PAYOUT_IN_FLIGHT_STATUSES);
/** Counts toward payable cap (failed attempts do not consume liability). */
const PAYABLE_CAP_STATUSES = new Set([...BLOCKING_PAYOUT_STATUSES, "SETTLED"]);

export function buildPermittedPayoutActions(payout, auth) {
  const actions = [];
  if (!payout || !auth?.id) return actions;
  const uid = auth.id;
  if (payout.status === "PENDING_APPROVAL" && payout.makerUserId !== uid) actions.push("APPROVE");
  if (payout.status === "APPROVED" && payout.makerUserId === uid) actions.push("SUBMIT");
  if (["SUBMITTED", "UNKNOWN"].includes(payout.status) && payout.makerUserId === uid) {
    actions.push("RECORD_FAILURE", "MARK_UNKNOWN");
  }
  if (payout.status === "UNKNOWN" && payout.makerUserId !== uid) actions.push("RESOLVE_UNKNOWN");
  if (["SUBMITTED", "UNKNOWN", "APPROVED"].includes(payout.status) && payout.makerUserId !== uid) {
    actions.push("RECORD_SETTLEMENT");
  }
  return actions;
}

function mapPayableRow(row) {
  return {
    id: row._id,
    customerId: row.customerId,
    sellOrderId: row.sellOrderId,
    amountPaise: row.amountPaise,
    outstandingPaise: row.outstandingPaise,
    status: row.status,
  };
}

function mapPayout(row, extras = {}) {
  return {
    id: row._id,
    payableId: row.payableId,
    sellOrderId: row.sellOrderId,
    customerId: row.customerId,
    amountPaise: row.amountPaise,
    status: row.status,
    destinationSnapshot: row.destinationSnapshot,
    makerUserId: row.makerUserId,
    approverUserId: row.approverUserId ?? null,
    approvedAt: row.approvedAt ?? null,
    submittedAt: row.submittedAt ?? null,
    bankReference: row.bankReference ?? "",
    settlementDate: row.settlementDate ?? null,
    settlementEvidenceUploadIds: row.settlementEvidenceUploadIds ?? [],
    settledAt: row.settledAt ?? null,
    settlementVerification: row.settlementVerification ?? null,
    settlementVerificationLabel:
      row.status === "SETTLED" ? "Staff-attested (not bank-API verified)" : null,
    failureReason: row.failureReason ?? "",
    statusHistory: row.statusHistory ?? [],
    version: row.version ?? 1,
    ...extras,
  };
}

function appendStatusHistory(doc, status, actorUserId, note = "") {
  if (!doc.statusHistory) doc.statusHistory = [];
  doc.statusHistory.push({
    at: new Date(),
    status,
    actorUserId: actorUserId ?? null,
    note: String(note).slice(0, 500),
  });
}

async function sumCommittedPayoutPaise(tenantId, payableId, excludePayoutId = null) {
  const filter = { tenantId, payableId, status: { $in: [...PAYABLE_CAP_STATUSES] } };
  if (excludePayoutId) filter._id = { $ne: excludePayoutId };
  const rows = await DigitalMetalPayout.find(filter).select("amountPaise status").lean();
  return rows.reduce((sum, r) => sum + Number(r.amountPaise), 0);
}

async function assertPayoutAmountWithinPayableCap(tenantId, payable, amountPaise, excludePayoutId = null) {
  const committed = await sumCommittedPayoutPaise(tenantId, payable._id, excludePayoutId);
  if (committed + amountPaise > payable.amountPaise) {
    throw new AppError(
      "OVERPAYMENT_PREVENTED",
      "Payout amounts would exceed the original payable.",
      409,
      { committedPaise: committed, payableAmountPaise: payable.amountPaise },
    );
  }
}

async function loadPayable(tenantId, payableId) {
  const payable = await DigitalMetalPayable.findOne({ _id: payableId, tenantId }).lean();
  if (!payable) throw errors.notFound("Payable");
  return payable;
}

async function assertNoBlockingPayout(tenantId, payableId, excludePayoutId = null) {
  const filter = { tenantId, payableId, status: { $in: [...BLOCKING_PAYOUT_STATUSES] } };
  if (excludePayoutId) filter._id = { $ne: excludePayoutId };
  const blocking = await DigitalMetalPayout.findOne(filter).lean();
  if (blocking) {
    throw new AppError(
      "PAYOUT_IN_FLIGHT",
      "Another payout is pending or has unknown outcome for this payable.",
      409,
      { payoutId: blocking._id, status: blocking.status },
    );
  }
}

export async function listAdminPayables(req) {
  const { limit, cursor } = parseAdminScopedListQuery(req);
  const filter = { tenantId: req.auth.tenantId };
  if (req.query.status) filter.status = req.query.status;
  await applyAdminCustomerScopeFilter(req, filter, { customerIdQuery: req.query.customerId });
  if (cursor) filter._id = { $lt: cursor };
  const rows = await DigitalMetalPayable.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { items, meta } = paginateByIdCursor(rows, limit);
  return { items: items.map(mapPayableRow), meta };
}

export async function listAdminPayouts(req) {
  const { limit, cursor } = parseAdminScopedListQuery(req);
  const filter = { tenantId: req.auth.tenantId };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.payableId) filter.payableId = req.query.payableId;
  await applyAdminCustomerScopeFilter(req, filter, { customerIdQuery: req.query.customerId });
  if (cursor) filter._id = { $lt: cursor };
  const rows = await DigitalMetalPayout.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { items, meta } = paginateByIdCursor(rows, limit);
  return {
    items: items.map((row) =>
      mapPayout(row, { permittedActions: buildPermittedPayoutActions(row, req.auth) }),
    ),
    meta,
  };
}

export async function getAdminPayout(req) {
  const payout = await DigitalMetalPayout.findOne({
    _id: req.params.payoutId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!payout) throw errors.notFound("Payout");
  const payable = await DigitalMetalPayable.findById(payout.payableId).lean();
  const cust = payable
    ? await Customer.findOne({ _id: payable.customerId, tenantId: req.auth.tenantId }).lean()
    : null;
  if (cust) assertTenantOwnsCustomerScope(req, cust);
  return {
    payout: mapPayout(payout, { permittedActions: buildPermittedPayoutActions(payout, req.auth) }),
    payable,
  };
}

export async function createPayoutInstruction(req) {
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const existing = await DigitalMetalPayout.findOne({
    tenantId: req.auth.tenantId,
    idempotencyKey,
  }).lean();
  if (existing) return { payout: mapPayout(existing), replay: true };

  const payable = await loadPayable(req.auth.tenantId, req.body.payableId);
  if (payable.status !== "OPEN" || payable.outstandingPaise <= 0) {
    throw new AppError("PAYABLE_NOT_OPEN", "Payable is not outstanding.", 409);
  }
  const cust = await Customer.findOne({ _id: payable.customerId, tenantId: req.auth.tenantId }).lean();
  assertTenantOwnsCustomerScope(req, cust);
  await assertNoBlockingPayout(req.auth.tenantId, payable._id);

  const sellOrder = await DigitalMetalSellOrder.findById(payable.sellOrderId).lean();
  if (!sellOrder?.bankDestinationId) {
    throw new AppError("DESTINATION_MISSING", "Sell order has no bank destination.", 409);
  }
  const destination = await DigitalMetalBankDestination.findOne({
    _id: sellOrder.bankDestinationId,
    tenantId: req.auth.tenantId,
    customerId: payable.customerId,
  }).lean();
  if (!destination) throw errors.notFound("Bank destination");

  const amountPaise = Number(req.body.amountPaise ?? payable.outstandingPaise);
  if (amountPaise <= 0 || amountPaise > payable.outstandingPaise) {
    throw errors.validation([{ field: "amountPaise", message: "Invalid payout amount." }]);
  }
  await assertPayoutAmountWithinPayableCap(req.auth.tenantId, payable, amountPaise);

  const payoutDoc = {
    _id: createId("dmpos"),
    tenantId: req.auth.tenantId,
    payableId: payable._id,
    sellOrderId: payable.sellOrderId,
    customerId: payable.customerId,
    amountPaise,
    status: "PENDING_APPROVAL",
    destinationSnapshot: buildFrozenDestinationSnapshot(destination),
    makerUserId: req.auth.id,
    idempotencyKey,
    settlementEvidenceUploadIds: (req.body.evidenceUploadIds ?? []).map(String).slice(0, 10),
    statusHistory: [],
  };
  appendStatusHistory(payoutDoc, "PENDING_APPROVAL", req.auth.id, "Instruction created");
  const payout = await DigitalMetalPayout.create(payoutDoc);
  return { payout: mapPayout(payout.toObject()), replay: false };
}

export async function approvePayout(req) {
  const payout = await DigitalMetalPayout.findOne({
    _id: req.params.payoutId,
    tenantId: req.auth.tenantId,
  });
  if (!payout) throw errors.notFound("Payout");
  if (payout.status === "APPROVED") return { payout: mapPayout(payout.toObject()) };
  if (payout.status !== "PENDING_APPROVAL") {
    throw new AppError("INVALID_STATE", "Payout is not pending approval.", 409);
  }
  if (payout.makerUserId === req.auth.id) {
    throw new AppError("APPROVAL_DENIED", "Maker cannot approve the same payout instruction.", 403);
  }
  payout.status = "APPROVED";
  payout.approverUserId = req.auth.id;
  payout.approvedAt = new Date();
  appendStatusHistory(payout, "APPROVED", req.auth.id);
  await payout.save();
  return { payout: mapPayout(payout.toObject()) };
}

export async function submitPayout(req) {
  const payout = await DigitalMetalPayout.findOne({
    _id: req.params.payoutId,
    tenantId: req.auth.tenantId,
  });
  if (!payout) throw errors.notFound("Payout");
  if (payout.status === "SUBMITTED") return { payout: mapPayout(payout.toObject()) };
  if (payout.status !== "APPROVED") {
    throw new AppError("INVALID_STATE", "Payout must be approved before bank submission.", 409);
  }
  if (payout.makerUserId !== req.auth.id) {
    throw new AppError(
      "FORBIDDEN",
      "Only the payout instruction maker may record bank submission.",
      403,
    );
  }
  const liveDestination = await DigitalMetalBankDestination.findOne({
    _id: payout.destinationSnapshot?.destinationId,
    tenantId: req.auth.tenantId,
    customerId: payout.customerId,
  }).lean();
  if (!liveDestination || liveDestination.status === "DISABLED") {
    throw new AppError(
      "DESTINATION_UNAVAILABLE",
      "Bank destination was deactivated; resolve or fail the instruction before submission.",
      409,
      { frozenDestinationId: payout.destinationSnapshot?.destinationId },
    );
  }
  payout.status = "SUBMITTED";
  payout.submittedByUserId = req.auth.id;
  payout.submittedAt = new Date();
  payout.bankReference = String(req.body.bankReference ?? "").trim().slice(0, 128);
  if (!payout.bankReference) {
    throw errors.validation([{ field: "bankReference", message: "Bank reference is required for submission." }]);
  }
  appendStatusHistory(payout, "SUBMITTED", req.auth.id, payout.bankReference);
  await payout.save();
  return { payout: mapPayout(payout.toObject()) };
}

export async function recordPayoutFailure(req) {
  const payout = await DigitalMetalPayout.findOne({
    _id: req.params.payoutId,
    tenantId: req.auth.tenantId,
  });
  if (!payout) throw errors.notFound("Payout");
  if (["FAILED", "SETTLED"].includes(payout.status)) {
    return { payout: mapPayout(payout.toObject()) };
  }
  if (!["SUBMITTED", "UNKNOWN"].includes(payout.status)) {
    throw new AppError("INVALID_STATE", "Payout is not in a submitted state.", 409);
  }
  const evidence = (req.body.evidenceUploadIds ?? []).map(String);
  const reason = String(req.body.reason ?? "").trim();
  if (!reason || evidence.length === 0) {
    throw errors.validation([
      { field: "reason", message: "Documented failure reason and evidence uploads are required." },
    ]);
  }
  const saved = await withTransaction(async (session) => {
    const locked = await DigitalMetalPayout.findOne({
      _id: payout._id,
      tenantId: payout.tenantId,
      status: { $in: ["SUBMITTED", "UNKNOWN"] },
    }).session(session);
    if (!locked) throw errors.conflict("STATE_RACE", "Payout state changed.");
    locked.status = "FAILED";
    locked.failureReason = reason.slice(0, 500);
    locked.failureEvidenceUploadIds = evidence.slice(0, 10);
    appendStatusHistory(locked, "FAILED", req.auth.id, reason.slice(0, 500));
    await locked.save({ session });
    await enqueuePayoutCustomerNotice(session, {
      tenantId: locked.tenantId,
      payoutId: locked._id,
      customerId: locked.customerId,
      transition: "FAILED",
      eventAt: new Date(),
    });
    return locked.toObject();
  });
  return { payout: mapPayout(saved) };
}

export async function markPayoutUnknown(req) {
  const payout = await DigitalMetalPayout.findOne({
    _id: req.params.payoutId,
    tenantId: req.auth.tenantId,
  });
  if (!payout) throw errors.notFound("Payout");
  if (payout.status === "UNKNOWN") return { payout: mapPayout(payout.toObject()) };
  if (payout.status !== "SUBMITTED") {
    throw new AppError("INVALID_STATE", "Only submitted payouts can be marked unknown.", 409);
  }
  const saved = await withTransaction(async (session) => {
    const locked = await DigitalMetalPayout.findOne({
      _id: payout._id,
      tenantId: payout.tenantId,
      status: "SUBMITTED",
    }).session(session);
    if (!locked) throw errors.conflict("STATE_RACE", "Payout state changed.");
    locked.status = "UNKNOWN";
    locked.failureReason = String(req.body.reason ?? "Bank outcome unknown.").slice(0, 500);
    appendStatusHistory(locked, "UNKNOWN", req.auth.id, locked.failureReason);
    await locked.save({ session });
    await enqueuePayoutCustomerNotice(session, {
      tenantId: locked.tenantId,
      payoutId: locked._id,
      customerId: locked.customerId,
      transition: "UNKNOWN",
      eventAt: new Date(),
    });
    return locked.toObject();
  });
  return { payout: mapPayout(saved) };
}

export async function resolveUnknownPayout(req) {
  const payout = await DigitalMetalPayout.findOne({
    _id: req.params.payoutId,
    tenantId: req.auth.tenantId,
  });
  if (!payout) throw errors.notFound("Payout");
  if (payout.status !== "UNKNOWN") {
    throw new AppError("INVALID_STATE", "Only unknown payouts can be resolved.", 409);
  }
  if (payout.makerUserId === req.auth.id) {
    throw new AppError("APPROVAL_DENIED", "Maker cannot resolve unknown payout outcome.", 403);
  }
  const outcome = String(req.body.outcome ?? "").toUpperCase();
  const evidence = (req.body.evidenceUploadIds ?? []).map(String);
  const note = String(req.body.resolutionNote ?? "").trim();
  if (!note || evidence.length === 0) {
    throw errors.validation([
      { field: "resolutionNote", message: "Resolution note and evidence are required." },
    ]);
  }
  if (outcome === "FAILED") {
    const saved = await withTransaction(async (session) => {
      const locked = await DigitalMetalPayout.findOne({
        _id: payout._id,
        tenantId: payout.tenantId,
        status: "UNKNOWN",
      }).session(session);
      if (!locked) throw errors.conflict("STATE_RACE", "Payout state changed.");
      locked.status = "FAILED";
      locked.failureReason = note.slice(0, 500);
      locked.failureEvidenceUploadIds = evidence.slice(0, 10);
      locked.unknownResolvedAt = new Date();
      locked.unknownResolutionNote = note.slice(0, 2000);
      locked.unknownResolutionEvidenceUploadIds = evidence.slice(0, 10);
      locked.unknownResolvedByUserId = req.auth.id;
      appendStatusHistory(locked, "FAILED", req.auth.id, `Unknown resolved: ${note.slice(0, 200)}`);
      await locked.save({ session });
      await enqueuePayoutCustomerNotice(session, {
        tenantId: locked.tenantId,
        payoutId: locked._id,
        customerId: locked.customerId,
        transition: "FAILED",
        eventAt: new Date(),
      });
      return locked.toObject();
    });
    return { payout: mapPayout(saved) };
  }
  if (outcome === "SETTLED") {
    req.body.approverAttestation = req.body.approverAttestation ?? true;
    req.body.evidenceUploadIds = evidence;
    await withTransaction(async (session) => {
      const locked = await DigitalMetalPayout.findOne({
        _id: payout._id,
        tenantId: payout.tenantId,
        status: "UNKNOWN",
      }).session(session);
      if (!locked) throw errors.conflict("STATE_RACE", "Payout state changed.");
      locked.unknownResolvedAt = new Date();
      locked.unknownResolutionNote = note.slice(0, 2000);
      locked.unknownResolutionEvidenceUploadIds = evidence.slice(0, 10);
      locked.unknownResolvedByUserId = req.auth.id;
      appendStatusHistory(locked, "UNKNOWN_RESOLVED", req.auth.id, note.slice(0, 200));
      await locked.save({ session });
    });
    return recordPayoutSettlement(req);
  }
  throw errors.validation([{ field: "outcome", message: "Outcome must be FAILED or SETTLED." }]);
}

export async function recordPayoutSettlement(req) {
  const settlementKey = String(req.headers["x-idempotency-key"] ?? req.body.settlementIdempotencyKey ?? "").trim();
  if (!settlementKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const payout = await DigitalMetalPayout.findOne({
    _id: req.params.payoutId,
    tenantId: req.auth.tenantId,
  });
  if (!payout) throw errors.notFound("Payout");
  if (payout.settlementIdempotencyKey === settlementKey || payout.status === "SETTLED") {
    return { payout: mapPayout(payout.toObject()), idempotent: true };
  }
  if (!["SUBMITTED", "UNKNOWN", "APPROVED"].includes(payout.status)) {
    throw new AppError("INVALID_STATE", "Payout cannot be settled from current state.", 409);
  }
  if (payout.makerUserId === req.auth.id) {
    throw new AppError("APPROVAL_DENIED", "Maker cannot attest settlement.", 403);
  }
  const settlementDate = String(req.body.settlementDate ?? "").trim();
  const bankReference = String(req.body.bankReference ?? payout.bankReference ?? "").trim();
  const evidence = (req.body.evidenceUploadIds ?? payout.settlementEvidenceUploadIds ?? []).map(String);
  if (!settlementDate || !bankReference || evidence.length === 0) {
    throw errors.validation([
      { field: "settlement", message: "Settlement date, bank reference and evidence upload are required." },
    ]);
  }
  if (!req.body.approverAttestation) {
    throw errors.validation([
      { field: "approverAttestation", message: "Approver attestation is required for settlement." },
    ]);
  }

  const result = await withTransaction(async (session) => {
    const locked = await DigitalMetalPayout.findOne({
      _id: payout._id,
      tenantId: payout.tenantId,
      status: { $in: ["SUBMITTED", "UNKNOWN", "APPROVED"] },
    }).session(session);
    if (!locked) throw errors.conflict("STATE_RACE", "Payout state changed.");
    locked.status = "SETTLED";
    locked.settlementDate = settlementDate;
    locked.bankReference = bankReference.slice(0, 128);
    locked.settlementEvidenceUploadIds = evidence.slice(0, 10);
    locked.settlementVerification = "STAFF_ATTESTED";
    locked.settledByUserId = req.auth.id;
    locked.settledAt = new Date();
    locked.settlementIdempotencyKey = settlementKey;
    appendStatusHistory(locked, "SETTLED", req.auth.id, "Staff-attested settlement");
    await locked.save({ session });
    await enqueuePayoutCustomerNotice(session, {
      tenantId: locked.tenantId,
      payoutId: locked._id,
      customerId: locked.customerId,
      transition: "SETTLED",
      eventAt: locked.settledAt ?? new Date(),
    });

    const payable = await DigitalMetalPayable.findOne({
      _id: locked.payableId,
      tenantId: locked.tenantId,
    }).session(session);
    if (!payable) throw errors.notFound("Payable");
    const newOutstanding = Math.max(0, payable.outstandingPaise - locked.amountPaise);
    payable.outstandingPaise = newOutstanding;
    if (newOutstanding === 0) {
      payable.status = "SETTLED";
      payable.settledAt = new Date();
    }
    await payable.save({ session });
    return locked.toObject();
  });

  return { payout: mapPayout(result), idempotent: false };
}

export async function getCustomerPayoutStatusForSellOrder(req) {
  const order = await DigitalMetalSellOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Sell order");
  if (!order.payableId) return { orderId: order._id, payable: null, payouts: [] };
  const payable = await DigitalMetalPayable.findById(order.payableId).lean();
  const payouts = await DigitalMetalPayout.find({ tenantId: req.auth.tenantId, payableId: order.payableId })
    .sort({ createdAt: -1 })
    .lean();
  let bankMask = payouts[0]?.destinationSnapshot ?? null;
  if (!bankMask && order.bankDestinationId) {
    const dest = await DigitalMetalBankDestination.findOne({
      _id: order.bankDestinationId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
    }).lean();
    if (dest) {
      bankMask = {
        accountLast4: dest.accountLast4,
        ifsc: dest.ifsc,
        accountHolderName: dest.accountHolderName,
      };
    }
  }
  return {
    orderId: order._id,
    saleExecuted: order.status === "PAYABLE_OPEN",
    bankPayoutSettled: payable?.status === "SETTLED",
    payoutDestinationMasked: bankMask
      ? {
          accountLast4: bankMask.accountLast4,
          ifsc: bankMask.ifsc,
          accountHolderName: bankMask.accountHolderName,
        }
      : null,
    payable,
    payouts: payouts.map(mapPayout),
  };
}
