import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { env } from "../src/config/env.js";
import { connectRedis, disconnectRedis, getRedis } from "../src/config/redis.js";
import { JobStatus, PaymentIntentStatus, SchemeStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  acquireReminderSchedulerLease,
  refreshReminderSchedulerLease,
  reminderLeaseKey,
} from "../src/lib/reminder-scheduler-lease.js";
import { OpsMetric, getOpsMetricsSnapshot, resetOpsMetricsForTests } from "../src/lib/ops-metrics.js";
import { Customer, PaymentIntent, Scheme, Tenant, WebhookEvent } from "../src/models/index.js";
import { runPaymentExpiry } from "../src/services/payment-expiry.service.js";
import { reclaimExpiredWebhookLeases } from "../src/services/webhook-event.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  const probe = new IORedis(env.REDIS_URL, { connectTimeout: 1500, maxRetriesPerRequest: 1, lazyConnect: true });
  await probe.connect();
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
  resetOpsMetricsForTests();
});

test("payment expiry respects batch and max-batches per invocation", async () => {
  const now = new Date();
  const past = new Date(now.getTime() - 60_000);
  const tenantId = createId("tenant");
  const docs = Array.from({ length: 150 }, () => ({
    _id: createId("paymentIntent"),
    tenantId,
    branchId: createId("branch"),
    schemeId: createId("scheme"),
    customerId: createId("customer"),
    targetCycle: "2026-09",
    status: PaymentIntentStatus.PENDING,
    reservationExpiresAt: past,
    amountPaise: 100,
    positionVersion: 1,
    version: 1,
  }));
  await PaymentIntent.insertMany(docs);
  const batchSize = env.PAYMENT_EXPIRY_BATCH_SIZE ?? 100;
  const maxBatches = env.PAYMENT_EXPIRY_MAX_BATCHES_PER_RUN ?? 20;
  const result = await runPaymentExpiry(now);
  assert.ok(result.processed <= batchSize * maxBatches);
  assert.ok(result.expired >= 1);
  if (docs.length > batchSize * maxBatches) {
    assert.equal(result.remainingBacklog, 1);
  }
});

test("webhook reclaim is bounded and concurrent-safe", async () => {
  const tenantId = createId("tenant");
  const past = new Date(Date.now() - 1000);
  await WebhookEvent.insertMany(
    Array.from({ length: 12 }, () => ({
      _id: createId("webhook"),
      tenantId,
      provider: "PHONEPE",
      providerEventId: `evt_${createId("webhook")}`,
      payload: {},
      status: JobStatus.PROCESSING,
      leaseOwner: "stale",
      leaseExpiresAt: past,
    })),
  );
  const [a, b] = await Promise.all([reclaimExpiredWebhookLeases(), reclaimExpiredWebhookLeases()]);
  const totalReclaimed = a.reclaimed + b.reclaimed;
  assert.ok(totalReclaimed <= 12);
  assert.equal(totalReclaimed, 12);
  assert.ok(a.conflicted + b.conflicted >= 0);
});

test("reminder lease refresh fails when ownership is lost", async () => {
  const tenantId = createId("tenant");
  const today = "2026-09-19";
  const windowKey = "09:00-20:00";
  const token = await acquireReminderSchedulerLease({ tenantId, today, windowKey });
  assert.ok(token);
  const key = reminderLeaseKey({ tenantId, today, windowKey });
  await getRedis().set(key, "intruder", "PX", 60_000);
  const renewed = await refreshReminderSchedulerLease({ tenantId, today, windowKey, token });
  assert.equal(renewed, false);
});

test("reminder scheduler invocation caps schemes per tenant", async () => {
  const { runReminderScheduler } = await import("../src/services/reminder-scheduler.service.js");
  const perTenantCap = env.REMINDER_MAX_SCHEMES_PER_TENANT_PER_RUN ?? 500;
  const { tenant, branch } = await seedTenantUser();
  const today = "2026-09-19";
  await Tenant.updateOne({ _id: tenant._id }, {
    $set: {
      "settings.reminderConfig.enabled": true,
      "settings.reminderConfig.offsets": [{
        key: "D_DAY", days: 0, enabled: true, messageType: "PAYMENT_DUE", schemePattern: "FIXED", pushOnly: true,
      }],
      "settings.reminderConfig.attachPaymentLink": false,
    },
  });
  const bulk = [];
  const customers = [];
  for (let i = 0; i < perTenantCap + 120; i += 1) {
    const customerId = createId("customer");
    customers.push({
      _id: customerId,
      tenantId: tenant._id,
      branchId: branch._id,
      customerNumber: `BC-${i}`,
      name: `C ${i}`,
      mobile: `+9177${String(i).padStart(8, "0")}`,
    });
    bulk.push({
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId,
      planId: createId("schemePlan"),
      enrollmentNumber: `BND-${i}`,
      planSnapshot: { paymentPattern: "FIXED" },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status: SchemeStatus.ACTIVE,
      startDate: "2026-01-01",
      maturityDate: "2027-01-01",
      installments: [{ number: 1, dueDate: today, status: "DUE", graceEndsAt: today }],
    });
  }
  await Customer.insertMany(customers);
  await Scheme.insertMany(bulk);
  const now = new Date(`${today}T12:00:00+05:30`);
  const first = await runReminderScheduler(now);
  assert.ok(first.schemesVisited <= perTenantCap);
  assert.ok(first.remainingBacklog >= 1 || first.continuationScheduled >= 1);
  const visited = new Set();
  const second = await runReminderScheduler(now, {
    onSchemeBatch: ({ schemeIds }) => schemeIds.forEach((id) => visited.add(id)),
  });
  assert.ok(first.schemesVisited + second.schemesVisited >= 80);
  const metrics = getOpsMetricsSnapshot().counters;
  assert.ok(metrics[OpsMetric.REMINDER_CONTINUATION_SCHEDULED] >= 1);
});
