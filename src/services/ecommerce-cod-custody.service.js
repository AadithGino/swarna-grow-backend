import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { paginate } from "../lib/pagination.js";
import {
  EcommerceCodCollectionStatus,
  EcommerceCodCustodySettlementMethod,
  EcommerceCodCustodyStatus,
  EcommerceOrderEventType,
} from "../constants/enums.js";
import { orderUsesCod } from "../lib/ecommerce-cod.js";
import {
  EcommerceCodCustodyHandover,
  EcommerceOrder,
  EcommerceOrderEvent,
} from "../models/index.js";

function assertCodCollected(order) {
  if (!orderUsesCod(order)) throw errors.business("NOT_COD_ORDER", "Order is not COD.");
  if (order.codCollection?.status !== EcommerceCodCollectionStatus.COLLECTED) {
    throw errors.business("COD_NOT_COLLECTED", "Record COD collection before custody actions.");
  }
}

export async function getCodCustodyWorkspaceSummary(req) {
  const tenantId = req.auth.tenantId;
  const [outstandingCount, outstandingPaise, pendingHandovers, exceptions] = await Promise.all([
    EcommerceOrder.countDocuments({
      tenantId,
      "codCollection.status": EcommerceCodCollectionStatus.COLLECTED,
      "codCustody.status": {
        $in: [EcommerceCodCustodyStatus.WITH_COLLECTOR, EcommerceCodCustodyStatus.HANDOVER_PENDING],
      },
    }),
    EcommerceOrder.aggregate([
      {
        $match: {
          tenantId,
          "codCollection.status": EcommerceCodCollectionStatus.COLLECTED,
          "codCustody.status": {
            $in: [EcommerceCodCustodyStatus.WITH_COLLECTOR, EcommerceCodCustodyStatus.HANDOVER_PENDING],
          },
        },
      },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$codCollection.amountPaise", "$totalPaise"] } } } },
    ]),
    EcommerceCodCustodyHandover.countDocuments({ tenantId, status: "PENDING" }),
    EcommerceOrder.countDocuments({
      tenantId,
      "codCustody.status": EcommerceCodCustodyStatus.EXCEPTION,
    }),
  ]);
  return {
    outstandingCount,
    outstandingPaise: outstandingPaise[0]?.total ?? 0,
    pendingHandoverCount: pendingHandovers,
    exceptionCount: exceptions,
    label: "COD cash held in ecommerce custody (separate from scheme cash in hand)",
  };
}

export async function listCodCustodyOrders(req) {
  const tenantId = req.auth.tenantId;
  const status = String(req.query?.custodyStatus ?? "OUTSTANDING").toUpperCase();
  const scope = { tenantId, "codCollection.status": EcommerceCodCollectionStatus.COLLECTED };
  if (status === "SETTLED") {
    scope["codCustody.status"] = EcommerceCodCustodyStatus.SETTLED;
  } else if (status === "EXCEPTION") {
    scope["codCustody.status"] = EcommerceCodCustodyStatus.EXCEPTION;
  } else {
    scope["codCustody.status"] = {
      $in: [EcommerceCodCustodyStatus.WITH_COLLECTOR, EcommerceCodCustodyStatus.HANDOVER_PENDING],
    };
  }
  const page = await paginate(EcommerceOrder, {
    scope,
    filters: {},
    cursor: req.query?.cursor,
    limit: req.query?.limit,
    sort: "codCollection.collectedAt:desc",
  });
  return {
    items: page.data.map((row) => ({
      orderId: row._id,
      orderNumber: row.orderNumber,
      amountPaise: row.codCollection?.amountPaise ?? row.totalPaise ?? 0,
      collectedAt: row.codCollection?.collectedAt ?? null,
      holderUserId: row.codCustody?.holderUserId ?? row.codCollection?.collectorUserId ?? null,
      custodyStatus: row.codCustody?.status ?? EcommerceCodCustodyStatus.WITH_COLLECTOR,
      pendingHandoverId: row.codCustody?.pendingHandoverId ?? null,
      detailPath: `/ecommerce/orders/${row._id}`,
    })),
    meta: page.meta,
  };
}

export async function initiateCodCustodyHandover(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  const toUserId = String(req.body.toUserId ?? "").trim();
  const reference = String(req.body.reference ?? "").trim().slice(0, 160);
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }
  if (!toUserId) {
    throw errors.validation([{ field: "toUserId", message: "toUserId is required." }]);
  }
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    assertCodCollected(order.toObject());
    const custody = order.codCustody ?? {};
    if (custody.status === EcommerceCodCustodyStatus.SETTLED) {
      throw errors.business("COD_CUSTODY_SETTLED", "COD cash for this order is already settled.");
    }
    if (custody.status === EcommerceCodCustodyStatus.HANDOVER_PENDING && custody.pendingHandoverId) {
      const existing = await EcommerceCodCustodyHandover.findById(custody.pendingHandoverId).session(session).lean();
      if (existing?.idempotencyKey === idempotencyKey) {
        return { handoverId: existing._id, orderId: order._id, status: existing.status };
      }
      throw errors.business("COD_HANDOVER_PENDING", "A handover is already pending for this order.");
    }
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }
    const fromUserId = custody.holderUserId ?? order.codCollection?.collectorUserId;
    if (!fromUserId) {
      throw errors.business("COD_CUSTODY_HOLDER_UNKNOWN", "Current cash holder is unknown.");
    }
    const handoverId = createId("ecodh");
    await EcommerceCodCustodyHandover.create(
      [
        {
          _id: handoverId,
          tenantId: req.auth.tenantId,
          orderId: order._id,
          amountPaise: order.codCollection?.amountPaise ?? order.totalPaise,
          fromUserId,
          toUserId,
          status: "PENDING",
          reference,
          idempotencyKey,
        },
      ],
      { session },
    );
    const updated = await EcommerceOrder.findOneAndUpdate(
      {
        _id: order._id,
        tenantId: req.auth.tenantId,
        version: expectedVersion,
      },
      {
        $set: {
          codCustody: {
            ...custody,
            status: EcommerceCodCustodyStatus.HANDOVER_PENDING,
            holderUserId: fromUserId,
            pendingHandoverId: handoverId,
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
          type: EcommerceOrderEventType.COD_CUSTODY_HANDOVER_INITIATED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { handoverId, toUserId },
        },
      ],
      { session },
    );
    return { handoverId, orderId: order._id, status: "PENDING", version: updated.version };
  });
}

export async function acceptCodCustodyHandover(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  return withTransaction(async (session) => {
    const handover = await EcommerceCodCustodyHandover.findOne({
      _id: req.params.handoverId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!handover) throw errors.notFound("Handover");
    if (handover.idempotencyKey === idempotencyKey && handover.status === "ACCEPTED") {
      return { handoverId: handover._id, status: "ACCEPTED" };
    }
    if (handover.status !== "PENDING") {
      throw errors.business("HANDOVER_NOT_PENDING", "Handover is not pending acceptance.");
    }
    if (handover.toUserId !== req.auth.id) {
      throw errors.business(
        "HANDOVER_ASSIGNEE_MISMATCH",
        "Only the designated receiver may accept this COD handover.",
      );
    }
    const order = await EcommerceOrder.findOne({
      _id: handover.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }
    handover.status = "ACCEPTED";
    handover.settledAt = new Date();
    handover.settledByUserId = req.auth.id;
    handover.version = (handover.version ?? 1) + 1;
    await handover.save({ session });
    await EcommerceOrder.findOneAndUpdate(
      { _id: order._id },
      {
        $set: {
          "codCustody.status": EcommerceCodCustodyStatus.WITH_COLLECTOR,
          "codCustody.holderUserId": handover.toUserId,
          "codCustody.pendingHandoverId": null,
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
          type: EcommerceOrderEventType.COD_CUSTODY_HANDOVER_ACCEPTED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { handoverId: handover._id },
        },
      ],
      { session },
    );
    return { handoverId: handover._id, status: "ACCEPTED" };
  });
}

export async function recordCodBankDeposit(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  const depositReference = String(req.body.depositReference ?? "").trim().slice(0, 160);
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }
  if (depositReference.length < 4) {
    throw errors.validation([{ field: "depositReference", message: "Bank deposit reference is required." }]);
  }
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    assertCodCollected(order.toObject());
    const custody = order.codCustody ?? {};
    if (
      custody.status === EcommerceCodCustodyStatus.SETTLED
      && custody.settlementReference === depositReference
    ) {
      return { orderId: order._id, settled: true };
    }
    if (custody.status === EcommerceCodCustodyStatus.SETTLED) {
      throw errors.conflict("COD_CUSTODY_SETTLED", "COD cash for this order is already settled.");
    }
    if (custody.status === EcommerceCodCustodyStatus.HANDOVER_PENDING) {
      throw errors.business("COD_HANDOVER_PENDING", "Complete or cancel the pending handover first.");
    }
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }
    const updated = await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId: req.auth.tenantId, version: expectedVersion },
      {
        $set: {
          codCustody: {
            ...custody,
            status: EcommerceCodCustodyStatus.SETTLED,
            holderUserId: null,
            settledAt: new Date(),
            settlementMethod: EcommerceCodCustodySettlementMethod.BANK_DEPOSIT,
            settlementReference: depositReference,
            pendingHandoverId: null,
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
          type: EcommerceOrderEventType.COD_CUSTODY_BANK_DEPOSIT_RECORDED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { depositReference },
        },
      ],
      { session },
    );
    return { orderId: updated._id, version: updated.version, settled: true };
  });
}
