import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { env } from "../src/config/env.js";
import { connectRedis, disconnectRedis, getRedis } from "../src/config/redis.js";
import {
  FlexiblePhase,
  PaymentIntentStatus,
  PaymentMode,
  PaymentStatus,
  SchemeStatus,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { armMockOrderStatusTemplate } from "../src/lib/phonepe-provider-test-hooks.js";
import {
  MaintenanceScanStream,
  clearMaintenanceScanCursor,
  clearMaintenanceScanLease,
  maintenanceScanCursorRedisKey,
  readMaintenanceScanCursor,
  runRotatingMaintenanceScan,
} from "../src/lib/maintenance-scan-cursor.js";
import { AuditEvent, Message, Payment, PaymentIntent, PaymentLink, Scheme } from "../src/models/index.js";
import { runPaymentExpiry } from "../src/services/payment-expiry.service.js";
import {
  runDefaultingMaintenance,
  runFlexibleLockMaintenance,
} from "../src/services/scheme-maintenance.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  const probe = new IORedis(env.REDIS_URL, { connectTimeout: 1500, maxRetriesPerRequest: 1, lazyConnect: true });
  await probe.connect();
  await probe.ping();
  await probe.quit();
  await connectRedis();
  await startTestDb();
});
test.after(async () => {
  await disconnectRedis().catch(() => {});
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  for (const stream of Object.values(MaintenanceScanStream)) {
    await clearMaintenanceScanCursor(stream);
    await clearMaintenanceScanLease(stream);
  }
});

function installment(overdue) {
  return [
    { number: 1, dueDate: "2025-01-05", amountPaise: 10000, paidPaise: overdue ? 0 : 10000, status: overdue ? "OVERDUE" : "PAID", graceEndsAt: "2025-01-10" },
    { number: 2, dueDate: "2025-02-05", amountPaise: 10000, paidPaise: overdue ? 0 : 10000, status: overdue ? "OVERDUE" : "PAID", graceEndsAt: "2025-02-10" },
  ];
}

async function seedDefaultingMatrix({ tenant, branch, user, ineligibleFirst, eligibleCount }) {
  const docs = [];
  for (let i = 0; i < ineligibleFirst; i += 1) {
    docs.push({
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: `ENR-INEL-${i}`,
      planSnapshot: { paymentPattern: "FIXED", benefit: { eligibility: { maxAllowedDefaults: 2 } } },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status: SchemeStatus.ACTIVE,
      startDate: "2025-01-01",
      maturityDate: "2025-12-01",
      installmentAmountPaise: 10000,
      installments: installment(false),
      version: 1,
      createdBy: user._id,
    });
  }
  for (let i = 0; i < eligibleCount; i += 1) {
    docs.push({
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: `ENR-DEF-${i}`,
      planSnapshot: { paymentPattern: "FIXED", benefit: { eligibility: { maxAllowedDefaults: 1 } } },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status: SchemeStatus.ACTIVE,
      startDate: "2025-01-01",
      maturityDate: "2025-12-01",
      installmentAmountPaise: 10000,
      installments: installment(true),
      version: 1,
      createdBy: user._id,
    });
  }
  await Scheme.insertMany(docs);
  return docs;
}

test("defaulting cross-run rotation reaches eligible schemes beyond ineligible prefix", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  await seedDefaultingMatrix({ tenant, branch, user, ineligibleFirst: 6, eligibleCount: 4 });
  const limits = { maxBatches: 2, batchSize: 3 };
  const run1 = await runDefaultingMaintenance(limits);
  assert.ok(run1.scanned >= 3);
  const run2 = await runDefaultingMaintenance(limits);
  const totalDefaulted = await Scheme.countDocuments({ tenantId: tenant._id, status: SchemeStatus.DEFAULTED });
  assert.equal(totalDefaulted, 4);
  assert.equal(await AuditEvent.countDocuments({ action: "SCHEME_DEFAULTED" }), 4);
  const rerun = await runDefaultingMaintenance(limits);
  assert.equal(rerun.processed, 0);
  assert.equal(await AuditEvent.countDocuments({ action: "SCHEME_DEFAULTED" }), 4);
  assert.ok(run1.continuationScheduled || run2.continuationScheduled || run2.wrapped);
});

test("defaulting natural wrap processes scheme that becomes eligible after wrap", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const docs = await seedDefaultingMatrix({ tenant, branch, user, ineligibleFirst: 8, eligibleCount: 2 });
  const earlyIneligible = docs[0];
  const limits = { maxBatches: 2, batchSize: 3 };
  let sawWrap = false;
  for (let i = 0; i < 12; i += 1) {
    const run = await runDefaultingMaintenance(limits);
    assert.ok(run.scanned <= limits.maxBatches * limits.batchSize);
    assert.ok(run.batchesRun <= limits.maxBatches);
    if (run.wrapped) sawWrap = true;
    const defaulted = await Scheme.countDocuments({ tenantId: tenant._id, status: SchemeStatus.DEFAULTED });
    if (defaulted === 2) break;
  }
  assert.ok(sawWrap, "expected natural cursor wrap without manual cursor reset");
  await Scheme.updateOne(
    { _id: earlyIneligible._id },
    {
      $set: {
        installments: installment(true),
        planSnapshot: { paymentPattern: "FIXED", benefit: { eligibility: { maxAllowedDefaults: 1 } } },
      },
    },
  );
  for (let i = 0; i < 12; i += 1) {
    const run = await runDefaultingMaintenance(limits);
    assert.ok(run.scanned <= limits.maxBatches * limits.batchSize);
    const row = await Scheme.findById(earlyIneligible._id).lean();
    if (row.status === SchemeStatus.DEFAULTED) break;
    if (run.leaseBusy) continue;
  }
  const earlyRow = await Scheme.findById(earlyIneligible._id).lean();
  assert.equal(earlyRow.status, SchemeStatus.DEFAULTED);
  assert.equal(await AuditEvent.countDocuments({ action: "SCHEME_DEFAULTED", entityId: earlyIneligible._id }), 1);
});

test("flexible-lock cross-run rotation locks due schemes beyond not-yet-due prefix", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const today = "2025-06-01";
  const flexRules = {
    flexiblePhaseCycles: 1,
    averagingDivisor: 1,
    flexiblePhase: { minTotalPaise: 0 },
    capComputation: {
      roundToNearestPaise: 100,
      minCycleCapPaise: 10000,
      maxCycleCapPaise: 500000,
      onZeroFlexiblePhaseTotal: "USE_MINIMUM",
      onBelowMinimumTotal: "USE_MINIMUM",
    },
  };
  const schemes = [];
  for (let i = 0; i < 5; i += 1) {
    schemes.push({
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: customer._id,
      planId: createId("schemePlan"),
      enrollmentNumber: `ENR-FUT-${i}`,
      planSnapshot: { paymentPattern: "FLEXIBLE", flexibleRules: flexRules },
      valueBasis: "CASH",
      paymentPattern: "FLEXIBLE",
      flexiblePhase: FlexiblePhase.FLEXIBLE,
      status: SchemeStatus.ACTIVE,
      startDate: "2025-08-01",
      maturityDate: "2026-12-01",
      cycles: [{ cycle: "2025-08", capPaise: 0, paidPaise: 50000, remainingPaise: 0, status: "PAID", expiresAt: "2025-08-31" }],
      version: 1,
      createdBy: user._id,
    });
  }
  for (let i = 0; i < 3; i += 1) {
    schemes.push({
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: customer._id,
      planId: createId("schemePlan"),
      enrollmentNumber: `ENR-DUE-${i}`,
      planSnapshot: { paymentPattern: "FLEXIBLE", flexibleRules: flexRules },
      valueBasis: "CASH",
      paymentPattern: "FLEXIBLE",
      flexiblePhase: FlexiblePhase.FLEXIBLE,
      status: SchemeStatus.ACTIVE,
      startDate: "2024-01-01",
      maturityDate: "2026-12-01",
      cycles: [{ cycle: "2024-01", capPaise: 0, paidPaise: 50000, remainingPaise: 0, status: "PAID", expiresAt: "2024-01-31" }],
      version: 1,
      createdBy: user._id,
    });
  }
  await Scheme.insertMany(schemes);
  await runFlexibleLockMaintenance({ today, maxBatches: 1, batchSize: 4 });
  await runFlexibleLockMaintenance({ today, maxBatches: 2, batchSize: 4 });
  const dueCapped = await Scheme.countDocuments({
    tenantId: tenant._id,
    enrollmentNumber: /^ENR-DUE-/,
    flexiblePhase: FlexiblePhase.CAPPED,
  });
  assert.equal(dueCapped, 3);
  const futureOpen = await Scheme.countDocuments({
    tenantId: tenant._id,
    enrollmentNumber: /^ENR-FUT-/,
    flexiblePhase: FlexiblePhase.FLEXIBLE,
  });
  assert.equal(futureOpen, 5);
  const notificationsAfterTwoRuns = await Message.countDocuments({
    tenantId: tenant._id,
    type: "FLEXI_LOCK_APPLIED",
  });
  assert.ok(notificationsAfterTwoRuns >= 3);
  await runFlexibleLockMaintenance({ today, maxBatches: 1, batchSize: 4 });
  assert.equal(
    await Message.countDocuments({ tenantId: tenant._id, type: "FLEXI_LOCK_APPLIED" }),
    notificationsAfterTwoRuns,
    "idempotent rerun must not duplicate lock notifications",
  );
});

async function seedGatewayDeferredIntent({ tenantId, branchId, suffix = "" }) {
  const paymentId = createId("payment");
  const intentId = createId("paymentIntent");
  if (suffix) armMockOrderStatusTemplate(intentId, suffix);
  await Payment.create({
    _id: paymentId,
    tenantId,
    branchId,
    schemeId: createId("scheme"),
    customerId: createId("customer"),
    receiptNumber: `EXP-${intentId}`,
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(Date.now() - 3600_000),
  });
  return { paymentId, intentId };
}

test("payment expiry converges past deferred gateway intents to trailing ordinary intents", async () => {
  assert.equal(env.PROVIDER_MODE, "mock");
  const now = new Date();
  const past = new Date(now.getTime() - 60_000);
  const tenantId = createId("tenant");
  const branchId = createId("branch");
  const docs = [];
  for (let i = 0; i < 6; i += 1) {
    const { paymentId, intentId } = await seedGatewayDeferredIntent({ tenantId, branchId });
    docs.push({
      _id: intentId,
      tenantId,
      branchId,
      schemeId: createId("scheme"),
      customerId: createId("customer"),
      targetCycle: "2026-09",
      status: PaymentIntentStatus.PENDING,
      reservationExpiresAt: past,
      amountPaise: 100,
      positionVersion: 1,
      paymentId,
      version: 1,
    });
  }
  for (let i = 0; i < 5; i += 1) {
    docs.push({
      _id: createId("paymentIntent"),
      tenantId,
      branchId,
      schemeId: createId("scheme"),
      customerId: createId("customer"),
      targetCycle: "2026-09",
      status: PaymentIntentStatus.PENDING,
      reservationExpiresAt: past,
      amountPaise: 100,
      positionVersion: 1,
      version: 1,
    });
  }
  await PaymentIntent.insertMany(docs);
  const limits = { maxBatches: 1, batchSize: 3 };
  for (let i = 0; i < 10; i += 1) {
    const run = await runPaymentExpiry(now, limits);
    assert.ok(run.intentRotation.scanned <= limits.maxBatches * limits.batchSize);
    const expiredOrdinary = await PaymentIntent.countDocuments({
      tenantId,
      status: PaymentIntentStatus.EXPIRED,
      paymentId: { $exists: false },
    });
    if (expiredOrdinary === 5) break;
    if (run.intentRotation.leaseBusy) continue;
  }
  const deferredGateway = await PaymentIntent.countDocuments({
    tenantId,
    paymentId: { $exists: true, $ne: null },
    status: PaymentIntentStatus.PENDING,
  });
  assert.equal(deferredGateway, 6);
  assert.equal(
    await PaymentIntent.countDocuments({ tenantId, status: PaymentIntentStatus.EXPIRED, paymentId: { $exists: false } }),
    5,
  );
  const pendingPayments = await Payment.countDocuments({ tenantId, status: PaymentStatus.PENDING, mode: PaymentMode.ONLINE_GATEWAY });
  assert.equal(pendingPayments, 6);
  const rerun = await runPaymentExpiry(now, limits);
  assert.equal(
    await PaymentIntent.countDocuments({ tenantId, status: PaymentIntentStatus.EXPIRED, paymentId: { $exists: false } }),
    5,
    "idempotent rerun must not duplicate ordinary expiries",
  );
  assert.ok(rerun.intentRotation.batchesRun <= limits.maxBatches);
});

test("payment link expiry converges independently from intent cursor", async () => {
  assert.equal(env.PROVIDER_MODE, "mock");
  const now = new Date();
  const past = new Date(now.getTime() - 60_000);
  const tenantId = createId("tenant");
  const branchId = createId("branch");
  const links = [];
  for (let i = 0; i < 4; i += 1) {
    const paymentId = createId("payment");
    await Payment.create({
      _id: paymentId,
      tenantId,
      branchId,
      schemeId: createId("scheme"),
      customerId: createId("customer"),
      receiptNumber: `LNK-${i}`,
      amountPaise: 10_000,
      mode: PaymentMode.ONLINE_GATEWAY,
      status: PaymentStatus.PENDING,
      source: "CUSTOMER_APP",
      paidAt: new Date(Date.now() - 3600_000),
    });
    links.push({
      _id: createId("paymentLink"),
      tenantId,
      branchId,
      schemeId: createId("scheme"),
      customerId: createId("customer"),
      tokenHash: `hash-deferred-${i}-${Date.now()}`,
      amountPaise: 10_000,
      status: "CREATED",
      expiresAt: past,
      paymentId,
    });
  }
  for (let i = 0; i < 3; i += 1) {
    links.push({
      _id: createId("paymentLink"),
      tenantId,
      branchId,
      schemeId: createId("scheme"),
      customerId: createId("customer"),
      tokenHash: `hash-plain-${i}-${Date.now()}`,
      amountPaise: 10_000,
      status: "CREATED",
      expiresAt: past,
    });
  }
  await PaymentLink.insertMany(links);
  await getRedis().set(maintenanceScanCursorRedisKey(MaintenanceScanStream.PAYMENT_EXPIRY_INTENT), "pmi_01BLOCK000000001", "EX", 60);
  const limits = { maxBatches: 1, batchSize: 2 };
  for (let i = 0; i < 12; i += 1) {
    const run = await runPaymentExpiry(now, limits);
    assert.ok(run.linkRotation.scanned <= limits.maxBatches * limits.batchSize);
    const expiredLinks = await PaymentLink.countDocuments({ tenantId, status: "EXPIRED", paymentId: { $exists: false } });
    if (expiredLinks === 3) break;
    if (run.linkRotation.leaseBusy) continue;
  }
  assert.equal(await PaymentLink.countDocuments({ tenantId, status: "EXPIRED", paymentId: { $exists: false } }), 3);
  assert.equal(await PaymentLink.countDocuments({ tenantId, status: "CREATED", paymentId: { $exists: true } }), 4);
  assert.notEqual(
    maintenanceScanCursorRedisKey(MaintenanceScanStream.PAYMENT_EXPIRY_INTENT),
    maintenanceScanCursorRedisKey(MaintenanceScanStream.PAYMENT_EXPIRY_LINK),
  );
});

test("maintenance cursor survives separate invocations and recovers invalid values", async () => {
  const stream = MaintenanceScanStream.DEFAULTING;
  await getRedis().set(maintenanceScanCursorRedisKey(stream), "not-a-valid-id", "EX", 60);
  const recovered = await readMaintenanceScanCursor(stream);
  assert.equal(recovered.cursor, null);
  assert.ok(recovered.recoveredInvalid);
  let cursorLog = [];
  await runRotatingMaintenanceScan({
    stream,
    maxBatches: 2,
    runBatch: async (cursor) => {
      cursorLog.push(cursor);
      if (cursorLog.length === 1) {
        return { processed: 0, scanned: 2, skipped: 2, lastCursor: "sch_01TEST0000000001", hasMore: true };
      }
      return { processed: 0, scanned: 0, skipped: 0, hasMore: false };
    },
  });
  const stored = await readMaintenanceScanCursor(stream);
  assert.equal(stored.cursor, null);
  assert.deepEqual(cursorLog, [null, "sch_01TEST0000000001"]);
});

