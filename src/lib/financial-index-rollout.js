import {
  DigitalMetalRedemptionOrder, DigitalMetalPayout,
  DigitalMetalPaymentExceptionRefund, EcommercePaymentAttempt, EcommercePaymentExceptionRefund, LedgerEntry,
} from "../models/index.js";

const active = ["PENDING_APPROVAL", "APPROVED", "SUBMITTED", "UNKNOWN"];
const definitions = [
  {
    model: LedgerEntry,
    key: { tenantId: 1, schemeId: 1, maturityEventKey: 1 },
    partial: { maturityEventKey: { $type: "string" } },
  },
  { model: DigitalMetalRedemptionOrder, key: { tenantId: 1, quoteId: 1 } },
  { model: DigitalMetalPayout, key: { tenantId: 1, payableId: 1 }, partial: { status: { $in: active } } },
  { model: DigitalMetalPaymentExceptionRefund, key: { tenantId: 1, orderId: 1, paymentAttemptId: 1 }, legacyOrderIndex: true },
  // One active attempt per ordinary order. The replacement keeps the same key but only covers
  // attempts that have an orderId, so booking attempts (no order yet) cannot collide on null.
  {
    model: EcommercePaymentAttempt, key: { tenantId: 1, orderId: 1 },
    partial: { status: { $in: ["PENDING", "INITIATED"] }, orderId: { $type: "string" } },
    name: "ecommerce_attempt_active_order_unique", legacyNames: ["tenantId_1_orderId_1"],
  },
  {
    model: EcommercePaymentAttempt, key: { tenantId: 1, bookingId: 1, purpose: 1 },
    partial: { status: { $in: ["PENDING", "INITIATED"] }, bookingId: { $type: "string" } },
    name: "ecommerce_attempt_active_booking_purpose_unique",
  },
  // One refund row per (operation, capture). Replaces the order+capture and return-only unique
  // indexes, which forbade several operations on one capture and one operation on several captures.
  {
    model: EcommercePaymentExceptionRefund, key: { tenantId: 1, refundOperationId: 1, paymentAttemptId: 1 },
    partial: { refundOperationId: { $type: "string" } }, name: "ecommerce_refund_operation_capture_unique",
    legacyOrderIndex: true,
    legacyNames: [
      "tenantId_1_orderId_1_paymentAttemptId_1",
      "ecommerce_capture_refund_without_return_unique",
      "ecommerce_return_refund_unique",
    ],
    backfill: "refundOperationId",
  },
];

/** Refund rows written before refundOperationId existed. */
const MISSING_OPERATION_ID = {
  $or: [{ refundOperationId: { $exists: false } }, { refundOperationId: null }, { refundOperationId: "" }],
};

/**
 * Gives every legacy refund row the stable operation id its creator would assign today:
 * return:<id>, cancel:<id>, or exception:<attempt>. The retired unique indexes already made these
 * unique, so the result is unique per (operation, capture). Safe to run repeatedly.
 */
export async function backfillRefundOperationIds() {
  const result = await EcommercePaymentExceptionRefund.collection.updateMany(MISSING_OPERATION_ID, [{
    $set: {
      refundOperationId: {
        $switch: {
          branches: [
            { case: { $eq: [{ $type: "$returnRequestId" }, "string"] }, then: { $concat: ["return:", "$returnRequestId"] } },
            { case: { $eq: [{ $type: "$cancellationRequestId" }, "string"] }, then: { $concat: ["cancel:", "$cancellationRequestId"] } },
          ],
          default: { $concat: ["exception:", "$paymentAttemptId"] },
        },
      },
    },
  }]);
  return { matched: result.matchedCount, modified: result.modifiedCount };
}
const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const indexName = key => Object.entries(key).map(([field, direction]) => `${field}_${direction}`).join("_");

export async function inspectFinancialIndexes({ scanData = true } = {}) {
  const results = [];
  for (const definition of definitions) {
    const { model, key, partial, legacyOrderIndex } = definition;
    const groupKey = Object.fromEntries(Object.keys(key).map(field => [field, `$${field}`]));
    const duplicates = scanData ? await model.aggregate([
      ...(partial ? [{ $match: partial }] : []),
      { $group: { _id: groupKey, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }, { $limit: 100 },
    ]).option({ maxTimeMS: 60_000, allowDiskUse: true }) : [];
    let indexes;
    try { indexes = await model.collection.indexes(); }
    catch (error) { if (error.code !== 26) throw error; indexes = []; }
    const required = indexes.find(index => sameKey(index.key, key) && index.unique === true
      && (!partial || sameKey(index.partialFilterExpression, partial)));
    const legacy = indexes.filter(index => definition.legacyNames?.includes(index.name) ||
      (legacyOrderIndex && index.unique === true && sameKey(index.key, { tenantId: 1, orderId: 1 })))
      .map(index => index.name);
    const unbackfilled = scanData && definition.backfill ? await model.collection.countDocuments(MISSING_OPERATION_ID) : 0;
    results.push({ model: model.modelName, requiredIndex: definition.name ?? indexName(key), ready: Boolean(required) && legacy.length === 0,
      legacyIndexes: legacy, duplicates, unbackfilled, indexPresent: Boolean(required) });
  }
  return results;
}

export async function assertFinancialIndexesReady() {
  const report = await inspectFinancialIndexes({ scanData: false });
  if (report.some(row => !row.ready || row.duplicates.length)) {
    throw new Error("FINANCIAL_INDEX_MIGRATION_REQUIRED: pause writers and run scripts/migrate-financial-invariants.js; inspect duplicate obligations before rollout.");
  }
}

/** Explicit offline rollout. Never call this from request handlers or startup. */
export async function applyFinancialIndexRollout({ writesPaused = false } = {}) {
  if (!writesPaused) throw new Error("Pause API and background writers before replacing financial indexes.");
  const duplicatesError = "DUPLICATE_FINANCIAL_OBLIGATIONS: review and repair existing data before index rollout.";
  const before = await inspectFinancialIndexes();
  if (before.some(row => row.duplicates.length)) throw new Error(duplicatesError);
  // Backfill first, then re-check: the new refund key only means something once every row has it.
  await backfillRefundOperationIds();
  const report = await inspectFinancialIndexes();
  if (report.some(row => row.duplicates.length)) throw new Error(duplicatesError);
  if (report.some(row => row.unbackfilled)) throw new Error("REFUND_OPERATION_BACKFILL_INCOMPLETE: refund rows still lack refundOperationId.");
  // Create replacement constraints before removing the obsolete ones.
  for (const { model, key, partial, name } of definitions) {
    await model.collection.createIndex(key, { unique: true, name: name ?? indexName(key),
      ...(partial ? { partialFilterExpression: partial } : {}) });
  }
  // Verify every replacement exists before retiring any legacy constraint.
  const created = await inspectFinancialIndexes({ scanData: false });
  const missing = created.filter(row => !row.indexPresent);
  if (missing.length) throw new Error(`FINANCIAL_INDEX_REPLACEMENT_MISSING: ${missing.map(row => row.requiredIndex).join(", ")}`);
  const dropped = new Set();
  for (const row of report) {
    const definition = definitions.find(entry => entry.model.modelName === row.model && entry.name === row.requiredIndex)
      ?? definitions.find(entry => entry.model.modelName === row.model);
    for (const name of row.legacyIndexes) {
      const marker = `${row.model}:${name}`;
      if (dropped.has(marker)) continue;
      dropped.add(marker);
      try { await definition.model.collection.dropIndex(name); }
      catch (error) { if (error.code !== 27) throw error; }
    }
  }
  await assertFinancialIndexesReady();
  return inspectFinancialIndexes();
}
