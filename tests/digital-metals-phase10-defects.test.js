import test from "node:test";
import assert from "node:assert/strict";
import { MessageType } from "../src/constants/enums.js";
import { DIGITAL_METAL_OUTBOX_TOPICS } from "../src/lib/digital-metals-outbox.js";
import {
  classifyDigitalMetalOutboxDispatchOutcome,
  DISPATCH_COMPLETED,
  DISPATCH_RETRYABLE,
  DISPATCH_SKIPPED,
  DISPATCH_TERMINAL,
} from "../src/lib/digital-metals-outbox-dispatch-outcomes.js";
import { runDigitalMetalOutboxDispatch } from "../src/services/digital-metals-outbox-dispatch.service.js";
import { deliverDigitalMetalCustomerPushNotice } from "../src/lib/digital-metals-inbox-notify.js";
import { digitalMetalInboxEventKey } from "../src/lib/digital-metals-customer-notice.js";
import {
  DigitalMetalBuyOrder,
  DigitalMetalOutboxEvent,
  Message,
  PushDeviceDelivery,
} from "../src/models/index.js";
import { reconcileMissingDigitalMetalNotificationIntents } from "../src/services/digital-metals-notification-intent-reconcile.service.js";
import { DevicePrincipalType, PushDeviceDeliveryStatus } from "../src/constants/enums.js";
import { ensurePushDeliveries } from "../src/services/push-delivery.service.js";
import { registerFcmDevice } from "../src/services/device-registration.service.js";
import { bulkResendMessages, resendMessage } from "../src/services/messaging.service.js";
import { resolveUnknownPayout } from "../src/services/digital-metals-payout.service.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("dispatch classification: disposition sets are exhaustive and mutually exclusive", () => {
  const all = [
    ...DISPATCH_COMPLETED,
    ...DISPATCH_SKIPPED,
    ...DISPATCH_RETRYABLE,
    ...DISPATCH_TERMINAL,
  ];
  assert.equal(new Set(all).size, all.length, "outcome must belong to exactly one disposition set");
  for (const outcome of all) {
    const c = classifyDigitalMetalOutboxDispatchOutcome({ outcome });
    assert.ok(["COMPLETED", "SKIPPED", "RETRYABLE", "TERMINAL"].includes(c.disposition));
    const buckets = [
      DISPATCH_COMPLETED.has(outcome) && "COMPLETED",
      DISPATCH_SKIPPED.has(outcome) && "SKIPPED",
      DISPATCH_RETRYABLE.has(outcome) && "RETRYABLE",
      DISPATCH_TERMINAL.has(outcome) && "TERMINAL",
    ].filter(Boolean);
    assert.equal(buckets.length, 1);
    assert.equal(c.disposition, buckets[0]);
  }
});

test("dispatch classification: SKIPPED outcomes are mutually exclusive from COMPLETED", () => {
  for (const outcome of ["ALREADY_NOTIFIED", "NO_DELIVERY_CHANNEL", "SKIPPED_SUPERSEDED"]) {
    const c = classifyDigitalMetalOutboxDispatchOutcome({ outcome });
    assert.equal(c.disposition, "SKIPPED");
    assert.equal(c.retryable, false);
    assert.equal(c.terminal, false);
  }
  const queued = classifyDigitalMetalOutboxDispatchOutcome({ outcome: "QUEUED" });
  assert.equal(queued.disposition, "COMPLETED");
  const retry = classifyDigitalMetalOutboxDispatchOutcome({ outcome: "QUEUE_FAILED" });
  assert.equal(retry.disposition, "RETRYABLE");
  const terminal = classifyDigitalMetalOutboxDispatchOutcome({ outcome: "INVALID_PAYLOAD" });
  assert.equal(terminal.disposition, "TERMINAL");
});

test("intent repair cursor advances past first 25 repaired to reach later missing intents (60 orders)", async () => {
  const { tenant } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: null });
  const base = new Date("2026-01-01T00:00:00.000Z");
  const orders = [];
  for (let i = 0; i < 60; i += 1) {
    const id = createId("dmbo");
    orders.push({
      _id: id,
      tenantId: tenant._id,
      customerId: customer._id,
      branchId: null,
      quoteId: createId("dmq"),
      status: "CREDITED",
      snapshot: {},
      metal: "GOLD",
      finenessPpm: 999000,
      quantityUg: 1000,
      totalPayablePaise: 100_000,
      quoteExpiresAt: new Date(),
      paymentAcceptanceExpiresAt: new Date(),
      termsAcceptedAt: new Date(),
      idempotencyKey: `idem-${i}`,
      creditedAt: new Date(base.getTime() + i * 60_000),
    });
  }
  await DigitalMetalBuyOrder.insertMany(orders);

  for (let i = 0; i < 25; i += 1) {
    const order = orders[i];
    await DigitalMetalOutboxEvent.create({
      _id: createId("dmobx"),
      tenantId: tenant._id,
      topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
      key: order._id,
      payload: { orderId: order._id, customerId: customer._id },
      status: "PROCESSED",
    });
    await DigitalMetalBuyOrder.updateOne(
      { _id: order._id },
      { $set: { purchaseCreditedNoticeEnqueuedAt: new Date() } },
    );
  }

  let repairedTotal = 0;
  for (let run = 0; run < 10; run += 1) {
    const r = await reconcileMissingDigitalMetalNotificationIntents({ limit: 25 });
    repairedTotal +=
      r.counts.buyCredited +
      r.counts.sellExecuted +
      r.counts.documentReady +
      r.counts.redemptionChargePaid +
      r.counts.payoutNotice +
      r.counts.markersRepaired;
    if (r.counts.buyCredited === 0 && run > 0) break;
  }

  const missing = await DigitalMetalOutboxEvent.countDocuments({
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
  });
  assert.equal(missing, 60);
  assert.ok(repairedTotal >= 35);
});

test("outbox dispatcher persists SKIPPED disposition without implying delivery (real Mongo)", async () => {
  const { tenant } = await seedTenantUser({});
  const { Tenant } = await import("../src/models/index.js");
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "settings.reminderConfig.push.enabled": false } },
  );
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: null });
  const orderId = createId("dmbo");
  const eventId = createId("dmobx");
  await DigitalMetalBuyOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    branchId: null,
    quoteId: createId("dmq"),
    status: "CREDITED",
    snapshot: {},
    metal: "GOLD",
    finenessPpm: 999000,
    quantityUg: 1000,
    totalPayablePaise: 100_000,
    quoteExpiresAt: new Date(),
    paymentAcceptanceExpiresAt: new Date(),
    termsAcceptedAt: new Date(),
    idempotencyKey: "skip-dispatch-idem",
    creditedAt: new Date(),
  });
  await DigitalMetalOutboxEvent.create({
    _id: eventId,
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
    key: orderId,
    payload: { orderId, customerId: customer._id },
    status: "PENDING",
    availableAt: new Date(0),
  });
  await runDigitalMetalOutboxDispatch(new Date());
  const row = await DigitalMetalOutboxEvent.findById(eventId).lean();
  assert.equal(row.status, "PROCESSED");
  assert.equal(row.processedDisposition, "SKIPPED");
  assert.equal(row.processedSkipReason, "NO_DELIVERY_CHANNEL");
  assert.equal(row.processedOutcome, "NO_DELIVERY_CHANNEL");
  assert.equal(await Message.countDocuments({ tenantId: tenant._id }), 0);
});

test("deliverDigitalMetalCustomerPushNotice duplicate inbox key returns ALREADY_NOTIFIED (transactional wrapper)", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const { Tenant } = await import("../src/models/index.js");
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "settings.reminderConfig.push.enabled": true,
        "settings.reminderConfig.types.DIGITAL_METAL_PURCHASE_CREDITED": { push: true },
      },
    },
  );
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const inboxEventKey = digitalMetalInboxEventKey("purchase.credited", "dmbo_tx");
  const first = await deliverDigitalMetalCustomerPushNotice({
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    type: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    inboxEventKey,
    templateParams: { title: "t", body: "b", deepLink: "/x" },
  });
  assert.equal(first.outcome, "QUEUED");
  const second = await deliverDigitalMetalCustomerPushNotice({
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    type: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    inboxEventKey,
    templateParams: { title: "t2", body: "b2", deepLink: "/x" },
  });
  assert.equal(second.outcome, "ALREADY_NOTIFIED");
  assert.equal(
    await Message.countDocuments({ tenantId: tenant._id, "templateParams.inboxEventKey": inboxEventKey }),
    1,
  );
});

test("resendMessage retries logical PUSH inbox row without duplicate Message", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const inboxEventKey = "digital_metal.test:resend";
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_defect_resend",
    platform: "android",
    fcmToken: "token-defect-resend",
  });
  const msg = await Message.create({
    _id: createId("message"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    type: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    status: "FAILED",
    channel: "PUSH",
    templateKey: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    reminderDedupeKey: inboxEventKey,
    templateParams: { inboxEventKey, title: "t", body: "b" },
  });
  await ensurePushDeliveries({
    tenantId: tenant._id,
    messageId: msg._id,
    devices: [{ deviceRegistrationId: reg._id, tokenHash: "h" }],
  });
  await PushDeviceDelivery.updateOne(
    { tenantId: tenant._id, messageId: msg._id },
    { $set: { status: PushDeviceDeliveryStatus.DEAD_LETTER, attemptCount: 3 } },
  );
  const ctx = {
    auth: { id: user._id, tenantId: tenant._id, role: user.role },
    scope: { tenantId: tenant._id, branchId: branch._id },
    headers: {},
    ip: "127.0.0.1",
    params: { messageId: msg._id },
  };
  const resent = await resendMessage(ctx);
  assert.equal(resent.status, "QUEUED");
  assert.equal(resent.resendOutcome, "RETRY_SCHEDULED");
  assert.equal(await Message.countDocuments({ tenantId: tenant._id, reminderDedupeKey: inboxEventKey }), 1);
});

test("bulkResendMessages re-queues logical rows without duplicate Message (real Mongo)", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const inboxEventKey = "digital_metal.test:bulk";
  const msg = await Message.create({
    _id: createId("message"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    type: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    status: "FAILED",
    channel: "PUSH",
    templateKey: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    reminderDedupeKey: inboxEventKey,
    templateParams: { inboxEventKey, title: "t", body: "b" },
  });
  const ctx = {
    auth: { id: user._id, tenantId: tenant._id, role: user.role },
    scope: { tenantId: tenant._id, branchId: branch._id },
    headers: {},
    ip: "127.0.0.1",
    body: { messageIds: [msg._id] },
  };
  const bulk = await bulkResendMessages(ctx);
  assert.equal(bulk.queued, 1);
  assert.equal(await Message.countDocuments({ tenantId: tenant._id, reminderDedupeKey: inboxEventKey }), 1);
});

test("inbox dedupe keys are isolated per tenant (real Mongo)", async () => {
  const a = await seedTenantUser({});
  const b = await seedTenantUser({});
  const customerA = await seedCustomer({ tenantId: a.tenant._id, branchId: a.branch._id });
  const customerB = await seedCustomer({ tenantId: b.tenant._id, branchId: b.branch._id });
  const inboxEventKey = "digital_metal.shared:key";
  await Message.create({
    _id: createId("message"),
    tenantId: a.tenant._id,
    branchId: a.branch._id,
    customerId: customerA._id,
    type: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    status: "QUEUED",
    channel: "PUSH",
    templateKey: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    reminderDedupeKey: inboxEventKey,
    templateParams: { inboxEventKey, title: "a", body: "a" },
  });
  await Message.create({
    _id: createId("message"),
    tenantId: b.tenant._id,
    branchId: b.branch._id,
    customerId: customerB._id,
    type: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    status: "QUEUED",
    channel: "PUSH",
    templateKey: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    reminderDedupeKey: inboxEventKey,
    templateParams: { inboxEventKey, title: "b", body: "b" },
  });
  assert.equal(await Message.countDocuments({ reminderDedupeKey: inboxEventKey }), 2);
});

test("resolveUnknownPayout FAILED enqueues outbox intent atomically with payout state", async () => {
  const { tenant, user } = await seedTenantUser({});
  const maker = user._id;
  const approver = createId("user");
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: null });
  const payoutId = createId("dmpos");
  const { DigitalMetalPayout } = await import("../src/models/index.js");
  await DigitalMetalPayout.create({
    _id: payoutId,
    tenantId: tenant._id,
    payableId: createId("dmpay"),
    sellOrderId: createId("dmso"),
    customerId: customer._id,
    amountPaise: 50_000,
    status: "UNKNOWN",
    makerUserId: maker,
    destinationSnapshot: { accountHolderName: "A", accountNumberLast4: "1234", ifsc: "HDFC0000001" },
    idempotencyKey: "payout-idem-1",
    statusHistory: [{ at: new Date(), status: "UNKNOWN", actorUserId: maker, note: "test" }],
  });
  const req = {
    auth: { id: approver, tenantId: tenant._id, role: "TENANT_OWNER" },
    params: { payoutId },
    body: {
      outcome: "FAILED",
      resolutionNote: "Bank confirmed failure",
      evidenceUploadIds: ["upl_evidence"],
    },
    headers: {},
    ip: "127.0.0.1",
  };
  const result = await resolveUnknownPayout(req);
  assert.equal(result.payout.status, "FAILED");
  const outbox = await DigitalMetalOutboxEvent.findOne({
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.PAYOUT_CUSTOMER_NOTICE,
    key: `${payoutId}:FAILED`,
  }).lean();
  assert.ok(outbox);
  await assert.rejects(() => resolveUnknownPayout(req), (err) => err?.code === "INVALID_STATE");
  assert.equal(
    await DigitalMetalOutboxEvent.countDocuments({
      tenantId: tenant._id,
      topic: DIGITAL_METAL_OUTBOX_TOPICS.PAYOUT_CUSTOMER_NOTICE,
      key: `${payoutId}:FAILED`,
    }),
    1,
  );
});
