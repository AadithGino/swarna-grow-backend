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
import { assertBranchScopeForMutation } from "../lib/mutation-requirements.js";
import { rupeesToPaise } from "../lib/ui-amount-conversion.js";
import {
  EcommerceCodRemittanceBatchStatus,
  EcommerceCodRemittanceLineStatus,
  EcommerceCodRemittanceReconciliationStatus,
  EcommerceCourierCodCollectionSource,
  EcommerceCourierCodCollectionStatus,
  EcommerceCourierCodRemittanceStatus,
  EcommerceOrderEventType,
  EcommerceFulfilmentMode,
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

async function resolveOrderBranchScope(order) {
  const { Customer } = await import("../models/index.js");
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
  return { customerBranchId, resourceBranchId };
}

/** Shared COD collection patch (manual operator). Caller must enforce version + fulfilment state. */
export function buildManualCourierCodCollectionSet(order, req, {
  reference,
  evidenceNote = "",
  providerId = "MANUAL",
  trackingReference,
  idempotencyKey,
  bodyHash,
}) {
  const cc = order.courierCod ?? {};
  if (cc.collectionStatus === EcommerceCourierCodCollectionStatus.CONFIRMED) {
    throw errors.conflict("COD_COLLECTION_ALREADY_CONFIRMED", "Courier COD collection is already confirmed.");
  }
  const expectedAmountPaise = Number(cc.expectedAmountPaise ?? order.totalPaise);
  return {
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
  };
}

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
    const scope = await resolveOrderBranchScope(order.toObject());
    assertBranchScopeForMutation(req, scope);

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

    const collectionSet = buildManualCourierCodCollectionSet(order, req, {
      reference,
      evidenceNote,
      providerId,
      trackingReference,
      idempotencyKey,
      bodyHash,
    });
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
        $set: collectionSet,
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
            expectedAmountPaise: collectionSet.courierCod.expectedAmountPaise,
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

function allocateCourierFeePaiseAcrossGross(grossPaiseList, totalFeePaise) {
  if (totalFeePaise <= 0) return grossPaiseList.map(() => 0);
  const totalGross = grossPaiseList.reduce((s, g) => s + g, 0);
  if (totalFeePaise > totalGross) {
    throw errors.business(
      "REMITTANCE_FEE_EXCEEDS_GROSS",
      "Total courier fees cannot exceed the combined COD collected on selected orders.",
    );
  }
  let remaining = totalFeePaise;
  return grossPaiseList.map((gross, index) => {
    if (index === grossPaiseList.length - 1) return remaining;
    const share = Math.floor((totalFeePaise * gross) / totalGross);
    remaining -= share;
    return share;
  });
}

function remittanceReconciliationOutcomeLabel(reconciliationStatus) {
  if (reconciliationStatus === EcommerceCodRemittanceReconciliationStatus.MATCHED) return "Matched";
  if (reconciliationStatus === EcommerceCodRemittanceReconciliationStatus.SHORT) return "Short payment";
  if (reconciliationStatus === EcommerceCodRemittanceReconciliationStatus.OVER) return "Over payment";
  return "Pending";
}

async function addRemittanceLineInSession(session, {
  tenantId,
  userId,
  batchId,
  order,
  grossPaise,
  feePaise,
  idempotencyKey,
  bodyHash,
}) {
  const amounts = assertRemittanceLineAmounts({ grossPaise, feePaise });
  if (!amounts.ok) {
    if (amounts.field === "feePaise" && feePaise > grossPaise) {
      throw errors.business("REMITTANCE_FEE_EXCEEDS_GROSS", amounts.message);
    }
    throw errors.validation([{ field: amounts.field, message: amounts.message }]);
  }

  const batch = await EcommerceCodRemittanceBatch.findOne({ _id: batchId, tenantId }).session(session);
  if (!batch) throw errors.notFound("Remittance batch");
  if (batch.status !== EcommerceCodRemittanceBatchStatus.DRAFT) {
    throw errors.business("BATCH_NOT_DRAFT", "Only draft batches accept new lines.");
  }

  assertCodOrder(order.toObject());
  if (!isCourierCodCollectionConfirmed(order.toObject())) {
    throw errors.business(
      "COD_COLLECTION_NOT_CONFIRMED",
      "Confirm courier COD collection before adding to a remittance batch.",
    );
  }

  const dupLineEarly = await EcommerceCodRemittanceLine.findOne({
    tenantId,
    orderId: order._id,
    status: EcommerceCodRemittanceLineStatus.ACTIVE,
  }).session(session);
  if (dupLineEarly && dupLineEarly.batchId !== batchId) {
    throw errors.conflict("ORDER_ALREADY_IN_BATCH", "Order is already in an active remittance batch.");
  }

  const remittanceStatus = order.courierCod?.remittanceStatus;
  if (remittanceStatus !== EcommerceCourierCodRemittanceStatus.OWED) {
    throw errors.business(
      "COD_REMITTANCE_NOT_OWED",
      "Order is not awaiting courier remittance recording.",
      { remittanceStatus: remittanceStatus ?? null },
    );
  }

  const expected = resolveCodCollectionAmountPaise(order.toObject());
  if (expected !== grossPaise) {
    throw errors.business("COD_REMITTANCE_AMOUNT_MISMATCH", "Gross amount must match expected COD on the order.", {
      expectedPaise: expected,
      grossPaise,
    });
  }

  const existingLine = await EcommerceCodRemittanceLine.findOne({
    tenantId,
    batchId,
    orderId: order._id,
    idempotencyKey,
  })
    .session(session)
    .lean();
  if (existingLine) {
    if (existingLine.creationBodyHash && existingLine.creationBodyHash !== bodyHash) {
      throw errors.conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was used with a different request body.");
    }
    return { batch: batch.toObject(), line: existingLine };
  }

  const dupLine = await EcommerceCodRemittanceLine.findOne({
    tenantId,
    orderId: order._id,
    status: EcommerceCodRemittanceLineStatus.ACTIVE,
  }).session(session);
  if (dupLine && dupLine.batchId !== batchId) {
    throw errors.conflict("ORDER_ALREADY_IN_BATCH", "Order is already in an active remittance batch.");
  }

  const claimed = await EcommerceOrder.findOneAndUpdate(
    {
      _id: order._id,
      tenantId,
      "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.OWED,
    },
    { $inc: { version: 1 } },
    { session, new: true },
  );
  if (!claimed) {
    throw errors.conflict(
      "ORDER_ALREADY_IN_BATCH",
      "Order is already in an active remittance batch or remittance was recorded.",
    );
  }

  const netPaise = amounts.netPaise;
  const lineId = createId("ecrl");
  await EcommerceCodRemittanceLine.create(
    [
      {
        _id: lineId,
        tenantId,
        batchId,
        orderId: order._id,
        grossPaise,
        feePaise,
        netPaise,
        status: EcommerceCodRemittanceLineStatus.ACTIVE,
        idempotencyKey,
        creationBodyHash: bodyHash,
      },
    ],
    { session, ordered: true },
  );

  await EcommerceOrder.findOneAndUpdate(
    { _id: order._id, tenantId },
    {
      $set: {
        "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.BATCH_PENDING,
        "courierCod.activeRemittanceLineId": lineId,
        "courierCod.activeRemittanceBatchId": batchId,
        "courierCod.remittanceGrossPaise": grossPaise,
        "courierCod.remittanceFeePaise": feePaise,
        "courierCod.remittanceNetPaise": netPaise,
      },
    },
    { session },
  );

  await EcommerceOrderEvent.create(
    [
      {
        _id: createId("eoev"),
        tenantId,
        orderId: order._id,
        type: EcommerceOrderEventType.COD_REMITTANCE_LINE_ADDED,
        actorType: "STAFF",
        actorId: userId,
        payload: { batchId, lineId, grossPaise, feePaise },
      },
    ],
    { session, ordered: true },
  );

  const lines = await EcommerceCodRemittanceLine.find({
    tenantId,
    batchId,
    status: EcommerceCodRemittanceLineStatus.ACTIVE,
  })
    .session(session)
    .lean();
  const grossTotalPaise = lines.reduce((s, l) => s + l.grossPaise, 0);
  const feeTotalPaise = lines.reduce((s, l) => s + (l.feePaise ?? 0), 0);
  await EcommerceCodRemittanceBatch.updateOne(
    { _id: batchId },
    { $set: { grossTotalPaise, feeTotalPaise, netExpectedPaise: grossTotalPaise - feeTotalPaise } },
    { session },
  );

  const line = await EcommerceCodRemittanceLine.findById(lineId).session(session).lean();
  const refreshedBatch = await EcommerceCodRemittanceBatch.findById(batchId).session(session).lean();
  return { batch: refreshedBatch, line };
}

async function reconcileRemittanceBatchInSession(session, {
  tenantId,
  userId,
  batchId,
  bankCreditReference,
  bankCreditPaise,
  bankCreditedAt,
  idempotencyKey,
  bodyHash,
}) {
  const batch = await EcommerceCodRemittanceBatch.findOne({ _id: batchId, tenantId }).session(session);
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
    tenantId,
    batchId,
    status: EcommerceCodRemittanceLineStatus.ACTIVE,
  }).session(session);
  if (!lines.length) {
    throw errors.business("BATCH_EMPTY", "Add at least one order line before reconciliation.");
  }

  const dupCredit = await EcommerceCodRemittanceBatch.findOne({
    tenantId,
    providerId: batch.providerId ?? "MANUAL",
    bankCreditReference,
    status: { $in: [EcommerceCodRemittanceBatchStatus.BANK_RECONCILED, EcommerceCodRemittanceBatchStatus.DISCREPANCY] },
    _id: { $ne: batchId },
  })
    .session(session)
    .lean();
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
    { _id: batchId, version: batch.version },
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
      { _id: line.orderId, tenantId },
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
          tenantId,
          orderId: line.orderId,
          type: EcommerceOrderEventType.COD_REMITTANCE_BATCH_RECONCILED,
          actorType: "STAFF",
          actorId: userId,
          payload: {
            batchId,
            reconciliationStatus: match.status,
            bankCreditPaise,
          },
        },
      ],
      { session, ordered: true },
    );
  }

  const finalized = await EcommerceCodRemittanceBatch.findById(batchId).session(session).lean();
  return { batch: finalized, match };
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

  const orderPreview = await EcommerceOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!orderPreview) throw errors.notFound("Order");
  const scope = await resolveOrderBranchScope(orderPreview);
  assertBranchScopeForMutation(req, scope);

  return withTransaction(async (session) => {
    const order = await EcommerceOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!order) throw errors.notFound("Order");
    return addRemittanceLineInSession(session, {
      tenantId: req.auth.tenantId,
      userId: req.auth.id,
      batchId: req.params.batchId,
      order,
      grossPaise,
      feePaise,
      idempotencyKey,
      bodyHash,
    });
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
    const { batch } = await reconcileRemittanceBatchInSession(session, {
      tenantId: req.auth.tenantId,
      userId: req.auth.id,
      batchId: req.params.batchId,
      bankCreditReference,
      bankCreditPaise,
      bankCreditedAt,
      idempotencyKey,
      bodyHash,
    });
    return batch;
  });
}

export async function recordCourierMoneyReceived(req) {
  const orderIdsRaw = Array.isArray(req.body.orderIds) ? req.body.orderIds.map(String) : [];
  const orderIds = [...new Set(orderIdsRaw.map((id) => id.trim()).filter(Boolean))];
  if (!orderIds.length) {
    throw errors.validation([{ field: "orderIds", message: "Select at least one order." }]);
  }

  const bankCreditReference = String(req.body.bankCreditReference ?? "").trim();
  if (bankCreditReference.length < 2) {
    throw errors.validation([{ field: "bankCreditReference", message: "Bank credit reference is required." }]);
  }

  const bankCreditPaise = rupeesToPaise(req.body.bankCreditRupees, { fieldName: "bankCreditRupees" });
  const totalFeePaise =
    req.body.totalCourierFeeRupees === undefined || req.body.totalCourierFeeRupees === null
      ? 0
      : rupeesToPaise(req.body.totalCourierFeeRupees, { fieldName: "totalCourierFeeRupees" });

  const bankCreditedAtRaw = req.body.bankCreditedAt;
  const bankCreditedAt = bankCreditedAtRaw ? new Date(bankCreditedAtRaw) : new Date();
  if (Number.isNaN(bankCreditedAt.getTime())) {
    throw errors.validation([{ field: "bankCreditedAt", message: "Invalid bankCreditedAt." }]);
  }

  const providerId = String(req.body.providerId ?? "MANUAL").trim() || "MANUAL";
  const statementReference =
    String(req.body.statementReference ?? bankCreditReference).trim() || bankCreditReference;

  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }

  const creationBody = {
    orderIds: [...orderIds].sort(),
    bankCreditReference,
    bankCreditRupees: req.body.bankCreditRupees,
    totalCourierFeeRupees: req.body.totalCourierFeeRupees ?? null,
    bankCreditedAt: bankCreditedAtRaw ?? null,
    statementReference,
    providerId,
  };
  const creationBodyHash = hashIdempotencyBody(creationBody);
  const reconcileBodyHash = hashIdempotencyBody({
    bankCreditReference,
    bankCreditPaise,
    bankCreditedAt: bankCreditedAtRaw ?? null,
  });

  const existingBatch = await EcommerceCodRemittanceBatch.findOne({
    tenantId: req.auth.tenantId,
    idempotencyKey,
  }).lean();
  if (existingBatch) {
    if (existingBatch.creationBodyHash && existingBatch.creationBodyHash !== creationBodyHash) {
      throw errors.conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was used with a different request body.");
    }
    const detail = await getCodRemittanceBatch({
      auth: req.auth,
      params: { batchId: existingBatch._id },
    });
    const batch = detail.batch;
    return {
      batch,
      lines: detail.lines,
      reconciliation: {
        status: batch.reconciliationStatus ?? null,
        discrepancyPaise: batch.reconciliationStatus
          ? batch.bankCreditPaise - (batch.netExpectedPaise ?? 0)
          : 0,
        bankCreditPaise: batch.bankCreditPaise ?? bankCreditPaise,
        netExpectedPaise: batch.netExpectedPaise ?? null,
        outcomeLabel: remittanceReconciliationOutcomeLabel(batch.reconciliationStatus),
      },
    };
  }

  const ordersPreview = await EcommerceOrder.find({
    tenantId: req.auth.tenantId,
    _id: { $in: orderIds },
  }).lean();
  if (ordersPreview.length !== orderIds.length) {
    throw errors.notFound("One or more orders were not found.");
  }
  const orderById = new Map(ordersPreview.map((o) => [o._id, o]));
  for (const orderId of orderIds) {
    const order = orderById.get(orderId);
    assertCodOrder(order);
    const scope = await resolveOrderBranchScope(order);
    assertBranchScopeForMutation(req, scope);
  }

  const grossPaiseList = orderIds.map((id) => resolveCodCollectionAmountPaise(orderById.get(id)));
  const feePaiseList = allocateCourierFeePaiseAcrossGross(grossPaiseList, totalFeePaise);

  return withTransaction(async (session) => {
    const batchId = createId("ecrb");
    await EcommerceCodRemittanceBatch.create(
      [
        {
          _id: batchId,
          tenantId: req.auth.tenantId,
          providerId,
          statementReference,
          status: EcommerceCodRemittanceBatchStatus.DRAFT,
          importSource: "MONEY_RECEIVED",
          idempotencyKey,
          creationBodyHash,
          createdByUserId: req.auth.id,
        },
      ],
      { session, ordered: true },
    );

    const lineResults = [];
    for (let i = 0; i < orderIds.length; i += 1) {
      const orderId = orderIds[i];
      const order = await EcommerceOrder.findOne({ _id: orderId, tenantId: req.auth.tenantId }).session(session);
      if (!order) throw errors.notFound("Order");
      const grossPaise = grossPaiseList[i];
      const feePaise = feePaiseList[i];
      const lineKey = `${idempotencyKey}:line:${orderId}`;
      const lineBodyHash = hashIdempotencyBody({ grossPaise, feePaise });
      const { line } = await addRemittanceLineInSession(session, {
        tenantId: req.auth.tenantId,
        userId: req.auth.id,
        batchId,
        order,
        grossPaise,
        feePaise,
        idempotencyKey: lineKey,
        bodyHash: lineBodyHash,
      });
      lineResults.push(line);
    }

    const { batch, match } = await reconcileRemittanceBatchInSession(session, {
      tenantId: req.auth.tenantId,
      userId: req.auth.id,
      batchId,
      bankCreditReference,
      bankCreditPaise,
      bankCreditedAt,
      idempotencyKey: `${idempotencyKey}:reconcile`,
      bodyHash: reconcileBodyHash,
    });

    const orderIdSet = new Set(orderIds);
    const enrichedLines = lineResults.map((line) => ({
      ...line,
      orderNumber: orderById.get(line.orderId)?.orderNumber ?? null,
      orderTotalPaise: orderById.get(line.orderId)?.totalPaise ?? null,
    }));

    return {
      batch,
      lines: enrichedLines,
      reconciliation: {
        status: match.status,
        discrepancyPaise: match.discrepancyPaise ?? 0,
        bankCreditPaise,
        netExpectedPaise: batch.netExpectedPaise ?? null,
        outcomeLabel: remittanceReconciliationOutcomeLabel(match.status),
      },
      orderIds: [...orderIdSet],
    };
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
