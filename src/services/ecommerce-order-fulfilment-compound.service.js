import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { assertEcommerceOrderTransition } from "../lib/ecommerce-order-transitions.js";
import {
  EcommerceCourierCodCollectionSource,
  EcommerceFulfilmentHandoverMethod,
  EcommerceFulfilmentMode,
  EcommerceOrderEventType,
  EcommerceOrderStatus,
} from "../constants/enums.js";
import { orderUsesCod } from "../lib/ecommerce-cod.js";
import { hashIdempotencyBody } from "./idempotency.service.js";
import { buildManualCourierCodCollectionSet } from "./ecommerce-courier-cod.service.js";
import { Customer, EcommerceFulfilmentSettings, EcommerceOrder, EcommerceOrderEvent } from "../models/index.js";
import {
  ECOMMERCE_OUTBOX_TOPICS,
  enqueueEcommerceOutboxEvent,
} from "../lib/ecommerce-commerce-outbox.js";
import {
  assertBranchScopeForMutation,
  requireExpectedVersion,
} from "../lib/mutation-requirements.js";
import {
  createStaffHandoverChallenge,
  STAFF_HANDOVER_CHALLENGE_PURPOSE,
} from "../lib/staff-handover-challenge.js";
import {
  generatePickupCode,
  hashPickupCode,
  PICKUP_CODE_TTL_MS,
} from "../lib/ecommerce-pickup-code.js";
import { seal } from "../lib/crypto.js";
import { assertActiveCustomerPickupCode } from "./ecommerce-order-handover.service.js";

const TRACKING_URL_RE = /^https:\/\/[^\s]+$/i;

const BLOCKED_FOR_FULFILMENT = new Set([
  EcommerceOrderStatus.PENDING_PAYMENT,
  EcommerceOrderStatus.PAYMENT_EXPIRED,
  EcommerceOrderStatus.PAYMENT_FAILED,
  EcommerceOrderStatus.COD_PENDING_ACCEPTANCE,
]);

function assertFulfilmentSnapshot(order, targetStatus) {
  if (order.fulfilmentMode === EcommerceFulfilmentMode.BRANCH_PICKUP) {
    if (!order.pickupBranchId) {
      throw errors.business("FULFILMENT_INVALID", "Pickup branch is missing on the order.");
    }
  }
  if (order.fulfilmentMode === EcommerceFulfilmentMode.DELIVERY) {
    const pin = order.addressSnapshot?.pincode ?? order.addressSnapshot?.postalCode;
    if (!pin) {
      throw errors.business("FULFILMENT_INVALID", "Delivery address snapshot is incomplete.");
    }
  }
  if (
    targetStatus === EcommerceOrderStatus.READY_FOR_PICKUP
    && order.fulfilmentMode !== EcommerceFulfilmentMode.BRANCH_PICKUP
  ) {
    throw errors.business("FULFILMENT_INVALID", "Ready for pickup applies to branch pickup orders only.");
  }
  if (
    targetStatus === EcommerceOrderStatus.SHIPPED
    && order.fulfilmentMode !== EcommerceFulfilmentMode.DELIVERY
  ) {
    throw errors.business("FULFILMENT_INVALID", "Shipped applies to delivery orders only.");
  }
}

async function resolveBranchScopeIds(order) {
  let customerBranchId = null;
  if (order.customerId) {
    const cust = await Customer.findOne({ _id: order.customerId, tenantId: order.tenantId })
      .select("branchId")
      .lean();
    customerBranchId = cust?.branchId ?? null;
  }
  const resourceBranchId =
    order.fulfilmentMode === EcommerceFulfilmentMode.BRANCH_PICKUP
      ? order.pickupBranchId ?? customerBranchId
      : customerBranchId;
  return { resourceBranchId, customerBranchId };
}

function assertOrderOpenForFulfilment(order) {
  if (order.paymentExceptionStatus) {
    throw errors.business("FULFILMENT_BLOCKED", "Orders with payment exceptions cannot be fulfilled.");
  }
  if (order.activeCancellationRequestId) {
    throw errors.business(
      "FULFILMENT_BLOCKED",
      "Resolve the open cancellation request before updating fulfilment.",
    );
  }
  if (BLOCKED_FOR_FULFILMENT.has(order.status)) {
    throw errors.business("FULFILMENT_BLOCKED", "Order is not paid.", { status: order.status });
  }
}

async function enqueueFulfilmentMilestone(session, tenantId, order, targetStatus) {
  await enqueueEcommerceOutboxEvent({
    tenantId,
    topic: ECOMMERCE_OUTBOX_TOPICS.FULFILMENT_MILESTONE,
    key: `${order._id}:${targetStatus}`,
    payload: {
      orderId: order._id,
      status: targetStatus,
      fulfilmentMode: order.fulfilmentMode,
    },
    session,
  });
}

async function appendFulfilmentEvent(session, { tenantId, orderId, actorId, payload }) {
  await EcommerceOrderEvent.create(
    [
      {
        _id: createId("eoev"),
        tenantId,
        orderId,
        type: EcommerceOrderEventType.FULFILMENT_UPDATED,
        actorType: "STAFF",
        actorId,
        payload,
      },
    ],
    { session },
  );
}

const SHIP_FROM = new Set([EcommerceOrderStatus.PAID, EcommerceOrderStatus.PROCESSING]);

/** Paid/Processing → Shipped with courier tracking in one transaction. */
export async function shipAdminOrder(req) {
  const expectedVersion = requireExpectedVersion(req.body);
  const carrierName = String(req.body.carrierName ?? "").trim().slice(0, 120);
  const trackingNumber = String(req.body.trackingNumber ?? "").trim().slice(0, 80);
  const trackingUrl = String(req.body.trackingUrl ?? "").trim().slice(0, 500);
  if (trackingUrl && !TRACKING_URL_RE.test(trackingUrl)) {
    throw errors.validation([{ field: "trackingUrl", message: "Tracking URL must be https." }]);
  }
  const dispatchedAt = req.body.dispatchedAt ? new Date(req.body.dispatchedAt) : new Date();

  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    assertOrderOpenForFulfilment(order);
    if (!SHIP_FROM.has(order.status)) {
      throw errors.business("FULFILMENT_BLOCKED", "Order is not ready to ship.", { status: order.status });
    }
    const scope = await resolveBranchScopeIds(order.toObject());
    assertBranchScopeForMutation(req, scope);
    assertFulfilmentSnapshot(order.toObject(), EcommerceOrderStatus.SHIPPED);
    assertEcommerceOrderTransition("STAFF", order.status, EcommerceOrderStatus.SHIPPED);
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }

    const settings = await EcommerceFulfilmentSettings.findOne({ tenantId: req.auth.tenantId })
      .session(session)
      .lean();
    if (settings?.requireCourierTrackingForShipped) {
      const hasTracking = Boolean(trackingNumber || carrierName);
      if (!hasTracking) {
        throw errors.business(
          "DELIVERY_TRACKING_REQUIRED",
          "Enter courier or tracking details before shipping, or disable the requirement in fulfilment settings.",
        );
      }
    }

    const updated = await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId: req.auth.tenantId, version: expectedVersion },
      {
        $set: {
          status: EcommerceOrderStatus.SHIPPED,
          deliveryTracking: {
            carrierName,
            trackingNumber,
            trackingUrl,
            dispatchedAt,
            deliveredAt: order.deliveryTracking?.deliveredAt ?? null,
          },
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");

    await appendFulfilmentEvent(session, {
      tenantId: req.auth.tenantId,
      orderId: order._id,
      actorId: req.auth.id,
      payload: { from: order.status, to: EcommerceOrderStatus.SHIPPED, deliveryTrackingUpdated: true },
    });
    await enqueueFulfilmentMilestone(session, req.auth.tenantId, order.toObject(), EcommerceOrderStatus.SHIPPED);
    return updated.toObject();
  });
}

/** Shipped → Delivered with delivery proof in one transaction. */
export async function confirmAdminOrderDelivery(req) {
  const expectedVersion = requireExpectedVersion(req.body);
  const proofReference = String(req.body.proofReference ?? "").trim().slice(0, 160);
  const recipientName = String(req.body.recipientName ?? "").trim().slice(0, 120);
  const courierCollectionReference = String(req.body.courierCollectionReference ?? "").trim();
  const courierCollectionEvidenceNote = String(req.body.courierCollectionEvidenceNote ?? "").trim();
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
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
    assertOrderOpenForFulfilment(order);
    if (order.status !== EcommerceOrderStatus.SHIPPED) {
      throw errors.business("FULFILMENT_BLOCKED", "Confirm delivery only after the order is shipped.", {
        status: order.status,
      });
    }
    if (order.fulfilmentMode !== EcommerceFulfilmentMode.DELIVERY) {
      throw errors.business("NOT_DELIVERY_ORDER", "Delivery confirmation applies to delivery orders only.");
    }
    const scope = await resolveBranchScopeIds(order.toObject());
    assertBranchScopeForMutation(req, scope);
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }
    if (order.fulfilmentHandover?.recordedAt) {
      throw errors.conflict("HANDOVER_ALREADY_RECORDED", "Delivery proof was already recorded.");
    }
    assertEcommerceOrderTransition("STAFF", order.status, EcommerceOrderStatus.DELIVERED);

    const cod = orderUsesCod(order.toObject());
    if (courierCollectionReference && !cod) {
      throw errors.validation([
        {
          field: "courierCollectionReference",
          message: "Courier collection confirmation applies to cash-on-delivery orders only.",
        },
      ]);
    }
    let courierCollectionSet = null;
    if (cod && courierCollectionReference) {
      if (!idempotencyKey) {
        throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
      }
      const bodyHash = hashIdempotencyBody({
        expectedVersion,
        proofReference,
        recipientName,
        courierCollectionReference,
        courierCollectionEvidenceNote,
      });
      courierCollectionSet = buildManualCourierCodCollectionSet(order, req, {
        reference: courierCollectionReference,
        evidenceNote: courierCollectionEvidenceNote,
        idempotencyKey,
        bodyHash,
      });
    }

    const now = new Date();
    const updated = await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId: req.auth.tenantId, version: expectedVersion },
      {
        $set: {
          status: EcommerceOrderStatus.DELIVERED,
          fulfilmentHandover: {
            method: EcommerceFulfilmentHandoverMethod.DELIVERY_PROOF,
            recipientName,
            deliveryProofReference: proofReference,
            recordedAt: now,
            recordedByUserId: req.auth.id,
          },
          "deliveryTracking.deliveredAt": now,
          ...(courierCollectionSet ?? {}),
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");

    const events = [
      {
        _id: createId("eoev"),
        tenantId: req.auth.tenantId,
        orderId: order._id,
        type: EcommerceOrderEventType.FULFILMENT_HANDOVER_RECORDED,
        actorType: "STAFF",
        actorId: req.auth.id,
        payload: { method: EcommerceFulfilmentHandoverMethod.DELIVERY_PROOF },
      },
    ];
    if (courierCollectionSet) {
      events.push({
        _id: createId("eoev"),
        tenantId: req.auth.tenantId,
        orderId: order._id,
        type: EcommerceOrderEventType.COURIER_COD_COLLECTION_CONFIRMED,
        actorType: "STAFF",
        actorId: req.auth.id,
        payload: {
          reference: courierCollectionReference,
          providerId: "MANUAL",
          trackingReference: null,
          source: EcommerceCourierCodCollectionSource.MANUAL_OPERATOR,
          expectedAmountPaise: courierCollectionSet.courierCod.expectedAmountPaise,
          withDeliveryConfirmation: true,
        },
      });
    }
    await EcommerceOrderEvent.create(events, { session, ordered: true });
    await appendFulfilmentEvent(session, {
      tenantId: req.auth.tenantId,
      orderId: order._id,
      actorId: req.auth.id,
      payload: { from: EcommerceOrderStatus.SHIPPED, to: EcommerceOrderStatus.DELIVERED },
    });
    await enqueueFulfilmentMilestone(session, req.auth.tenantId, order.toObject(), EcommerceOrderStatus.DELIVERED);
    return updated.toObject();
  });
}

const READY_FROM = new Set([EcommerceOrderStatus.PAID, EcommerceOrderStatus.PROCESSING]);

/** Paid/Processing → Ready for pickup; issues customer reveal code + staff handover challenge. */
export async function markAdminOrderReadyForPickup(req) {
  const expectedVersion = requireExpectedVersion(req.body);

  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    assertOrderOpenForFulfilment(order);
    if (!READY_FROM.has(order.status)) {
      throw errors.business("FULFILMENT_BLOCKED", "Order is not ready for pickup preparation.", {
        status: order.status,
      });
    }
    if (order.fulfilmentMode !== EcommerceFulfilmentMode.BRANCH_PICKUP) {
      throw errors.business("NOT_PICKUP_ORDER", "Ready for pickup applies to branch pickup orders only.");
    }
    const scope = await resolveBranchScopeIds(order.toObject());
    assertBranchScopeForMutation(req, scope);
    assertFulfilmentSnapshot(order.toObject(), EcommerceOrderStatus.READY_FOR_PICKUP);
    assertEcommerceOrderTransition("STAFF", order.status, EcommerceOrderStatus.READY_FOR_PICKUP);
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }

    const customerCode = generatePickupCode();
    const pickupExpiresAt = new Date(Date.now() + PICKUP_CODE_TTL_MS);
    const challengeBinding = {
      orderId: order._id,
      customerId: order.customerId,
      branchId: order.pickupBranchId ?? scope.resourceBranchId,
      purpose: STAFF_HANDOVER_CHALLENGE_PURPOSE.ECOMMERCE_PICKUP_LEGACY_CONFIRM,
    };
    const staffChallenge = createStaffHandoverChallenge(challengeBinding);

    const updated = await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId: req.auth.tenantId, version: expectedVersion },
      {
        $set: {
          status: EcommerceOrderStatus.READY_FOR_PICKUP,
          "fulfilmentHandover.pickupCodeHash": hashPickupCode(customerCode),
          "fulfilmentHandover.pickupCodeSealed": seal(customerCode),
          "fulfilmentHandover.pickupCodeExpiresAt": pickupExpiresAt,
          "fulfilmentHandover.pickupCodeFailedAttempts": 0,
          staffHandoverChallenge: {
            orderId: challengeBinding.orderId,
            customerId: challengeBinding.customerId,
            branchId: challengeBinding.branchId,
            purpose: challengeBinding.purpose,
            challengeHash: staffChallenge.challengeHash,
            challengeSealed: staffChallenge.challengeSealed,
            expiresAt: staffChallenge.expiresAt,
            consumedAt: null,
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
          type: EcommerceOrderEventType.PICKUP_CODE_ISSUED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { expiresAt: pickupExpiresAt.toISOString(), autoIssued: true },
        },
      ],
      { session },
    );
    await appendFulfilmentEvent(session, {
      tenantId: req.auth.tenantId,
      orderId: order._id,
      actorId: req.auth.id,
      payload: { from: order.status, to: EcommerceOrderStatus.READY_FOR_PICKUP },
    });
    await enqueueFulfilmentMilestone(
      session,
      req.auth.tenantId,
      order.toObject(),
      EcommerceOrderStatus.READY_FOR_PICKUP,
    );

    const payload = {
      order: updated.toObject(),
      customerPickupCodeExpiresAt: pickupExpiresAt,
      legacyStaffHandoverChallengeExpiresAt: staffChallenge.expiresAt,
    };
    if (process.env.NODE_ENV === "test") {
      payload.customerPickupCode = customerCode;
    }
    return payload;
  });
}

/** Ready for pickup → Collected (DELIVERED) with customer pickup code + staff attestation. */
export async function confirmAdminPickupCollection(req) {
  const expectedVersion = requireExpectedVersion(req.body);
  if (req.body.staffHandoverConfirmed !== true) {
    throw errors.validation([
      { field: "staffHandoverConfirmed", message: "Confirm that the customer collected the order in person." },
    ]);
  }
  const pickupCode = String(req.body.pickupCode ?? "").trim();
  const recipientName = String(req.body.recipientName ?? "").trim().slice(0, 120);
  if (!/^\d{6}$/.test(pickupCode)) {
    throw errors.validation([{ field: "pickupCode", message: "Enter the 6-digit pickup code from the customer." }]);
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
    if (order.status === EcommerceOrderStatus.DELIVERED) {
      return { ...order.toObject(), alreadyCollected: true };
    }
    assertOrderOpenForFulfilment(order);
    if (order.status !== EcommerceOrderStatus.READY_FOR_PICKUP) {
      throw errors.business("FULFILMENT_BLOCKED", "Order is not ready for collection.", { status: order.status });
    }
    if (order.fulfilmentMode !== EcommerceFulfilmentMode.BRANCH_PICKUP) {
      throw errors.business("NOT_PICKUP_ORDER", "Pickup collection applies to branch pickup orders only.");
    }
    const scope = await resolveBranchScopeIds(order.toObject());
    assertBranchScopeForMutation(req, scope);
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }
    if (order.fulfilmentHandover?.recordedAt) {
      return { ...order.toObject(), alreadyCollected: true };
    }

    try {
      assertActiveCustomerPickupCode(order, pickupCode);
    } catch (err) {
      if (err?.code === "PICKUP_CODE_INVALID") {
        await EcommerceOrder.updateOne(
          { _id: order._id, tenantId: req.auth.tenantId },
          { $inc: { "fulfilmentHandover.pickupCodeFailedAttempts": 1 } },
        );
      }
      throw err;
    }

    const now = new Date();
    const updated = await EcommerceOrder.findOneAndUpdate(
      {
        _id: order._id,
        tenantId: req.auth.tenantId,
        version: expectedVersion,
        status: EcommerceOrderStatus.READY_FOR_PICKUP,
        "fulfilmentHandover.recordedAt": null,
      },
      {
        $set: {
          status: EcommerceOrderStatus.DELIVERED,
          "fulfilmentHandover.method": EcommerceFulfilmentHandoverMethod.PICKUP_CODE,
          "fulfilmentHandover.recipientName": recipientName,
          "fulfilmentHandover.recordedAt": now,
          "fulfilmentHandover.recordedByUserId": req.auth.id,
          "fulfilmentHandover.pickupVerifiedAt": now,
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) {
      const latest = await EcommerceOrder.findOne({ _id: order._id, tenantId: req.auth.tenantId }).session(session);
      if (latest?.status === EcommerceOrderStatus.DELIVERED) {
        return { ...latest.toObject(), alreadyCollected: true };
      }
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }

    await EcommerceOrderEvent.create(
      [
        {
          _id: createId("eoev"),
          tenantId: req.auth.tenantId,
          orderId: order._id,
          type: EcommerceOrderEventType.FULFILMENT_HANDOVER_RECORDED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { method: EcommerceFulfilmentHandoverMethod.PICKUP_CODE },
        },
      ],
      { session },
    );
    await appendFulfilmentEvent(session, {
      tenantId: req.auth.tenantId,
      orderId: order._id,
      actorId: req.auth.id,
      payload: { from: EcommerceOrderStatus.READY_FOR_PICKUP, to: EcommerceOrderStatus.DELIVERED },
    });
    await enqueueFulfilmentMilestone(session, req.auth.tenantId, order.toObject(), EcommerceOrderStatus.DELIVERED);
    return updated.toObject();
  });
}

/** Staff-only reveal of Option A handover challenge (not the customer pickup display code). */
export async function revealAdminStaffHandoverChallenge(req) {
  const order = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const scope = await resolveBranchScopeIds(order);
  assertBranchScopeForMutation(req, scope);
  const { revealStaffHandoverChallengeForStaff } = await import("../lib/staff-handover-challenge.js");
  const revealed = revealStaffHandoverChallengeForStaff(order.staffHandoverChallenge ?? {});
  return {
    orderId: order._id,
    challengeCode: revealed.challengeCode,
    expiresAt: revealed.expiresAt,
    purpose: revealed.purpose,
  };
}
