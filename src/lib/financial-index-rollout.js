import {
  DigitalMetalRedemptionOrder, DigitalMetalPayout,
  DigitalMetalPaymentExceptionRefund, EcommercePaymentExceptionRefund,
} from "../models/index.js";

const active = ["PENDING_APPROVAL", "APPROVED", "SUBMITTED", "UNKNOWN"];
const definitions = [
  { model: DigitalMetalRedemptionOrder, key: { tenantId: 1, quoteId: 1 } },
  { model: DigitalMetalPayout, key: { tenantId: 1, payableId: 1 }, partial: { status: { $in: active } } },
  { model: DigitalMetalPaymentExceptionRefund, key: { tenantId: 1, orderId: 1, paymentAttemptId: 1 }, legacyOrderIndex: true },
  { model: EcommercePaymentExceptionRefund, key: { tenantId: 1, orderId: 1, paymentAttemptId: 1 }, legacyOrderIndex: true },
];
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
    const legacy = legacyOrderIndex ? indexes.filter(index => index.unique === true
      && sameKey(index.key, { tenantId: 1, orderId: 1 })).map(index => index.name) : [];
    results.push({ model: model.modelName, requiredIndex: indexName(key), ready: Boolean(required) && legacy.length === 0,
      legacyIndexes: legacy, duplicates });
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
  const report = await inspectFinancialIndexes();
  if (report.some(row => row.duplicates.length)) throw new Error("DUPLICATE_FINANCIAL_OBLIGATIONS: review and repair existing data before index rollout.");
  // Create replacement constraints before removing the obsolete order-only constraint.
  for (const { model, key, partial } of definitions) {
    await model.collection.createIndex(key, { unique: true, name: indexName(key),
      ...(partial ? { partialFilterExpression: partial } : {}) });
  }
  for (const row of report) {
    const definition = definitions.find(entry => entry.model.modelName === row.model);
    for (const name of row.legacyIndexes) await definition.model.collection.dropIndex(name);
  }
  await assertFinancialIndexesReady();
  return inspectFinancialIndexes();
}
