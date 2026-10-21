import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import {
  generatePickupCode,
  hashPickupCode,
  pickupCodeMatches,
  PICKUP_CODE_MAX_ATTEMPTS,
  PICKUP_CODE_TTL_MS,
} from "../lib/ecommerce-pickup-code.js";
import { seal, unseal } from "../lib/crypto.js";
import { ensureRedemptionChargeRefundCase } from "./digital-metals-redemption-charge-refund.service.js";
import { enqueueRedemptionCustomerNotice } from "../lib/digital-metals-customer-notice.js";
import { redemptionFulfilmentTestHooks } from "../lib/digital-metals-redemption-fulfilment-test-hooks.js";

async function notifyRedemptionTransition(orderLike, transition, eventAt = new Date()) {
  await withTransaction(async (session) => {
    await enqueueRedemptionCustomerNotice(session, {
      tenantId: orderLike.tenantId,
      orderId: orderLike._id,
      customerId: orderLike.customerId,
      transition,
      eventAt,
    });
  });
}
import {
  Customer,
  DigitalMetalPhysicalOutEvent,
  DigitalMetalRedemptionOrder,
} from "../models/index.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";
import { applyAdminCustomerScopeFilter } from "../lib/digital-metals-admin-scope.js";
import { commitReservation, releaseReservation } from "./digital-metals-ledger.service.js";
import { mapAdminCustomerBrief } from "../lib/digital-metals-admin-customer-brief.js";
import { istBusinessDateFromInstant } from "../lib/digital-metals-business-calendar.js";
import { isoNow } from "../lib/date.js";
import { presentDigitalMetalsAccessState } from "../lib/digital-metals-access.js";
import { attachSubscriptionCatalogPlan } from "../lib/subscription-plan-for-tenant.js";
import { Tenant } from "../models/index.js";

const PRE_DISPATCH = new Set(["CHARGE_PAID", "FULFILMENT_ACCEPTED", "PACKING"]);
const FULFILMENT_BLOCKED = new Set(["REFUND_REVIEW", "EXPIRED", "CHARGE_PENDING", "CANCELLED", "COMPLETED"]);

function shipmentDispatchPayload(body) {
  return {
    carrier: String(body?.carrier ?? "").trim(),
    trackingReference: String(body?.trackingReference ?? "").trim(),
  };
}

function findShipmentByIdempotency(order, event, idempotencyKey) {
  return (order.shipmentHistory ?? []).find(
    (row) => row.event === event && row.idempotencyKey === idempotencyKey && row.shipmentEventId,
  );
}

function assertShipmentPayloadMatches(priorRow, body) {
  const next = shipmentDispatchPayload(body);
  const prior = {
    carrier: String(priorRow?.carrier ?? "").trim(),
    trackingReference: String(priorRow?.trackingReference ?? "").trim(),
  };
  if (prior.carrier !== next.carrier || prior.trackingReference !== next.trackingReference) {
    throw errors.conflict("IDEMPOTENCY_PAYLOAD_MISMATCH", "Shipment idempotency key reused with different payload.", {
      carrier: prior.carrier !== next.carrier,
      trackingReference: prior.trackingReference !== next.trackingReference,
    });
  }
}

function appendHistory(doc, status, actorUserId, note = "") {
  if (!doc.statusHistory) doc.statusHistory = [];
  doc.statusHistory.push({
    at: new Date(),
    status,
    actorUserId: actorUserId ?? null,
    note: String(note).slice(0, 500),
  });
}

function assertFulfilmentAllowed(order) {
  if (FULFILMENT_BLOCKED.has(order.status)) {
    throw new AppError("FULFILMENT_BLOCKED", "Charge or refund must be resolved before fulfilment.", 409);
  }
  if (order.status === "CHARGE_PAID" || order.status.startsWith("FULFIL") || order.status === "PACKING") {
    return;
  }
  if (["DISPATCHED", "PICKUP_READY", "INVESTIGATION"].includes(order.status)) return;
  throw new AppError("INVALID_STATE", "Order is not in a fulfilment state.", 409);
}

export function buildPermittedFulfilmentActions(order, auth) {
  const actions = [];
  if (!order || !auth?.id) return actions;
  if (order.status === "CHARGE_PAID") actions.push("ACCEPT_FULFILMENT", "CANCEL_PRE_DISPATCH");
  if (order.status === "FULFILMENT_ACCEPTED") actions.push("RECORD_PACKING", "RECORD_DELAY", "CANCEL_PRE_DISPATCH");
  if (order.status === "PACKING") {
    if (order.fulfilmentMode === "DELIVERY") actions.push("DISPATCH");
    else actions.push("MARK_PICKUP_READY");
    actions.push("CANCEL_PRE_DISPATCH");
  }
  if (order.status === "PICKUP_READY") {
    actions.push("ISSUE_PICKUP_CODE", "COMPLETE_PICKUP");
  }
  if (order.status === "DISPATCHED") {
    actions.push("OPEN_INVESTIGATION", "COMPLETE_DELIVERY");
  }
  if (order.status === "INVESTIGATION") {
    actions.push("RESOLVE_RETURN", "DISPATCH_REPLACEMENT", "COMPLETE_DELIVERY");
  }
  return actions;
}

function mapFulfilmentOrder(row, extras = {}) {
  const snap = row.snapshot ?? {};
  return {
    id: row._id,
    customerId: row.customerId,
    status: row.status,
    metal: row.metal,
    finenessPpm: row.finenessPpm,
    unitCount: row.unitCount,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    chargePaidAt: row.chargePaidAt ?? null,
    catalogueItemId: row.catalogueItemId ?? null,
    pickupBranchLabel: snap.pickupBranchLabel ?? null,
    fulfilmentMode: row.fulfilmentMode,
    fulfilmentBranchId: row.fulfilmentBranchId,
    pickupBranchId: row.pickupBranchId,
    deliveryAddressSnapshot: row.deliveryAddressSnapshot ?? null,
    quantityUg: String(row.quantityUg),
    chargeTotalPaise: row.chargeTotalPaise,
    leadTimeDays: row.leadTimeDays,
    delayNote: row.delayNote ?? "",
    carrier: row.carrier ?? "",
    trackingReference: row.trackingReference ?? "",
    trackingSource: row.trackingSource ?? null,
    dispatchedAt: row.dispatchedAt ?? null,
    completedAt: row.completedAt ?? null,
    pickupCodeExpiresAt: row.pickupCodeExpiresAt ?? null,
    pickupCodeAttempts: row.pickupCodeAttempts ?? 0,
    hasPickupCode: Boolean(row.pickupCodeHash),
    statusHistory: row.statusHistory ?? [],
    shipmentHistory: row.shipmentHistory ?? [],
    version: row.version ?? 1,
    ...extras,
  };
}

async function loadOrderForAdmin(req, orderId) {
  const order = await DigitalMetalRedemptionOrder.findOne({
    _id: orderId,
    tenantId: req.auth.tenantId,
  });
  if (!order) throw errors.notFound("Redemption order");
  const cust = await Customer.findOne({ _id: order.customerId, tenantId: req.auth.tenantId }).lean();
  assertTenantOwnsCustomerScope(req, cust);
  return order;
}

function assertVersion(order, expectedVersion) {
  if (expectedVersion != null && Number(order.version) !== Number(expectedVersion)) {
    throw errors.conflict("VERSION_CONFLICT", "Order was updated elsewhere.");
  }
}

export async function listAdminFulfilmentQueue(req) {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const filter = {
    tenantId: req.auth.tenantId,
    status: {
      $in: [
        "CHARGE_PAID",
        "FULFILMENT_ACCEPTED",
        "PACKING",
        "DISPATCHED",
        "PICKUP_READY",
        "INVESTIGATION",
      ],
    },
  };
  if (req.query.status) filter.status = req.query.status;
  await applyAdminCustomerScopeFilter(req, filter, { customerIdQuery: req.query.customerId });
  const items = await DigitalMetalRedemptionOrder.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();
  const customerIds = [...new Set(items.map((o) => o.customerId).filter(Boolean))];
  const customers = customerIds.length
    ? await Customer.find({ tenantId: req.auth.tenantId, _id: { $in: customerIds } }).lean()
    : [];
  const customerById = new Map(customers.map((c) => [c._id, c]));
  return {
    items: items.map((o) =>
      mapFulfilmentOrder(o, {
        permittedActions: buildPermittedFulfilmentActions(o, req.auth),
        customer: mapAdminCustomerBrief(customerById.get(o.customerId)),
      }),
    ),
  };
}

export async function getAdminFulfilmentOrder(req) {
  const order = await loadOrderForAdmin(req, req.params.orderId);
  const cust = await Customer.findOne({ _id: order.customerId, tenantId: req.auth.tenantId }).lean();
  return mapFulfilmentOrder(order.toObject(), {
    permittedActions: buildPermittedFulfilmentActions(order, req.auth),
    customer: mapAdminCustomerBrief(cust),
  });
}

export async function acceptFulfilment(req) {
  const order = await loadOrderForAdmin(req, req.params.orderId);
  assertVersion(order, req.body.expectedVersion);
  assertFulfilmentAllowed(order);
  if (order.status !== "CHARGE_PAID") throw new AppError("INVALID_STATE", "Order must be charge-paid.", 409);
  const updated = await withTransaction(async (session) => {
    const locked = await DigitalMetalRedemptionOrder.findOne({
      _id: order._id,
      tenantId: req.auth.tenantId,
      status: "CHARGE_PAID",
      version: order.version ?? 1,
    }).session(session);
    if (!locked) throw errors.conflict("STATE_RACE", "Order state changed.");
    locked.status = "FULFILMENT_ACCEPTED";
    locked.fulfilmentBranchId = req.body.fulfilmentBranchId ?? locked.pickupBranchId ?? locked.branchId;
    locked.leadTimeDays = req.body.leadTimeDays ?? locked.leadTimeDays;
    appendHistory(locked, "FULFILMENT_ACCEPTED", req.auth.id, req.body.note ?? "");
    locked.version = (locked.version ?? 1) + 1;
    await locked.save({ session });
    await enqueueRedemptionCustomerNotice(session, {
      tenantId: locked.tenantId,
      orderId: locked._id,
      customerId: locked.customerId,
      transition: "FULFILMENT_ACCEPTED",
      eventAt: new Date(),
    });
    return locked.toObject();
  });
  return mapFulfilmentOrder(updated, {
    permittedActions: buildPermittedFulfilmentActions(updated, req.auth),
  });
}

export async function recordPacking(req) {
  const order = await loadOrderForAdmin(req, req.params.orderId);
  assertVersion(order, req.body.expectedVersion);
  if (order.status !== "FULFILMENT_ACCEPTED") throw new AppError("INVALID_STATE", "Accept fulfilment first.", 409);
  order.status = "PACKING";
  appendHistory(order, "PACKING", req.auth.id);
  order.version = (order.version ?? 1) + 1;
  await order.save();
  return mapFulfilmentOrder(order.toObject(), {
    permittedActions: buildPermittedFulfilmentActions(order, req.auth),
  });
}

export async function recordProductionDelay(req) {
  const order = await loadOrderForAdmin(req, req.params.orderId);
  assertVersion(order, req.body.expectedVersion);
  if (!["FULFILMENT_ACCEPTED", "PACKING"].includes(order.status)) {
    throw new AppError("INVALID_STATE", "Delay only before dispatch.", 409);
  }
  order.delayNote = req.body.note ?? "";
  order.delayEvidenceUploadIds = (req.body.evidenceUploadIds ?? []).slice(0, 10);
  appendHistory(order, order.status, req.auth.id, `Delay: ${order.delayNote}`);
  order.version = (order.version ?? 1) + 1;
  await order.save();
  return mapFulfilmentOrder(order.toObject(), {
    permittedActions: buildPermittedFulfilmentActions(order, req.auth),
  });
}

export async function dispatchRedemptionOrder(req) {
  const order = await loadOrderForAdmin(req, req.params.orderId);
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Required." }]);
  }
  const priorShipment = findShipmentByIdempotency(order, "DISPATCHED", idempotencyKey);
  if (priorShipment?.shipmentEventId) {
    assertShipmentPayloadMatches(priorShipment, req.body);
    const fresh = await DigitalMetalRedemptionOrder.findById(order._id).lean();
    return mapFulfilmentOrder(fresh, {
      permittedActions: buildPermittedFulfilmentActions(fresh, req.auth),
      replay: true,
    });
  }
  assertVersion(order, req.body.expectedVersion);
  if (order.status !== "PACKING" || order.fulfilmentMode !== "DELIVERY") {
    throw new AppError("INVALID_STATE", "Order must be packing for delivery dispatch.", 409);
  }
  const shipmentEventId = createId("dmship");
  const dispatchedAt = new Date();
  await withTransaction(async (session) => {
    const locked = await DigitalMetalRedemptionOrder.findOne({
      _id: order._id,
      tenantId: req.auth.tenantId,
      status: "PACKING",
    }).session(session);
    if (!locked) throw errors.conflict("STATE_RACE", "Order state changed.");
    locked.status = "DISPATCHED";
    locked.carrier = req.body.carrier ?? "";
    locked.trackingReference = req.body.trackingReference ?? "";
    locked.trackingSource = "MANUAL";
    locked.dispatchEvidenceUploadIds = (req.body.evidenceUploadIds ?? []).slice(0, 10);
    locked.dispatchedAt = dispatchedAt;
    if (!locked.shipmentHistory) locked.shipmentHistory = [];
    locked.shipmentHistory.push({
      shipmentEventId,
      idempotencyKey,
      at: dispatchedAt.toISOString(),
      event: "DISPATCHED",
      carrier: locked.carrier,
      trackingReference: locked.trackingReference,
      trackingSource: "MANUAL",
    });
    appendHistory(locked, "DISPATCHED", req.auth.id);
    locked.version = (locked.version ?? 1) + 1;
    await locked.save({ session });
    await enqueueRedemptionCustomerNotice(session, {
      tenantId: locked.tenantId,
      orderId: locked._id,
      customerId: locked.customerId,
      transition: "DISPATCHED",
      eventAt: dispatchedAt,
      shipmentEventId,
    });
  });
  if (
    process.env.NODE_ENV === "test"
    && redemptionFulfilmentTestHooks.dispatchAfterCommitThrowKey === idempotencyKey
  ) {
    throw new Error("SIMULATED_DISPATCH_HTTP_CRASH");
  }
  const fresh = await DigitalMetalRedemptionOrder.findById(order._id).lean();
  return mapFulfilmentOrder(fresh, {
    permittedActions: buildPermittedFulfilmentActions(fresh, req.auth),
  });
}

export async function markPickupReady(req) {
  const order = await loadOrderForAdmin(req, req.params.orderId);
  assertVersion(order, req.body.expectedVersion);
  if (order.status !== "PACKING" || order.fulfilmentMode !== "PICKUP") {
    throw new AppError("INVALID_STATE", "Order must be packing for pickup.", 409);
  }
  order.status = "PICKUP_READY";
  order.fulfilmentBranchId = req.body.fulfilmentBranchId ?? order.fulfilmentBranchId ?? order.pickupBranchId;
  appendHistory(order, "PICKUP_READY", req.auth.id);
  order.version = (order.version ?? 1) + 1;
  await order.save();
  await notifyRedemptionTransition(order, "PICKUP_READY");
  return mapFulfilmentOrder(order.toObject(), {
    permittedActions: buildPermittedFulfilmentActions(order, req.auth),
  });
}

export async function issuePickupCode(req) {
  const order = await loadOrderForAdmin(req, req.params.orderId);
  assertVersion(order, req.body.expectedVersion);
  if (order.status !== "PICKUP_READY") throw new AppError("INVALID_STATE", "Pickup not ready.", 409);
  const code = generatePickupCode();
  order.pickupCodeHash = hashPickupCode(code);
  order.pickupCodeSealed = seal(code);
  order.pickupCodeExpiresAt = new Date(Date.now() + PICKUP_CODE_TTL_MS);
  order.pickupCodeAttempts = 0;
  appendHistory(order, "PICKUP_READY", req.auth.id, "Pickup code reissued");
  order.version = (order.version ?? 1) + 1;
  await order.save();
  return {
    order: mapFulfilmentOrder(order.toObject(), {
      permittedActions: buildPermittedFulfilmentActions(order, req.auth),
    }),
    pickupCodeIssued: true,
    expiresAt: order.pickupCodeExpiresAt,
  };
}

async function replayIfPhysicalOutCommitted(req, orderId) {
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) return null;
  const existing = await DigitalMetalPhysicalOutEvent.findOne({
    tenantId: req.auth.tenantId,
    idempotencyKey,
  }).lean();
  if (!existing || existing.redemptionOrderId !== orderId) return null;
  const fresh = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  return mapFulfilmentOrder(fresh, { physicalOutEventId: existing._id, replay: true });
}

export async function completePickupHandover(req) {
  const replay = await replayIfPhysicalOutCommitted(req, req.params.orderId);
  if (replay) return replay;
  const order = await loadOrderForAdmin(req, req.params.orderId);
  assertVersion(order, req.body.expectedVersion);
  if (order.status !== "PICKUP_READY") throw new AppError("INVALID_STATE", "Not ready for pickup.", 409);
  const branchId = req.body.fulfilmentBranchId ?? order.fulfilmentBranchId ?? order.pickupBranchId;
  if (String(branchId) !== String(order.fulfilmentBranchId ?? order.pickupBranchId)) {
    throw new AppError("WRONG_BRANCH", "Handover at wrong branch.", 403);
  }
  const maxAttempts = order.pickupCodeMaxAttempts ?? PICKUP_CODE_MAX_ATTEMPTS;
  if ((order.pickupCodeAttempts ?? 0) >= maxAttempts) {
    throw new AppError("PICKUP_CODE_LOCKED", "Too many invalid attempts. Reissue the code.", 403);
  }
  const code = String(req.body.pickupCode ?? "").trim();
  if (!order.pickupCodeHash || !pickupCodeMatches(order.pickupCodeHash, code)) {
    order.pickupCodeAttempts = (order.pickupCodeAttempts ?? 0) + 1;
    await order.save();
    throw new AppError("PICKUP_CODE_INVALID", "Invalid pickup code.", 403);
  }
  if (order.pickupCodeExpiresAt && new Date(order.pickupCodeExpiresAt).getTime() < Date.now()) {
    throw new AppError("PICKUP_CODE_EXPIRED", "Pickup code expired.", 409);
  }
  return finalizePhysicalHandover(req, order, "PICKUP");
}

export async function completeDeliveryHandover(req) {
  const replay = await replayIfPhysicalOutCommitted(req, req.params.orderId);
  if (replay) return replay;
  const order = await loadOrderForAdmin(req, req.params.orderId);
  assertVersion(order, req.body.expectedVersion);
  if (!["DISPATCHED", "INVESTIGATION"].includes(order.status)) {
    throw new AppError("INVALID_STATE", "Delivery completion not allowed.", 409);
  }
  if (req.body.approverAttestation !== true) {
    throw errors.validation([{ field: "approverAttestation", message: "Attestation required." }]);
  }
  order.completionAttestation = true;
  order.completionEvidenceUploadIds = (req.body.evidenceUploadIds ?? []).slice(0, 10);
  return finalizePhysicalHandover(req, order, "DELIVERY");
}

async function finalizePhysicalHandover(req, orderDoc, mode) {
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Required." }]);
  }
  const existing = await DigitalMetalPhysicalOutEvent.findOne({
    tenantId: req.auth.tenantId,
    idempotencyKey,
  }).lean();
  if (existing) {
    const fresh = await DigitalMetalRedemptionOrder.findById(orderDoc._id).lean();
    return mapFulfilmentOrder(fresh, { physicalOutEventId: existing._id, replay: true });
  }

  const businessDate = istBusinessDateFromInstant(new Date(isoNow()));
  const reserveKey = `${orderDoc.idempotencyKey}:reserve`;
  const commitKey = `handover:${orderDoc._id}:${idempotencyKey}`;

  await withTransaction(async (session) => {
    const locked = await DigitalMetalRedemptionOrder.findOne({
      _id: orderDoc._id,
      tenantId: req.auth.tenantId,
      status: orderDoc.status,
    }).session(session);
    if (!locked) throw errors.conflict("STATE_RACE", "Order state changed.");
    await commitReservation(session, locked.tenantId, reserveKey, commitKey);
    const eventId = createId("dmphy");
    await DigitalMetalPhysicalOutEvent.create(
      [
        {
          _id: eventId,
          tenantId: locked.tenantId,
          redemptionOrderId: locked._id,
          customerId: locked.customerId,
          metal: locked.metal,
          finenessPpm: locked.finenessPpm,
          quantityUg: locked.quantityUg,
          reservationId: locked.reservationId,
          businessDate,
          fulfilmentMode: mode,
          idempotencyKey,
        },
      ],
      { session },
    );
    locked.status = "COMPLETED";
    locked.completedAt = new Date();
    locked.physicalOutEventId = eventId;
    locked.pickupCodeHash = null;
    locked.pickupCodeSealed = null;
    appendHistory(locked, "COMPLETED", req.auth.id, mode);
    locked.version = (locked.version ?? 1) + 1;
    await locked.save({ session });
    await enqueueRedemptionCustomerNotice(session, {
      tenantId: locked.tenantId,
      orderId: locked._id,
      customerId: locked.customerId,
      transition: "COMPLETED",
      eventAt: locked.completedAt ?? new Date(),
    });
  });

  const fresh = await DigitalMetalRedemptionOrder.findById(orderDoc._id).lean();
  return mapFulfilmentOrder(fresh, {
    permittedActions: [],
    physicalOutEventId: fresh.physicalOutEventId,
  });
}

export async function cancelPreDispatch(req) {
  const order = await loadOrderForAdmin(req, req.params.orderId);
  assertVersion(order, req.body.expectedVersion);
  if (!PRE_DISPATCH.has(order.status)) {
    throw new AppError("INVALID_STATE", "Cannot cancel after dispatch.", 409);
  }
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Required." }]);
  }
  await withTransaction(async (session) => {
    const locked = await DigitalMetalRedemptionOrder.findOne({
      _id: order._id,
      tenantId: req.auth.tenantId,
      status: order.status,
    }).session(session);
    if (!locked) throw errors.conflict("STATE_RACE", "Order changed.");
    const reserveKey = `${locked.idempotencyKey}:reserve`;
    await releaseReservation(session, locked.tenantId, reserveKey, `cancel:${idempotencyKey}`);
    locked.status = "CANCELLED";
    appendHistory(locked, "CANCELLED", req.auth.id, req.body.reason ?? "Pre-dispatch cancel");
    locked.version = (locked.version ?? 1) + 1;
    await locked.save({ session });
    if (Number(locked.chargeTotalPaise) > 0 && locked.successfulChargeAttemptId) {
      await ensureRedemptionChargeRefundCase(session, {
        tenantId: locked.tenantId,
        order: locked,
        paymentAttemptId: locked.successfulChargeAttemptId,
        merchantOrderId: locked.successfulChargeAttemptId,
        amountPaise: locked.chargeTotalPaise,
        exceptionType: "PRE_DISPATCH_CANCEL",
      });
    }
    await enqueueRedemptionCustomerNotice(session, {
      tenantId: locked.tenantId,
      orderId: locked._id,
      customerId: locked.customerId,
      transition: "CANCELLED",
      eventAt: new Date(),
    });
  });
  const fresh = await DigitalMetalRedemptionOrder.findById(order._id).lean();
  return mapFulfilmentOrder(fresh);
}

export async function openInvestigation(req) {
  const order = await loadOrderForAdmin(req, req.params.orderId);
  assertVersion(order, req.body.expectedVersion);
  if (order.status !== "DISPATCHED") throw new AppError("INVALID_STATE", "Must be dispatched.", 409);
  order.status = "INVESTIGATION";
  order.investigationReason = req.body.reason ?? "";
  appendHistory(order, "INVESTIGATION", req.auth.id, order.investigationReason);
  order.version = (order.version ?? 1) + 1;
  await order.save();
  return mapFulfilmentOrder(order.toObject(), {
    permittedActions: buildPermittedFulfilmentActions(order, req.auth),
  });
}

export async function customerRevealPickupCode(req) {
  const order = await DigitalMetalRedemptionOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
    status: "PICKUP_READY",
  }).lean();
  if (!order) throw errors.notFound("Order");
  if (!order.pickupCodeHash || !order.pickupCodeSealed) {
    throw new AppError("PICKUP_CODE_NOT_ISSUED", "Pickup code not issued yet.", 409);
  }
  if (order.pickupCodeExpiresAt && new Date(order.pickupCodeExpiresAt).getTime() < Date.now()) {
    throw new AppError("PICKUP_CODE_EXPIRED", "Ask the store to reissue your code.", 409);
  }
  return {
    orderId: order._id,
    fulfilmentBranchId: order.fulfilmentBranchId ?? order.pickupBranchId,
    expiresAt: order.pickupCodeExpiresAt,
    pickupCode: unseal(order.pickupCodeSealed),
  };
}

export async function resolveVerifiedReturn(req) {
  const order = await loadOrderForAdmin(req, req.params.orderId);
  assertVersion(order, req.body.expectedVersion);
  if (order.status !== "INVESTIGATION") {
    throw new AppError("INVALID_STATE", "Return resolution only during investigation.", 409);
  }
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Required." }]);
  }
  await withTransaction(async (session) => {
    const locked = await DigitalMetalRedemptionOrder.findOne({
      _id: order._id,
      tenantId: req.auth.tenantId,
      status: "INVESTIGATION",
    }).session(session);
    if (!locked) throw errors.conflict("STATE_RACE", "Order changed.");
    const reserveKey = `${locked.idempotencyKey}:reserve`;
    await releaseReservation(session, locked.tenantId, reserveKey, `return:${idempotencyKey}`);
    locked.status = "CANCELLED";
    appendHistory(locked, "CANCELLED", req.auth.id, `Verified return: ${req.body.reason ?? ""}`);
    locked.version = (locked.version ?? 1) + 1;
    await locked.save({ session });
  });
  const fresh = await DigitalMetalRedemptionOrder.findById(order._id).lean();
  return mapFulfilmentOrder(fresh);
}

export async function dispatchReplacementShipment(req) {
  const order = await loadOrderForAdmin(req, req.params.orderId);
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Required." }]);
  }
  const priorReplacement = findShipmentByIdempotency(order, "REPLACEMENT_DISPATCHED", idempotencyKey);
  if (priorReplacement?.shipmentEventId) {
    assertShipmentPayloadMatches(priorReplacement, req.body);
    const fresh = await DigitalMetalRedemptionOrder.findById(order._id).lean();
    return mapFulfilmentOrder(fresh, {
      permittedActions: buildPermittedFulfilmentActions(fresh, req.auth),
      replay: true,
    });
  }
  assertVersion(order, req.body.expectedVersion);
  if (order.status !== "INVESTIGATION" || order.fulfilmentMode !== "DELIVERY") {
    throw new AppError("INVALID_STATE", "Replacement dispatch only for delivery under investigation.", 409);
  }
  const shipmentEventId = createId("dmship");
  const dispatchedAt = new Date();
  await withTransaction(async (session) => {
    const locked = await DigitalMetalRedemptionOrder.findOne({
      _id: order._id,
      tenantId: req.auth.tenantId,
      status: "INVESTIGATION",
    }).session(session);
    if (!locked) throw errors.conflict("STATE_RACE", "Order state changed.");
    locked.status = "DISPATCHED";
    locked.carrier = req.body.carrier ?? locked.carrier;
    locked.trackingReference = req.body.trackingReference ?? "";
    locked.trackingSource = "MANUAL";
    locked.dispatchedAt = dispatchedAt;
    if (!locked.shipmentHistory) locked.shipmentHistory = [];
    locked.shipmentHistory.push({
      shipmentEventId,
      idempotencyKey,
      at: dispatchedAt.toISOString(),
      event: "REPLACEMENT_DISPATCHED",
      carrier: locked.carrier,
      trackingReference: locked.trackingReference,
      trackingSource: "MANUAL",
      linkedOrderId: locked._id,
    });
    appendHistory(locked, "DISPATCHED", req.auth.id, "Replacement shipment");
    locked.version = (locked.version ?? 1) + 1;
    await locked.save({ session });
    await enqueueRedemptionCustomerNotice(session, {
      tenantId: locked.tenantId,
      orderId: locked._id,
      customerId: locked.customerId,
      transition: "REPLACEMENT_DISPATCHED",
      eventAt: dispatchedAt,
      shipmentEventId,
    });
  });
  if (
    process.env.NODE_ENV === "test"
    && redemptionFulfilmentTestHooks.replacementDispatchAfterCommitThrowKey === idempotencyKey
  ) {
    throw new Error("SIMULATED_REPLACEMENT_DISPATCH_HTTP_CRASH");
  }
  const fresh = await DigitalMetalRedemptionOrder.findById(order._id).lean();
  return mapFulfilmentOrder(fresh, {
    permittedActions: buildPermittedFulfilmentActions(fresh, req.auth),
  });
}

export async function getCustomerFulfilmentProgress(req) {
  const order = await DigitalMetalRedemptionOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const tenant = await attachSubscriptionCatalogPlan(await Tenant.findById(req.auth.tenantId).lean());
  const access = presentDigitalMetalsAccessState(tenant);
  return {
    ...mapFulfilmentOrder(order),
    cancellationEligible: PRE_DISPATCH.has(order.status),
    tradingPaused: access.paused,
    canViewProgress: true,
  };
}
