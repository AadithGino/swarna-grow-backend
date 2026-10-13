import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { orderUsesCod } from "../lib/ecommerce-cod.js";
import {
  assertRemittanceLineAmounts,
  initialCourierCodForOrder,
  isCourierCodCollectionConfirmed,
  matchRemittanceTotals,
  resolveCodCollectionAmountPaise,
} from "../lib/ecommerce-courier-cod.js";
import { hashIdempotencyBody } from "./idempotency.service.js";
import {
  EcommerceCodRemittanceBatchStatus,
  EcommerceCodRemittanceLineStatus,
  EcommerceCodRemittanceReconciliationStatus,
  EcommerceCourierCodCollectionSource,
  EcommerceCourierCodCollectionStatus,
  EcommerceCourierCodRemittanceStatus,
  EcommerceOrderEventType,
  EcommerceOrderStatus,
  EcommercePaymentMethod,
} from "../constants/enums.js";
import {
  EcommerceCodRemittanceBatch,
  EcommerceCodRemittanceLine,
  EcommerceOrder,
  EcommerceOrderEvent,
} from "../models/index.js";
import { paginate } from "../lib/pagination.js";

function assertCodOrder(order) {
  if (!orderUsesCod(order)) {
    throw errors.business("NOT_COD_ORDER", "Order is not a cash-on-delivery order.");
  }
}

const FULFILMENT_OK_FOR_COLLECTION = new Set([
  EcommerceOrderStatus.PROCESSING,
  EcommerceOrderStatus.SHIPPED,
  EcommerceOrderStatus.DELIVERED,
]);

export async function getCourierCodWorkspaceSummary(req) {
  const tenantId = req.auth.tenantId;
  const [collectionPending, collectionConfirmed, remittanceOwed, remittancePending, bankReconciled, discrepancyCount] =
    await Promise.all([
      EcommerceOrder.countDocuments({
        tenantId,
        paymentMethod: EcommercePaymentMethod.COD,
        "courierCod.collectionStatus": EcommerceCourierCodCollectionStatus.PENDING,
        status: { $in: [...FULFILMENT_OK_FOR_COLLECTION, EcommerceOrderStatus.SHIPPED] },
      }),
      EcommerceOrder.countDocuments({
        tenantId,
        "courierCod.collectionStatus": EcommerceCourierCodCollectionStatus.CONFIRMED,
      }),
      EcommerceOrder.countDocuments({
        tenantId,
        "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.OWED,
      }),
      EcommerceOrder.countDocuments({
        tenantId,
        "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.BATCH_PENDING,
      }),
      EcommerceOrder.countDocuments({
        tenantId,
        "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.BANK_RECONCILED,
      }),
      EcommerceOrder.countDocuments({
        tenantId,
        "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.DISCREPANCY,
      }),
    ]);
  const owedAgg = await EcommerceOrder.aggregate([
    {
      $match: {
        tenantId,
        "courierCod.remittanceStatus": {
          $in: [
            EcommerceCourierCodRemittanceStatus.OWED,
            EcommerceCourierCodRemittanceStatus.BATCH_PENDING,
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        totalPaise: { $sum: { $ifNull: ["$courierCod.expectedAmountPaise", "$totalPaise"] } },
      },
    },
  ]);
  return {
    courierIntegrationConfigured: false,
    courierIntegrationLabel: "Manual courier confirmation and statement reconciliation",
    collectionPendingCount: collectionPending,
    collectionConfirmedCount: collectionConfirmed,
    remittanceOwedCount: remittanceOwed,
    remittanceBatchPendingCount: remittancePending,
    bankReconciledCount: bankReconciled,
    remittanceDiscrepancyCount: discrepancyCount,
    remittanceOwedPaise: owedAgg[0]?.totalPaise ?? 0,
  };
}

const COURIER_COD_QUEUES = new Set([
  "awaiting_collection",
  "awaiting_remittance",
  "in_draft_batch",
  "discrepancy",
]);

function queueFilters(queue) {
  if (queue === "awaiting_collection") {
    return {
      paymentMethod: EcommercePaymentMethod.COD,
      status: { $in: [...FULFILMENT_OK_FOR_COLLECTION, EcommerceOrderStatus.SHIPPED] },
      "courierCod.collectionStatus": EcommerceCourierCodCollectionStatus.PENDING,
    };
  }
  if (queue === "awaiting_remittance") {
    return {
      paymentMethod: EcommercePaymentMethod.COD,
      "courierCod.collectionStatus": EcommerceCourierCodCollectionStatus.CONFIRMED,
      "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.OWED,
    };
  }
  if (queue === "in_draft_batch") {
    return {
      paymentMethod: EcommercePaymentMethod.COD,
      "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.BATCH_PENDING,
    };
  }
  if (queue === "discrepancy") {
    return {
      paymentMethod: EcommercePaymentMethod.COD,
      "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.DISCREPANCY,
    };
  }
  return null;
}

export async function listCourierCodOrders(req) {
  const queue = String(req.query.queue ?? "").trim();
  if (!COURIER_COD_QUEUES.has(queue)) {
    throw errors.validation([{ field: "queue", message: "Invalid courier COD queue." }]);
  }
  const filters = queueFilters(queue);
  const page = await paginate(EcommerceOrder, {
    scope: { tenantId: req.auth.tenantId },
    filters,
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: "updatedAt:desc",
    projection: {
      orderNumber: 1,
      status: 1,
      totalPaise: 1,
      updatedAt: 1,
      createdAt: 1,
      version: 1,
      courierCod: 1,
    },
  });
  const data = page.data.map((row) => ({
    orderId: row._id,
    orderNumber: row.orderNumber,
    status: row.status,
    totalPaise: row.totalPaise,
    expectedCodPaise: row.courierCod?.expectedAmountPaise ?? row.totalPaise,
    version: row.version,
    updatedAt: row.updatedAt,
    courierCod: row.courierCod ?? null,
  }));
  return { data, meta: page.meta };
}

export async function confirmManualCourierCodCollection(req) {
  const expectedVersion = Number(req.body.expectedVersion);
  const reference = String(req.body.reference ?? "").trim();
  const evidenceNote = String(req.body.evidenceNote ?? "").trim();
  const providerId = String(req.body.providerId ?? "MANUAL").trim() || "MANUAL";
  const trackingReference = String(req.body.trackingReference ?? "").trim() || undefined;
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!Number.isInteger(expectedVersion)) {
    throw errors.validation([{ field: "expectedVersion", message: "expectedVersion is required." }]);
  }
  if (!reference || reference.length < 2) {
    throw errors.validation([{ field: "reference", message: "Courier collection reference is required." }]);
  }
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const bodyHash = hashIdempotencyBody({
    expectedVersion,
    reference,
    evidenceNote,
    providerId,
    trackingReference,
  });

  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    assertCodOrder(order.toObject());

    const cc = order.courierCod ?? {};
    if (
      cc.collectionStatus === EcommerceCourierCodCollectionStatus.CONFIRMED
      && cc.collectionIdempotencyKey === idempotencyKey
    ) {
      if (cc.collectionBodyHash && cc.collectionBodyHash !== bodyHash) {
        throw errors.conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was used with a different request body.");
      }
      return order.toObject();
    }
    if (cc.collectionStatus === EcommerceCourierCodCollectionStatus.CONFIRMED) {
      throw errors.conflict("COD_COLLECTION_ALREADY_CONFIRMED", "Courier COD collection is already confirmed.");
    }
    if (!FULFILMENT_OK_FOR_COLLECTION.has(order.status)) {
      throw errors.business(
        "COD_COLLECTION_INVALID",
        "Order is not in a fulfilment state that allows courier collection confirmation.",
        { status: order.status },
      );
    }
    if (Number(order.version ?? 0) !== expectedVersion) {
      throw errors.conflict("VERSION_CONFLICT", "Order changed elsewhere. Refresh and retry.");
    }

    const expectedAmountPaise = Number(cc.expectedAmountPaise ?? order.totalPaise);
    const updated = await EcommerceOrder.findOneAndUpdate(
      {
        _id: order._id,
        tenantId: req.auth.tenantId,
        version: expectedVersion,
        $or: [
          { "courierCod.collectionStatus": EcommerceCourierCodCollectionStatus.PENDING },
          { "courierCod.collectionStatus": { $exists: false } },
        ],
      },
      {
        $set: {
          courierCod: {
            ...initialCourierCodForOrder({ totalPaise: order.totalPaise, providerId }),
            ...cc,
            providerId,
            trackingReference: trackingReference ?? cc.trackingReference ?? null,
            expectedAmountPaise,
            collectionStatus: EcommerceCourierCodCollectionStatus.CONFIRMED,
            collectionConfirmedAt: new Date(),
            collectionReference: reference,
            collectionSource: EcommerceCourierCodCollectionSource.MANUAL_OPERATOR,
            collectionEvidenceNote: evidenceNote || undefined,
            collectionIdempotencyKey: idempotencyKey,
            collectionBodyHash: bodyHash,
            collectionRecordedByUserId: req.auth.id,
            remittanceStatus: EcommerceCourierCodRemittanceStatus.OWED,
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
          type: EcommerceOrderEventType.COURIER_COD_COLLECTION_CONFIRMED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: {
            reference,
            providerId,
            trackingReference: trackingReference ?? null,
            source: EcommerceCourierCodCollectionSource.MANUAL_OPERATOR,
            expectedAmountPaise,
          },
        },
      ],
      { session },
    );
    return updated.toObject();
  });
}

export async function createCodRemittanceBatch(req) {
  const providerId = String(req.body.providerId ?? "MANUAL").trim() || "MANUAL";
  const statementReference = String(req.body.statementReference ?? "").trim();
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!statementReference || statementReference.length < 2) {
    throw errors.validation([{ field: "statementReference", message: "Statement reference is required." }]);
  }
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const bodyHash = hashIdempotencyBody({ statementReference, providerId });

  const existing = await EcommerceCodRemittanceBatch.findOne({
    tenantId: req.auth.tenantId,
    idempotencyKey,
  }).lean();
  if (existing) {
    if (existing.creationBodyHash && existing.creationBodyHash !== bodyHash) {
      throw errors.conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was used with a different request body.");
    }
    return existing;
  }

  const batch = await EcommerceCodRemittanceBatch.create({
    _id: createId("ecrb"),
    tenantId: req.auth.tenantId,
    providerId,
    statementReference,
    status: EcommerceCodRemittanceBatchStatus.DRAFT,
    importSource: "MANUAL",
    idempotencyKey,
    creationBodyHash: bodyHash,
    createdByUserId: req.auth.id,
  });
  return batch.toObject();
}

export async function addOrderToCodRemittanceBatch(req) {
  const grossPaise = Number(req.body.grossPaise);
  const feePaise = Number(req.body.feePaise ?? 0);
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  const amounts = assertRemittanceLineAmounts({ grossPaise, feePaise });
  if (!amounts.ok) {
    if (amounts.field === "feePaise" && feePaise > grossPaise) {
      throw errors.business("REMITTANCE_FEE_EXCEEDS_GROSS", amounts.message);
    }
    throw errors.validation([{ field: amounts.field, message: amounts.message }]);
  }
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const bodyHash = hashIdempotencyBody({ grossPaise, feePaise });

  return withTransaction(async (session) => {
    const batch = await EcommerceCodRemittanceBatch.findOne({
      _id: req.params.batchId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!batch) throw errors.notFound("Remittance batch");
    if (batch.status !== EcommerceCodRemittanceBatchStatus.DRAFT) {
      throw errors.business("BATCH_NOT_DRAFT", "Only draft batches accept new lines.");
    }

    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    assertCodOrder(order.toObject());
    if (!isCourierCodCollectionConfirmed(order.toObject())) {
      throw errors.business(
        "COD_COLLECTION_NOT_CONFIRMED",
        "Confirm courier COD collection before adding to a remittance batch.",
      );
    }
    const expected = resolveCodCollectionAmountPaise(order.toObject());
    if (expected !== grossPaise) {
      throw errors.business("COD_REMITTANCE_AMOUNT_MISMATCH", "Gross amount must match expected COD on the order.", {
        expectedPaise: expected,
        grossPaise,
      });
    }

    const dupLine = await EcommerceCodRemittanceLine.findOne({
      tenantId: req.auth.tenantId,
      orderId: order._id,
      status: EcommerceCodRemittanceLineStatus.ACTIVE,
    }).session(session);
    if (dupLine && dupLine.batchId !== batch._id) {
      throw errors.conflict("ORDER_ALREADY_IN_BATCH", "Order is already in an active remittance batch.");
    }

    const existingLine = await EcommerceCodRemittanceLine.findOne({
      tenantId: req.auth.tenantId,
      batchId: batch._id,
      orderId: order._id,
      idempotencyKey,
    }).session(session).lean();
    if (existingLine) {
      if (existingLine.creationBodyHash && existingLine.creationBodyHash !== bodyHash) {
        throw errors.conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was used with a different request body.");
      }
      return { batch: batch.toObject(), line: existingLine };
    }

    const netPaise = amounts.netPaise;
    const lineId = createId("ecrl");
    await EcommerceCodRemittanceLine.create(
      [
        {
          _id: lineId,
          tenantId: req.auth.tenantId,
          batchId: batch._id,
          orderId: order._id,
          grossPaise,
          feePaise,
          netPaise,
          status: EcommerceCodRemittanceLineStatus.ACTIVE,
          idempotencyKey,
          creationBodyHash: bodyHash,
        },
      ],
      { session },
    );

    await EcommerceOrder.findOneAndUpdate(
      { _id: order._id, tenantId: req.auth.tenantId },
      {
        $set: {
          "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.BATCH_PENDING,
          "courierCod.activeRemittanceLineId": lineId,
          "courierCod.activeRemittanceBatchId": batch._id,
          "courierCod.remittanceGrossPaise": grossPaise,
          "courierCod.remittanceFeePaise": feePaise,
          "courierCod.remittanceNetPaise": netPaise,
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
          type: EcommerceOrderEventType.COD_REMITTANCE_LINE_ADDED,
          actorType: "STAFF",
          actorId: req.auth.id,
          payload: { batchId: batch._id, lineId, grossPaise, feePaise },
        },
      ],
      { session },
    );

    const lines = await EcommerceCodRemittanceLine.find({
      tenantId: req.auth.tenantId,
      batchId: batch._id,
      status: EcommerceCodRemittanceLineStatus.ACTIVE,
    }).session(session).lean();
    const grossTotalPaise = lines.reduce((s, l) => s + l.grossPaise, 0);
    const feeTotalPaise = lines.reduce((s, l) => s + (l.feePaise ?? 0), 0);
    await EcommerceCodRemittanceBatch.updateOne(
      { _id: batch._id },
      { $set: { grossTotalPaise, feeTotalPaise, netExpectedPaise: grossTotalPaise - feeTotalPaise } },
      { session },
    );

    const line = await EcommerceCodRemittanceLine.findById(lineId).session(session).lean();
    const refreshedBatch = await EcommerceCodRemittanceBatch.findById(batch._id).session(session).lean();
    return { batch: refreshedBatch, line };
  });
}

export async function reconcileCodRemittanceBatch(req) {
  const bankCreditReference = String(req.body.bankCreditReference ?? "").trim();
  const bankCreditPaise = Number(req.body.bankCreditPaise);
  const bankCreditedAtRaw = req.body.bankCreditedAt;
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!bankCreditReference || bankCreditReference.length < 2) {
    throw errors.validation([{ field: "bankCreditReference", message: "Bank credit reference is required." }]);
  }
  if (!Number.isInteger(bankCreditPaise) || bankCreditPaise < 0) {
    throw errors.validation([{ field: "bankCreditPaise", message: "bankCreditPaise must be a non-negative integer." }]);
  }
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const bankCreditedAt = bankCreditedAtRaw ? new Date(bankCreditedAtRaw) : new Date();
  if (Number.isNaN(bankCreditedAt.getTime())) {
    throw errors.validation([{ field: "bankCreditedAt", message: "Invalid bankCreditedAt." }]);
  }
  const bodyHash = hashIdempotencyBody({ bankCreditReference, bankCreditPaise, bankCreditedAt: bankCreditedAtRaw ?? null });

  return withTransaction(async (session) => {
    const batch = await EcommerceCodRemittanceBatch.findOne({
      _id: req.params.batchId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!batch) throw errors.notFound("Remittance batch");
    if (batch.reconcileIdempotencyKey === idempotencyKey) {
      if (batch.reconcileBodyHash && batch.reconcileBodyHash !== bodyHash) {
        throw errors.conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was used with a different request body.");
      }
      return batch.toObject();
    }
    if (
      batch.status === EcommerceCodRemittanceBatchStatus.BANK_RECONCILED
      || batch.status === EcommerceCodRemittanceBatchStatus.DISCREPANCY
    ) {
      throw errors.conflict("BATCH_ALREADY_RECONCILED", "Batch is already reconciled.");
    }

    const lines = await EcommerceCodRemittanceLine.find({
      tenantId: req.auth.tenantId,
      batchId: batch._id,
      status: EcommerceCodRemittanceLineStatus.ACTIVE,
    }).session(session);
    if (!lines.length) {
      throw errors.business("BATCH_EMPTY", "Add at least one order line before reconciliation.");
    }

    const dupCredit = await EcommerceCodRemittanceBatch.findOne({
      tenantId: req.auth.tenantId,
      providerId: batch.providerId ?? "MANUAL",
      bankCreditReference,
      status: { $in: [EcommerceCodRemittanceBatchStatus.BANK_RECONCILED, EcommerceCodRemittanceBatchStatus.DISCREPANCY] },
      _id: { $ne: batch._id },
    }).session(session).lean();
    if (dupCredit) {
      throw errors.conflict(
        "BANK_CREDIT_ALREADY_RECONCILED",
        "This bank credit reference is already reconciled on another remittance batch.",
        { batchId: dupCredit._id },
      );
    }

    const grossTotalPaise = lines.reduce((s, l) => s + l.grossPaise, 0);
    const feeTotalPaise = lines.reduce((s, l) => s + (l.feePaise ?? 0), 0);
    const netExpectedPaise = grossTotalPaise - feeTotalPaise;
    const match = matchRemittanceTotals({
      grossTotalPaise,
      feeTotalPaise,
      netExpectedPaise,
      bankCreditPaise,
    });

    const batchStatus =
      match.status === EcommerceCodRemittanceReconciliationStatus.MATCHED
        ? EcommerceCodRemittanceBatchStatus.BANK_RECONCILED
        : EcommerceCodRemittanceBatchStatus.DISCREPANCY;

    const orderRemittanceStatus =
      match.status === EcommerceCodRemittanceReconciliationStatus.MATCHED
        ? EcommerceCourierCodRemittanceStatus.BANK_RECONCILED
        : EcommerceCourierCodRemittanceStatus.DISCREPANCY;

    await EcommerceCodRemittanceBatch.updateOne(
      { _id: batch._id, version: batch.version },
      {
        $set: {
          status: batchStatus,
          grossTotalPaise,
          feeTotalPaise,
          netExpectedPaise,
          bankCreditReference,
          bankCreditPaise,
          bankCreditedAt,
          reconciliationStatus: match.status,
          reconciliationNote: match.discrepancyPaise
            ? `Bank credit differs from expected net by ${match.discrepancyPaise} paise.`
            : "",
          finalizedAt: new Date(),
          reconcileIdempotencyKey: idempotencyKey,
          reconcileBodyHash: bodyHash,
        },
        $inc: { version: 1 },
      },
      { session },
    );

    for (const line of lines) {
      await EcommerceCodRemittanceLine.updateOne(
        { _id: line._id },
        {
          $set: {
            status:
              match.status === EcommerceCodRemittanceReconciliationStatus.MATCHED
                ? EcommerceCodRemittanceLineStatus.RECONCILED
                : EcommerceCodRemittanceLineStatus.ACTIVE,
          },
        },
        { session },
      );
      await EcommerceOrder.findOneAndUpdate(
        { _id: line.orderId, tenantId: req.auth.tenantId },
        {
          $set: {
            "courierCod.remittanceStatus": orderRemittanceStatus,
            "courierCod.bankCreditReference": bankCreditReference,
            "courierCod.bankCreditedAt": bankCreditedAt,
            "courierCod.reconciliationStatus": match.status,
            "courierCod.reconciliationDiscrepancyPaise": match.discrepancyPaise ?? 0,
            "courierCod.remittanceGrossPaise": line.grossPaise,
            "courierCod.remittanceFeePaise": line.feePaise ?? 0,
            "courierCod.remittanceNetPaise": line.netPaise ?? line.grossPaise - (line.feePaise ?? 0),
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
            orderId: line.orderId,
            type: EcommerceOrderEventType.COD_REMITTANCE_BATCH_RECONCILED,
            actorType: "STAFF",
            actorId: req.auth.id,
            payload: {
              batchId: batch._id,
              reconciliationStatus: match.status,
              bankCreditPaise,
            },
          },
        ],
        { session },
      );
    }

    return EcommerceCodRemittanceBatch.findById(batch._id).session(session).lean();
  });
}

export async function getCodRemittanceBatch(req) {
  const batch = await EcommerceCodRemittanceBatch.findOne({
    _id: req.params.batchId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!batch) throw errors.notFound("Remittance batch");
  const lines = await EcommerceCodRemittanceLine.find({
    tenantId: req.auth.tenantId,
    batchId: batch._id,
  }).lean();
  const orderIds = lines.map((l) => l.orderId);
  const orders = orderIds.length
    ? await EcommerceOrder.find({ tenantId: req.auth.tenantId, _id: { $in: orderIds } })
        .select("orderNumber totalPaise")
        .lean()
    : [];
  const orderById = new Map(orders.map((o) => [o._id, o]));
  const enrichedLines = lines.map((line) => ({
    ...line,
    orderNumber: orderById.get(line.orderId)?.orderNumber ?? null,
    orderTotalPaise: orderById.get(line.orderId)?.totalPaise ?? null,
  }));
  return { batch, lines: enrichedLines };
}

export async function listCodRemittanceBatches(req) {
  return paginate(EcommerceCodRemittanceBatch, {
    scope: { tenantId: req.auth.tenantId },
    filters: {},
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: "createdAt:desc",
  });
}
