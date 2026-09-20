import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { SchemeStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  releaseReminderDailyQuota,
  tryClaimReminderDailyQuota,
} from "../src/lib/reminder-daily-quota.js";
import {
  runDefaultingBatch,
  runDueInstallmentBatch,
  runMaturityTransitionBatch,
} from "../src/services/scheme-maintenance.service.js";
import { runReminderScheduler } from "../src/services/reminder-scheduler.service.js";
import { Customer, Message, ReminderDailyQuota, Scheme, Tenant } from "../src/models/index.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("defaulting job uses keyset batches with CAS transitions", async () => {
  const { tenant, branch } = await seedTenantUser();
  const schemes = [];
  for (let i = 0; i < 30; i += 1) {
    schemes.push({
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: `ENR-D-${i}`,
      planSnapshot: {
        paymentPattern: "FIXED",
        benefit: { eligibility: { maxAllowedDefaults: 1 } },
      },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status: SchemeStatus.ACTIVE,
      startDate: "2026-01-01",
      maturityDate: "2026-12-01",
      installments: [
        { number: 1, dueDate: "2026-01-05", status: "OVERDUE", graceEndsAt: "2026-01-01" },
        { number: 2, dueDate: "2026-02-05", status: "OVERDUE", graceEndsAt: "2026-02-01" },
      ],
    });
  }
  await Scheme.insertMany(schemes);
  const batch1 = await runDefaultingBatch({});
  assert.ok(batch1.processed >= 1);
  assert.ok(batch1.processed <= env.SCHEME_MAINTENANCE_BATCH_SIZE);
  const defaulted = await Scheme.countDocuments({ tenantId: tenant._id, status: SchemeStatus.DEFAULTED });
  assert.equal(defaulted, batch1.processed);
  const batch2 = await runDefaultingBatch({ cursor: batch1.cursor });
  assert.equal(batch2.processed, 0);
});

test("maturity batch is idempotent on rerun", async () => {
  const { tenant, branch } = await seedTenantUser();
  const today = "2026-09-19";
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-M-1",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-09-18",
    installments: [],
  });
  const first = await runMaturityTransitionBatch({ today });
  assert.equal(first.processed, 1);
  const second = await runMaturityTransitionBatch({ today });
  assert.equal(second.processed, 0);
});

test("due job transitions PENDING installments idempotently", async () => {
  const { tenant, branch } = await seedTenantUser();
  const today = "2026-09-19";
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-DUE-1",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2027-01-01",
    installments: [
      { number: 1, dueDate: "2026-09-01", amountPaise: 10000, paidPaise: 0, status: "PAID", graceEndsAt: "2026-09-05" },
      { number: 2, dueDate: "2026-09-10", amountPaise: 10000, paidPaise: 0, status: "PENDING", graceEndsAt: "2026-09-15" },
      { number: 3, dueDate: "2026-10-10", amountPaise: 10000, paidPaise: 0, status: "PENDING", graceEndsAt: "2026-10-15" },
    ],
  });
  const first = await runDueInstallmentBatch({ today });
  assert.equal(first.processed, 1);
  const updated = await Scheme.findOne({ enrollmentNumber: "ENR-DUE-1" }).lean();
  assert.equal(updated.installments[1].status, "DUE");
  assert.equal(updated.installments[2].status, "PENDING");
  const second = await runDueInstallmentBatch({ today });
  assert.equal(second.processed, 0);
});

test("concurrent reminder quota claims never exceed daily cap", async () => {
  const tenantId = createId("tenant");
  const customerId = createId("customer");
  const dayYmd = "2026-09-19";
  const cap = 3;
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      tryClaimReminderDailyQuota({
        tenantId,
        customerId,
        channel: "PUSH",
        dayYmd,
        cap,
      }),
    ),
  );
  const allowed = results.filter((row) => row.allowed).length;
  assert.equal(allowed, cap);
  const doc = await ReminderDailyQuota.findById(`${tenantId}:${customerId}:PUSH:${dayYmd}`).lean();
  assert.equal(doc.count, cap);
  await releaseReminderDailyQuota({ tenantId, customerId, channel: "PUSH", dayYmd });
  const after = await ReminderDailyQuota.findById(`${tenantId}:${customerId}:PUSH:${dayYmd}`).lean();
  assert.equal(after.count, cap - 1);
});

test("15000-scheme reminder scan uses bounded batches without monotonic heap growth", {
  skip: process.env.PHASE_EF_SKIP_15K_REMINDER === "1" ? "PHASE_EF_SKIP_15K_REMINDER=1 (use isolated 15k run)" : false,
}, async () => {
  const { connectRedis, disconnectRedis } = await import("../src/config/redis.js");
  const redisOk = await connectRedis();
  assert.ok(redisOk, "Redis required for cross-invocation reminder stream cursors in 15k convergence test");
  try {
  const { tenant, branch } = await seedTenantUser();
  const smallTenant = await Tenant.create({
    _id: createId("tenant"),
    name: "Small Tenant",
    code: `SMALL-${Date.now()}`,
    mobile: "+919700009999",
    status: "ACTIVE",
    settings: {
      reminderConfig: {
        enabled: true,
        offsets: [
          {
            key: "D_DAY",
            days: 0,
            enabled: true,
            messageType: "PAYMENT_DUE",
            schemePattern: "FIXED",
            pushOnly: true,
          },
        ],
        attachPaymentLink: false,
        push: { mirrorWhatsAppTransactional: false },
      },
    },
  });
  const reminderSettings = {
    "settings.reminderConfig.enabled": true,
    "settings.reminderConfig.offsets": [
      {
        key: "D_DAY",
        days: 0,
        enabled: true,
        messageType: "PAYMENT_DUE",
        schemePattern: "FIXED",
        pushOnly: true,
      },
    ],
    "settings.reminderConfig.attachPaymentLink": false,
    "settings.reminderConfig.push.mirrorWhatsAppTransactional": false,
  };
  await Tenant.updateOne({ _id: tenant._id }, { $set: reminderSettings });
  await Tenant.updateOne({ _id: smallTenant._id }, { $set: reminderSettings });

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const schemeBatchCap = env.REMINDER_SCHEME_BATCH_SIZE ?? 100;
  const customerDocs = [];
  const schemeDocs = [];
  const batchInsert = 1000;
  const bigEligible = 14_900;
  for (let i = 0; i < bigEligible; i += 1) {
    const customerId = createId("customer");
    customerDocs.push({
      _id: customerId,
      tenantId: tenant._id,
      branchId: branch._id,
      customerNumber: `C15K-${i}`,
      name: `Customer ${i}`,
      mobile: `+9199${String(i).padStart(8, "0")}`,
    });
    schemeDocs.push({
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId,
      planId: createId("schemePlan"),
      enrollmentNumber: `ENR15K-${i}`,
      planSnapshot: { paymentPattern: "FIXED", paymentRules: { partialPaymentAllowed: true } },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status: SchemeStatus.ACTIVE,
      startDate: "2026-01-01",
      maturityDate: "2027-01-01",
      installments: [
        {
          number: 1,
          dueDate: today,
          amountPaise: 1000,
          paidPaise: 0,
          status: "DUE",
          graceEndsAt: today,
        },
      ],
    });
    if (customerDocs.length >= batchInsert) {
      await Customer.insertMany(customerDocs, { ordered: false });
      await Scheme.insertMany(schemeDocs, { ordered: false });
      customerDocs.length = 0;
      schemeDocs.length = 0;
    }
  }
  for (let i = 0; i < 100; i += 1) {
    const customerId = createId("customer");
    customerDocs.push({
      _id: customerId,
      tenantId: smallTenant._id,
      branchId: branch._id,
      customerNumber: `CSM-${i}`,
      name: `Small ${i}`,
      mobile: `+9188${String(i).padStart(8, "0")}`,
    });
    schemeDocs.push({
      _id: createId("scheme"),
      tenantId: smallTenant._id,
      branchId: branch._id,
      customerId,
      planId: createId("schemePlan"),
      enrollmentNumber: `ENR-SM-${i}`,
      planSnapshot: { paymentPattern: "FIXED", paymentRules: { partialPaymentAllowed: true } },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status: SchemeStatus.ACTIVE,
      startDate: "2026-01-01",
      maturityDate: "2027-01-01",
      installments: [
        {
          number: 1,
          dueDate: today,
          amountPaise: 1000,
          paidPaise: 0,
          status: "DUE",
          graceEndsAt: today,
        },
      ],
    });
  }
  if (customerDocs.length) {
    await Customer.insertMany(customerDocs, { ordered: false });
    await Scheme.insertMany(schemeDocs, { ordered: false });
  }

  const visitedIds = new Set();
  let maxBatchLen = 0;
  const memorySamples = [];
  const sampleMemory = () => {
    const mu = process.memoryUsage();
    memorySamples.push({ heapUsed: mu.heapUsed, rss: mu.rss, external: mu.external });
  };
  const now = new Date(`${today}T12:00:00+05:30`);
  const perTenantCap = env.REMINDER_MAX_SCHEMES_PER_TENANT_PER_RUN ?? 500;
  sampleMemory();
  let runs = 0;
  let lastRun = null;
  let smallTenantProgress = false;
  const eligibleTotal = bigEligible + 100;
  while (visitedIds.size < eligibleTotal && runs < 500) {
    runs += 1;
    const beforeUnique = visitedIds.size;
    const runVisited = new Set();
    lastRun = await runReminderScheduler(now, {
      onSchemeBatch: ({ schemeIds }) => {
        assert.ok(schemeIds.length <= schemeBatchCap, "scheme batch exceeded REMINDER_SCHEME_BATCH_SIZE");
        maxBatchLen = Math.max(maxBatchLen, schemeIds.length);
        for (const id of schemeIds) {
          assert.ok(!runVisited.has(id), "keyset pagination revisited a scheme within one invocation");
          runVisited.add(id);
          visitedIds.add(id);
        }
        if (visitedIds.size % 5000 === 0) sampleMemory();
      },
    });
    assert.ok(
      lastRun.schemesVisited <= perTenantCap * Math.max(1, lastRun.tenantsProcessed),
      "single invocation exceeded per-tenant scheme cap",
    );
    if (lastRun.tenantsProcessed >= 2 && lastRun.messagesQueued > 0) smallTenantProgress = true;
    if (lastRun.schemesVisited === 0 && lastRun.remainingBacklog === 0) break;
    assert.ok(
      visitedIds.size > beforeUnique || lastRun.continuationScheduled > 0,
      "bounded reminder run made no unique progress — check Redis stream cursor persistence",
    );
  }
  sampleMemory();

  assert.equal(visitedIds.size, eligibleTotal);
  assert.ok(maxBatchLen > 0 && maxBatchLen <= schemeBatchCap);
  assert.ok(smallTenantProgress, "small tenant must receive progress before large tenant fully converges");
  assert.ok(runs > 1, "bounded per-invocation processing requires multiple scheduler runs to converge");

  const messagesFirst = await Message.countDocuments({ type: "PAYMENT_DUE" });
  assert.equal(messagesFirst, eligibleTotal);

  const [concurrentA, concurrentB] = await Promise.all([
    runReminderScheduler(now),
    runReminderScheduler(now),
  ]);
  assert.ok(
    concurrentA.messagesQueued === 0 || concurrentB.messagesQueued === 0,
    "concurrent scheduler replicas must respect lease / dedupe",
  );
  const messagesAfterConcurrent = await Message.countDocuments({ type: "PAYMENT_DUE" });
  assert.equal(messagesAfterConcurrent, messagesFirst);

  await runReminderScheduler(now);
  const messagesAfterRerun = await Message.countDocuments({ type: "PAYMENT_DUE" });
  assert.equal(messagesAfterRerun, messagesFirst, "idempotent rerun must not duplicate reminders");

  const heapValues = memorySamples.map((row) => row.heapUsed);
  const rssValues = memorySamples.map((row) => row.rss);
  const heapDeltaMb = (Math.max(...heapValues) - Math.min(...heapValues)) / (1024 * 1024);
  const rssDeltaMb = (Math.max(...rssValues) - Math.min(...rssValues)) / (1024 * 1024);
  assert.ok(heapDeltaMb < 400, `heap swing ${heapDeltaMb.toFixed(1)}MB — expected bounded batches`);
  assert.ok(rssDeltaMb < 600, `rss swing ${rssDeltaMb.toFixed(1)}MB — expected bounded RSS`);
  test.context = {
    closure15k: {
      schedulerRuns: runs,
      schemesVisited: visitedIds.size,
      messagesQueued: messagesFirst,
      maxBatchLen,
      heapDeltaMb,
      rssDeltaMb,
      memorySampleCount: memorySamples.length,
    },
  };
  } finally {
    await disconnectRedis().catch(() => {});
  }
});

test("maintenance batches converge maturity, defaulting, and flexible expiry", async () => {
  const { tenant, branch } = await seedTenantUser();
  const today = "2026-09-19";
  const { runExpireFlexibleCapacityBatch, runMaturityTransitionBatch } =
    await import("../src/services/scheme-maintenance.service.js");
  await Scheme.insertMany([
    {
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: "CONV-MAT",
      planSnapshot: { paymentPattern: "FIXED" },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status: SchemeStatus.ACTIVE,
      startDate: "2026-01-01",
      maturityDate: "2026-09-18",
      installments: [],
    },
    {
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: "CONV-FLX",
      planSnapshot: { paymentPattern: "FLEXIBLE" },
      valueBasis: "CASH",
      paymentPattern: "FLEXIBLE",
      flexiblePhase: "FLEXIBLE",
      status: SchemeStatus.ACTIVE,
      startDate: "2026-01-01",
      maturityDate: "2027-01-01",
      cycles: [{ expiresAt: "2026-09-01", status: "UPCOMING", remainingPaise: 500 }],
      installments: [],
    },
  ]);
  const mat = await runMaturityTransitionBatch({ today });
  assert.equal(mat.processed, 1);
  const flex = await runExpireFlexibleCapacityBatch({ today });
  assert.equal(flex.processed, 1);
  const def = await runDefaultingBatch({});
  assert.ok(def.processed >= 0);
});
