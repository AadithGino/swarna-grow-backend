import { createId } from "../lib/ids.js";
import { AppError, errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import {
  EcommerceFulfilmentHandoverMethod,
  EcommerceFulfilmentMode,
  EcommerceOrderEventType,
  EcommerceOrderStatus,
} from "../constants/enums.js";
import { EcommerceOrder, EcommerceOrderEvent } from "../models/index.js";
import {
  generatePickupCode,
  hashPickupCode,
  pickupCodeMatches,
  PICKUP_CODE_MAX_ATTEMPTS,
  PICKUP_CODE_TTL_MS,
} from "../lib/ecommerce-pickup-code.js";
import { seal, unseal } from "../lib/crypto.js";
import {
  staffHandoverChallengeActiveFilter,
  staffHandoverChallengeConsumeMongoUpdate,
  STAFF_HANDOVER_CHALLENGE_PURPOSE,
  verifyStaffHandoverChallenge,
} from "../lib/staff-handover-challenge.js";

function assertHandoverEligible(order) {
  const ok = new Set([
    EcommerceOrderStatus.READY_FOR_PICKUP,
    EcommerceOrderStatus.SHIPPED,
    EcommerceOrderStatus.PROCESSING,
    EcommerceOrderStatus.PAID,
  ]);
  if (!ok.has(order.status)) {
    throw errors.business("HANDOVER_INVALID_STATE", "Order is not ready for handover evidence.", {
      status: order.status,
    });
  }
}

export async function issueAdminPickupCode(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }
  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    if (order.fulfilmentMode !== EcommerceFulfilmentMode.BRANCH_PICKUP) {
      throw errors.business("NOT_PICKUP_ORDER", "Pickup codes apply to branch pickup orders only.");
    }
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }
    assertHandoverEligible(order.toObject());
    const code = generatePickupCode();
    const expiresAt = new Date(Date.now() + PICKUP_CODE_TTL_MS);
    const updated = await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId: req.auth.tenantId, version: expectedVersion },
      {
        $set: {
          "fulfilmentHandover.pickupCodeHash": hashPickupCode(code),
          "fulfilmentHandover.pickupCodeSealed": seal(code),
          "fulfilmentHandover.pickupCodeExpiresAt": expiresAt,
          "fulfilmentHandover.pickupCodeFailedAttempts": 0,
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.PICKUP_CODE_ISSUED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { expiresAt: expiresAt.toISOString() },
        },
      ],
      { session },
    );
    return {
      orderId: updated._id,
      version: updated.version,
      pickupCode: code,
      expiresAt,
      shareHint: "Share this code with the customer at pickup. It is not shown again.",
    };
  });
}

async function recordPickupHandover(order, session, { recipientName, actorType, actorId, verifiedAt }) {
  await EcommerceOrder.findOneAndUpdate(
    { _id: order._id },
    {
      $set: {
        "fulfilmentHandover.method": EcommerceFulfilmentHandoverMethod.PICKUP_CODE,
        "fulfilmentHandover.recipientName": recipientName,
        "fulfilmentHandover.recordedAt": verifiedAt,
        "fulfilmentHandover.recordedByUserId": actorId,
        "fulfilmentHandover.pickupVerifiedAt": verifiedAt,
      },
      $inc: { version: 1 },
    },
    { session },
  );
  await EcommerceOrderEvent.create(
    [
      {
        _id: createId("eoev"),
        tenantId: order.tenantId,
        orderId: order._id,
        type: EcommerceOrderEventType.FULFILMENT_HANDOVER_RECORDED,
        actorType,
        actorId,
        payload: { method: EcommerceFulfilmentHandoverMethod.PICKUP_CODE },
      },
    ],
    { session },
  );
}

export function pickupCodeAttemptCount(order) {
  return Number(order.fulfilmentHandover?.pickupCodeFailedAttempts ?? 0);
}

/** Throws business errors; caller increments attempts on PICKUP_CODE_INVALID. */
export function assertActiveCustomerPickupCode(order, code) {
  const attempts = pickupCodeAttemptCount(order);
  if (attempts >= PICKUP_CODE_MAX_ATTEMPTS) {
    throw new AppError(
      "PICKUP_ATTEMPTS_EXCEEDED",
      "Too many incorrect pickup attempts. Ask the store to reissue the pickup code.",
      429,
    );
  }
  const hash = order.fulfilmentHandover?.pickupCodeHash;
  const exp = order.fulfilmentHandover?.pickupCodeExpiresAt;
  if (!hash || !exp || new Date(exp) <= new Date()) {
    throw errors.conflict(
      "PICKUP_CODE_EXPIRED",
      "Pickup code is missing or expired. Ask the store for a new code.",
    );
  }
  if (!pickupCodeMatches(hash, code)) {
    throw errors.business("PICKUP_CODE_INVALID", "That pickup code is incorrect.");
  }
}

export function revealCustomerPickupDisplayCode(order) {
  const h = order.fulfilmentHandover ?? {};
  if (order.status !== EcommerceOrderStatus.READY_FOR_PICKUP || h.recordedAt) return null;
  if (!h.pickupCodeSealed || !h.pickupCodeExpiresAt || new Date(h.pickupCodeExpiresAt) <= new Date()) {
    return null;
  }
  try {
    return unseal(h.pickupCodeSealed);
  } catch {
    return null;
  }
}

export async function confirmCustomerPickupHandover(req) {
  const legacyStaffCode = String(req.body.staffHandoverChallengeCode ?? "").trim();
  const code = String(req.body.code ?? "").trim();
  const recipientName = String(req.body.recipientName ?? req.auth.name ?? "Customer").trim().slice(0, 120);
  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    if (order.fulfilmentHandover?.recordedAt) {
      return { orderId: order._id, alreadyRecorded: true };
    }
    if (legacyStaffCode) {
      if (!/^\d{6}$/.test(legacyStaffCode)) {
        throw errors.validation([
          { field: "staffHandoverChallengeCode", message: "Enter the 6-digit staff challenge code." },
        ]);
      }
      const binding = {
        orderId: order._id,
        customerId: order.customerId,
        branchId: order.pickupBranchId ?? null,
        purpose: STAFF_HANDOVER_CHALLENGE_PURPOSE.ECOMMERCE_PICKUP_LEGACY_CONFIRM,
      };
      verifyStaffHandoverChallenge(order.staffHandoverChallenge ?? {}, legacyStaffCode, binding);
      const filter = {
        _id: order._id,
        tenantId: req.auth.tenantId,
        ...staffHandoverChallengeActiveFilter(binding),
      };
      const challengeConsume = staffHandoverChallengeConsumeMongoUpdate(req.auth.id);
      const locked = await EcommerceOrder.findOneAndUpdate(
        filter,
        { $set: challengeConsume.$set },
        { session, new: true },
      );
      if (!locked) {
        throw errors.conflict("HANDOVER_CHALLENGE_RACE", "Staff challenge was already used or expired.", 409);
      }
      await recordPickupHandover(order, session, {
        recipientName,
        actorType: "CUSTOMER",
        actorId: req.auth.id,
        verifiedAt: new Date(),
      });
      return { orderId: order._id, recorded: true, method: "LEGACY_STAFF_CHALLENGE" };
    }
    if (!/^\d{6}$/.test(code)) {
      throw errors.validation([{ field: "code", message: "Enter the 6-digit pickup code." }]);
    }
    if (order.fulfilmentHandover?.customerPickupAcknowledgedAt) {
      return { orderId: order._id, alreadyAcknowledged: true };
    }
    try {
      assertActiveCustomerPickupCode(order, code);
    } catch (err) {
      if (err?.code === "PICKUP_CODE_INVALID") {
        await EcommerceOrder.updateOne(
          { _id: order._id, tenantId: req.auth.tenantId },
          { $inc: { "fulfilmentHandover.pickupCodeFailedAttempts": 1 } },
        );
      }
      throw err;
    }
    const acknowledgedAt = new Date();
    await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId: req.auth.tenantId },
      {
        $set: {
          "fulfilmentHandover.customerPickupAcknowledgedAt": acknowledgedAt,
          "fulfilmentHandover.customerPickupAcknowledgedByCustomerId": req.auth.id,
        },
        $inc: { version: 1 },
      },
      { session },
    );
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.PICKUP_CODE_CUSTOMER_ACKNOWLEDGED,
          actorType: "CUSTOMER",
          actorId: req.auth.id,
          payload: { note: "Customer acknowledged pickup code; staff must verify in store." },
        },
      ],
      { session },
    );
    return { orderId: order._id, acknowledged: true };
  });
}

export async function recordAdminDeliveryHandover(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  const proofReference = String(req.body.proofReference ?? "").trim().slice(0, 160);
  const recipientName = String(req.body.recipientName ?? "").trim().slice(0, 120);
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }
  if (proofReference.length < 4) {
    throw errors.validation([
      { field: "proofReference", message: "Enter delivery proof (POD reference, signed receipt id, etc.)." },
    ]);
  }
  if (recipientName.length < 2) {
    throw errors.validation([{ field: "recipientName", message: "Recipient name is required." }]);
  }
  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    if (order.fulfilmentMode !== EcommerceFulfilmentMode.DELIVERY) {
      throw errors.business("NOT_DELIVERY_ORDER", "Delivery proof applies to delivery orders only.");
    }
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }
    if (order.fulfilmentHandover?.recordedAt) {
      return { orderId: order._id, version: order.version, alreadyRecorded: true };
    }
    assertHandoverEligible(order.toObject());
    const updated = await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId: req.auth.tenantId, version: expectedVersion },
      {
        $set: {
          fulfilmentHandover: {
            method: EcommerceFulfilmentHandoverMethod.DELIVERY_PROOF,
            recipientName,
            deliveryProofReference: proofReference,
            recordedAt: new Date(),
            recordedByUserId: req.auth.id,
          },
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.FULFILMENT_HANDOVER_RECORDED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { method: EcommerceFulfilmentHandoverMethod.DELIVERY_PROOF },
        },
      ],
      { session },
    );
    return { orderId: updated._id, version: updated.version, recorded: true };
  });
}

export function assertFulfilmentHandoverBeforeDelivered(order) {
  if (order.status === EcommerceOrderStatus.DELIVERED) return;
  if (!order.fulfilmentHandover?.recordedAt) {
    throw errors.business(
      "HANDOVER_EVIDENCE_REQUIRED",
      "Record pickup verification or delivery proof before marking this order delivered.",
    );
  }
}

export function mapHandoverForDetail(order) {
  const h = order.fulfilmentHandover ?? {};
  if (!h.recordedAt && !h.pickupCodeExpiresAt) return null;
  return {
    method: h.method ?? null,
    recipientName: h.recipientName ?? null,
    recordedAt: h.recordedAt ?? null,
    deliveryProofReference: h.deliveryProofReference ?? null,
    pickupCodeActive: Boolean(
      h.pickupCodeHash && h.pickupCodeExpiresAt && new Date(h.pickupCodeExpiresAt) > new Date() && !h.recordedAt,
    ),
    pickupCodeExpiresAt: h.pickupCodeExpiresAt ?? null,
    pickupCodeFailedAttempts: h.pickupCodeFailedAttempts ?? 0,
    customerPickupAcknowledgedAt: h.customerPickupAcknowledgedAt ?? null,
  };
}
