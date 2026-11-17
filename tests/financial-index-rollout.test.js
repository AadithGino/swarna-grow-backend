import { spawnSync } from "node:child_process";
import mongoose from "mongoose";
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalMetalRedemptionOrder, EcommercePaymentExceptionRefund, LedgerEntry } from "../src/models/index.js";
import { assertFinancialIndexesReady, applyFinancialIndexRollout } from "../src/lib/financial-index-rollout.js";
import { resetTestDb } from "./helpers/db.js";

test.beforeEach(resetTestDb);
test("financial index rollout replaces obsolete refund uniqueness and is idempotent", async () => {
  await EcommercePaymentExceptionRefund.collection.createIndex({ tenantId: 1, orderId: 1 }, { unique: true });
  await assert.rejects(assertFinancialIndexesReady(), /MIGRATION_REQUIRED/);
  await assert.rejects(applyFinancialIndexRollout(), /Pause API/);
  await applyFinancialIndexRollout({ writesPaused: true });
  await applyFinancialIndexRollout({ writesPaused: true });
  await assertFinancialIndexesReady();
});
test("return refund rollout preserves distinct refunds and unique non-return cases", async () => {
  const collection = EcommercePaymentExceptionRefund.collection;
  await collection.createIndex({ tenantId: 1, orderId: 1, paymentAttemptId: 1 }, { unique: true });
  const base = { tenantId: "migration-tenant", orderId: "migration-order", paymentAttemptId: "migration-attempt" };
  try {
    await assert.rejects(assertFinancialIndexesReady(), /MIGRATION_REQUIRED/);
    await applyFinancialIndexRollout({ writesPaused: true });
    await collection.insertMany([
      { ...base, _id: "migration-return-a", returnRequestId: "return-a" },
      { ...base, _id: "migration-return-b", returnRequestId: "return-b" },
      { ...base, _id: "migration-non-return" },
    ]);
    await assert.rejects(collection.insertOne({ ...base, _id: "migration-duplicate-a", returnRequestId: "return-a" }), { code: 11000 });
    await assert.rejects(collection.insertOne({ ...base, _id: "migration-duplicate-non-return" }), { code: 11000 });
  } finally {
    await collection.deleteMany({ tenantId: base.tenantId });
  }
});
test("financial index rollout requires and restores maturity credit uniqueness", async () => {
  const indexName = "tenantId_1_schemeId_1_maturityEventKey_1";
  await LedgerEntry.collection.dropIndex(indexName);
  try {
    await assert.rejects(assertFinancialIndexesReady(), /MIGRATION_REQUIRED/);
    await applyFinancialIndexRollout({ writesPaused: true });
    await assertFinancialIndexesReady();
    const index = (await LedgerEntry.collection.indexes()).find((row) => row.name === indexName);
    assert.equal(index.unique, true);
    assert.deepEqual(index.partialFilterExpression, { maturityEventKey: { $type: "string" } });
  } finally {
    await LedgerEntry.createIndexes();
  }
});

test("financial index rollout refuses duplicate quotes before removing legacy protection", async () => {
  await DigitalMetalRedemptionOrder.collection.dropIndex("tenantId_1_quoteId_1");
  try {
    await DigitalMetalRedemptionOrder.collection.insertMany([
      { _id: "migration-a", tenantId: "tenant-a", quoteId: "same", idempotencyKey: "a" },
      { _id: "migration-b", tenantId: "tenant-a", quoteId: "same", idempotencyKey: "b" },
    ]);
    await assert.rejects(applyFinancialIndexRollout({ writesPaused: true }), /DUPLICATE_FINANCIAL/);
  } finally {
    await DigitalMetalRedemptionOrder.deleteMany({});
    await DigitalMetalRedemptionOrder.syncIndexes();
  }
});

test("concurrent production connections all reject an unmigrated database", async () => {
  const uri = mongoose.connection.getClient().s.url;
  await DigitalMetalRedemptionOrder.collection.dropIndex("tenantId_1_quoteId_1");
  const productionEnv = {
    NODE_ENV: "production", MONGODB_URI: uri,
    JWT_ACCESS_SECRET: "production-test-access-secret-32-characters",
    JWT_REFRESH_SECRET: "production-test-refresh-secret-32-characters",
    INTEGRATION_ENCRYPTION_KEY: "production-test-encryption-key-32-characters",
    SEED_PLATFORM_PASSWORD: "9876", REDIS_REQUIRED: "true", RATE_LIMIT_ENABLED: "true",
    PROVIDER_MODE: "live", PHONEPE_ENV: "PRODUCTION", OTP_PROVIDER: "msg91",
    MSG91_AUTH_KEY: "audit-placeholder", MSG91_OTP_TEMPLATE_ID: "audit-placeholder", MSG91_SENDER_ID: "SWRNGR",
    FCM_SHARED_PROJECT_ENABLED: "true", FCM_PROJECT_ID: "audit-project",
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "audit@example.invalid", private_key: "audit-placeholder" }),
    S3_BUCKET: "audit-bucket", S3_ACCESS_KEY_ID: "audit-placeholder", S3_SECRET_ACCESS_KEY: "audit-placeholder",
    CORS_ORIGINS: "https://app.example.com", PUBLIC_BASE_URL: "https://api.example.com",
    EXPORT_BASE_URL: "https://api.example.com", MALWARE_SCAN_URL: "https://scanner.example.com/scan",
  };
  const script = `
    import assert from "node:assert/strict";
    import { connectDatabase, databaseReady } from "./src/config/database.js";
    const results = await Promise.allSettled([connectDatabase(), connectDatabase(), connectDatabase()]);
    assert.ok(results.every(result => result.status === "rejected" && /MIGRATION_REQUIRED/.test(result.reason.message)), JSON.stringify(results));
    assert.equal(databaseReady(), false);
  `;
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, ...productionEnv }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  } finally { await DigitalMetalRedemptionOrder.syncIndexes(); }
});
