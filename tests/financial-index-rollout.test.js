import { spawnSync } from "node:child_process";
import mongoose from "mongoose";
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalMetalRedemptionOrder, EcommercePaymentAttempt, EcommercePaymentExceptionRefund, LedgerEntry } from "../src/models/index.js";
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
test("refund rollout backfills operation ids, then allows several operations per capture and one capture per operation", async () => {
  const collection = EcommercePaymentExceptionRefund.collection;
  const tenantId = "migration-tenant";
  // The retired order+capture unique index, as v17 had it, with one legacy row of each kind.
  await collection.dropIndexes();
  await collection.createIndex({ tenantId: 1, orderId: 1, paymentAttemptId: 1 }, { unique: true });
  await collection.insertMany([
    { _id: "legacy-return", tenantId, orderId: "o1", paymentAttemptId: "a1", returnRequestId: "r1" },
    { _id: "legacy-cancel", tenantId, orderId: "o1", paymentAttemptId: "a2", cancellationRequestId: "c1" },
    { _id: "legacy-exception", tenantId, orderId: "o1", paymentAttemptId: "a3" },
  ]);
  try {
    await assert.rejects(assertFinancialIndexesReady(), /MIGRATION_REQUIRED/);
    await applyFinancialIndexRollout({ writesPaused: true });
    await applyFinancialIndexRollout({ writesPaused: true }); // idempotent
    await assertFinancialIndexesReady();

    const ids = Object.fromEntries((await collection.find({ tenantId }).toArray()).map((row) => [row._id, row.refundOperationId]));
    assert.deepEqual(ids, {
      "legacy-return": "return:r1",
      "legacy-cancel": "cancel:c1",
      "legacy-exception": "exception:a3",
    });

    const indexNames = (await collection.indexes()).map((index) => index.name);
    assert.ok(indexNames.includes("ecommerce_refund_operation_capture_unique"));
    for (const retired of ["tenantId_1_orderId_1_paymentAttemptId_1", "ecommerce_capture_refund_without_return_unique", "ecommerce_return_refund_unique"]) {
      assert.ok(!indexNames.includes(retired), `${retired} should be retired`);
    }

    // Two different operations on one capture are now fine (this is the excess-advance-then-cancel case).
    await collection.insertMany([
      { _id: "n1", tenantId, orderId: "o2", paymentAttemptId: "adv", refundOperationId: "excess:bk1" },
      { _id: "n2", tenantId, orderId: "o2", paymentAttemptId: "adv", refundOperationId: "cancel:c9" },
      { _id: "n3", tenantId, orderId: "o2", paymentAttemptId: "bal", refundOperationId: "cancel:c9" }, // one operation, two captures
    ]);
    // The same operation on the same capture is a duplicate.
    await assert.rejects(collection.insertOne({ _id: "n4", tenantId, orderId: "o2", paymentAttemptId: "adv", refundOperationId: "cancel:c9" }), { code: 11000 });
  } finally {
    await collection.deleteMany({ tenantId });
    await EcommercePaymentExceptionRefund.syncIndexes();
  }
});
test("attempt index rollout replaces the order-only active index and adds the booking one", async () => {
  const collection = EcommercePaymentAttempt.collection;
  await collection.dropIndex("ecommerce_attempt_active_order_unique");
  await collection.dropIndex("ecommerce_attempt_active_booking_purpose_unique");
  await collection.createIndex({ tenantId: 1, orderId: 1 }, { unique: true, name: "tenantId_1_orderId_1",
    partialFilterExpression: { status: { $in: ["PENDING", "INITIATED"] } } });
  try {
    await assert.rejects(assertFinancialIndexesReady(), /MIGRATION_REQUIRED/);
    await applyFinancialIndexRollout({ writesPaused: true });
    await assertFinancialIndexesReady();
    const names = (await collection.indexes()).map((index) => index.name);
    assert.ok(!names.includes("tenantId_1_orderId_1"));
    assert.ok(names.includes("ecommerce_attempt_active_order_unique"));
    assert.ok(names.includes("ecommerce_attempt_active_booking_purpose_unique"));
  } finally {
    await EcommercePaymentAttempt.syncIndexes();
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
