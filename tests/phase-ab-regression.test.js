import test from "node:test";
import assert from "node:assert/strict";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import { env } from "../src/config/env.js";
import {
  LinkStatus,
  PaymentIntentStatus,
  PaymentMode,
  PaymentStatus,
} from "../src/constants/enums.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { createId } from "../src/lib/ids.js";
import {
  armPauseBeforeTerminalFailure,
  clearReconcileTestHooks,
} from "../src/lib/phonepe-reconcile-test-hooks.js";
import {
  Alert,
  Customer,
  LedgerEntry,
  Payment,
  PaymentIntent,
  PaymentLink,
  Scheme,
  WebhookEvent,
} from "../src/models/index.js";
import {
  finalizeGatewaySuccess,
  GatewayFinalizeOutcome,
} from "../src/services/finalize-gateway-success.service.js";
import { runPaymentExpiry } from "../src/services/payment-expiry.service.js";
import {
  reconcileGatewayPayment,
  reconcilePaymentById,
} from "../src/services/phonepe-reconcile.service.js";
import { processWebhook } from "../src/workers/processors.js";
import { connectRedis } from "../src/config/redis.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await connectRedis();
  await startTestDb();
});
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearReconcileTestHooks();
});

async function seedGatewayPayment({ mockSuffix = "", link = false } = {}) {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Regression",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      paymentRules: {
        partialPaymentAllowed: true,
        advancePaymentAllowed: false,
        maxAdvanceInstallments: 0,
        minPaymentPaise: 1000,
      },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 50_000,
    installments: [{
      number: 1,
      dueDate: "2026-01-05",
      amountPaise: 50_000,
      paidPaise: 0,
      status: "DUE",
      graceEndsAt: "2026-01-10",
    }],
    positionVersion: 1,
    version: 1,
    createdBy: user._id,
  });
  const orderId = `${createId(link ? "paymentLink" : "paymentIntent")}${mockSuffix}`;
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${orderId}`,
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(Date.now() - 3600_000),
    gatewayReconcileAttempts: 0,
  });
  if (link) {
    await PaymentLink.create({
      _id: orderId,
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: customer._id,
      amountPaise: 50_000,
      status: LinkStatus.OPENED,
      expiresAt: new Date(Date.now() - 60_000),
      paymentId,
      tokenHash: createId("hash"),
    });
  } else {
    await PaymentIntent.create({
      _id: orderId,
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: customer._id,
      amountPaise: 50_000,
      positionVersion: 1,
      status: PaymentIntentStatus.PENDING,
      paymentId,
      reservationExpiresAt: new Date(Date.now() - 60_000),
      version: 1,
    });
  }
  return { tenant, paymentId, orderId, schemeId: scheme._id, branch, customer, scheme };
}

async function seedSharedIntentLinkTopology({ mockSuffix = "" } = {}) {
  const base = await seedGatewayPayment({ mockSuffix, link: false });
  const linkId = `${createId("paymentLink")}${mockSuffix}`;
  const past = new Date(Date.now() - 60_000);
  await PaymentIntent.updateOne(
    { _id: base.orderId, tenantId: base.tenant._id },
    { $set: { reservationExpiresAt: past } },
  );
  await PaymentLink.create({
    _id: linkId,
    tenantId: base.tenant._id,
    branchId: base.branch._id,
    schemeId: base.scheme._id,
    customerId: base.customer._id,
    amountPaise: 50_000,
    status: LinkStatus.OPENED,
    expiresAt: past,
    paymentId: base.paymentId,
    paymentIntentId: base.orderId,
    tokenHash: createId("hash"),
  });
  return { ...base, linkId };
}

function trackPhonePeOrderStatusCalls() {
  const original = phonePeProvider.getOrderStatus.bind(phonePeProvider);
  let calls = 0;
  phonePeProvider.getOrderStatus = async (...args) => {
    calls += 1;
    return original(...args);
  };
  return {
    get count() { return calls; },
    restore() {
      phonePeProvider.getOrderStatus = original;
    },
  };
}

async function enqueueCompletedWebhook({
  tenantId,
  orderId,
  amount = 50_000,
  transactionId = `txn_${orderId}`,
  omitReference = false,
  omitAmount = false,
}) {
  const eventId = createId("webhook");
  const detail = {
    state: "COMPLETED",
    transactionId,
  };
  if (!omitAmount) detail.amount = amount;
  const payloadBody = {
    ...(omitReference ? {} : { originalMerchantOrderId: orderId }),
    paymentDetails: [detail],
  };
  if (!omitAmount) payloadBody.amount = amount;
  await WebhookEvent.create({
    _id: eventId,
    tenantId,
    provider: "PHONEPE",
    providerEventId: `pe-invalid-${orderId}-${String(amount)}-${transactionId}`,
    status: "QUEUED",
    payload: {
      type: CallbackType.CHECKOUT_ORDER_COMPLETED,
      payload: payloadBody,
    },
  });
  return eventId;
}

async function assertNoFinancialMutation({ tenantId, paymentId, schemeId }) {
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.PENDING);
  assert.equal(await LedgerEntry.countDocuments({ tenantId, paymentId }), 0);
  const scheme = await Scheme.findById(schemeId).lean();
  assert.equal(scheme.installments[0].paidPaise, 0);
}

const invalidWebhookCases = [
  {
    name: "missing transaction id",
    transactionId: "",
    amount: 50_000,
    code: "MISSING_TRANSACTION_ID",
  },
  {
    name: "missing amount",
    transactionId: "txn_no_amount",
    omitAmount: true,
    code: "MISSING_OR_INVALID_AMOUNT",
  },
  {
    name: "zero amount",
    transactionId: "txn_zero",
    amount: 0,
    code: "MISSING_OR_INVALID_AMOUNT",
  },
  {
    name: "non-numeric amount",
    transactionId: "txn_nan",
    amount: "not-a-number",
    code: "MISSING_OR_INVALID_AMOUNT",
  },
  {
    name: "missing reference",
    omitReference: true,
    transactionId: "txn_noref",
    amount: 50_000,
    code: "MISSING_MERCHANT_ORDER_ID",
  },
];

for (const invalidCase of invalidWebhookCases) {
  test(`invalid completed webhook: ${invalidCase.name} does not mutate financial state`, async () => {
    const { tenant, paymentId, orderId, schemeId } = await seedGatewayPayment();
    const eventId = await enqueueCompletedWebhook({
      tenantId: tenant._id,
      orderId,
      amount: invalidCase.amount,
      transactionId: invalidCase.transactionId,
      omitReference: invalidCase.omitReference,
      omitAmount: invalidCase.omitAmount,
    });
    await processWebhook({ data: { webhookEventId: eventId }, id: "wh-job", attemptsMade: 0 });
    await assertNoFinancialMutation({ tenantId: tenant._id, paymentId, schemeId });
    const alert = await Alert.findOne({
      tenantId: tenant._id,
      type: "GATEWAY_WEBHOOK_INVALID_COMPLETED",
    }).lean();
    assert.ok(alert);
    assert.equal(alert.metadata.code, invalidCase.code);
    assert.equal((await WebhookEvent.findById(eventId).lean()).status, "COMPLETED");
  });
}

const linkExpiryCases = [
  { suffix: "", expectExpired: false, label: "pending" },
  { suffix: "__mock_transient__", expectExpired: false, label: "transient error" },
  { suffix: "__mock_completed__", expectExpired: false, label: "completed success", expectPaid: true },
  { suffix: "__mock_failed__", expectExpired: false, label: "terminal failure", expectFailed: true },
  { suffix: "__mock_completed_49000__", expectExpired: false, label: "amount mismatch", expectReview: true },
];

for (const linkCase of linkExpiryCases) {
  test(`payment link expiry defers or converges on ${linkCase.label}`, async () => {
    const { paymentId, orderId } = await seedGatewayPayment({
      mockSuffix: linkCase.suffix,
      link: true,
    });
    await runPaymentExpiry(new Date());
    const link = await PaymentLink.findById(orderId).lean();
    if (linkCase.expectPaid) {
      assert.equal(link.status, LinkStatus.PAID);
    } else if (linkCase.expectFailed) {
      assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.FAILED);
      assert.equal(link.status, LinkStatus.EXPIRED);
    } else if (linkCase.expectReview) {
      assert.equal(
        (await Payment.findById(paymentId).lean()).status,
        PaymentStatus.AMOUNT_MISMATCH_PENDING_REVIEW,
      );
      assert.equal(link.status, LinkStatus.EXPIRED);
    } else {
      assert.notEqual(link.status, LinkStatus.EXPIRED);
      assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.PENDING);
    }
  });
}

test("reconcile terminal response races webhook success to COMPLETED_ALREADY", async () => {
  const { tenant, paymentId, orderId } = await seedGatewayPayment({ mockSuffix: "__mock_failed__" });
  const intent = await PaymentIntent.findById(orderId).lean();
  const pause = armPauseBeforeTerminalFailure();
  const payment = await Payment.findById(paymentId).lean();
  const reconcilePromise = reconcileGatewayPayment(payment, {
    leaseWorkerLabel: "race",
  });
  await pause.waitUntilPaused();
  const fin = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: orderId,
    transactionId: `race_ok_${orderId}`,
    amountPaise: 50_000,
    providerPayload: {},
    webhookEventId: "wh_race",
    intent,
  });
  assert.equal(fin.outcome, GatewayFinalizeOutcome.SUCCESS);
  pause.resume();
  const result = await reconcilePromise;
  pause.disarm();
  assert.equal(result.outcome, "COMPLETED_ALREADY");
  const row = await Payment.findById(paymentId).lean();
  assert.equal(row.status, PaymentStatus.SUCCESS);
  assert.equal(row.gatewayLastReconcileOutcome, "COMPLETED_ALREADY");
  assert.equal(await LedgerEntry.countDocuments({ tenantId: tenant._id, paymentId }), 1);
});

const sharedTopologyCases = [
  {
    label: "pending",
    mockSuffix: "",
    expectAttemptsDelta: 1,
    assertState: async ({ intent, link, paymentId }) => {
      assert.equal((await PaymentIntent.findById(intent._id).lean()).status, PaymentIntentStatus.PENDING);
      assert.equal((await PaymentLink.findById(link._id).lean()).status, LinkStatus.OPENED);
      assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.PENDING);
    },
  },
  {
    label: "transient",
    mockSuffix: "__mock_transient__",
    expectAttemptsDelta: 1,
    assertState: async ({ intent, link, paymentId }) => {
      assert.equal((await PaymentIntent.findById(intent._id).lean()).status, PaymentIntentStatus.PENDING);
      assert.equal((await PaymentLink.findById(link._id).lean()).status, LinkStatus.OPENED);
      assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.PENDING);
    },
  },
  {
    label: "completed success",
    mockSuffix: "__mock_completed__",
    expectAttemptsDelta: 0,
    assertState: async ({ intent, link, paymentId }) => {
      assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
      assert.equal((await PaymentLink.findById(link._id).lean()).status, LinkStatus.PAID);
      assert.notEqual((await PaymentIntent.findById(intent._id).lean()).status, PaymentIntentStatus.EXPIRED);
    },
  },
  {
    label: "terminal failed",
    mockSuffix: "__mock_failed__",
    expectAttemptsDelta: 0,
    assertState: async ({ link, paymentId }) => {
      assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.FAILED);
      assert.equal((await PaymentLink.findById(link._id).lean()).status, LinkStatus.EXPIRED);
    },
  },
  {
    label: "amount mismatch",
    mockSuffix: "__mock_completed_49000__",
    expectAttemptsDelta: 0,
    assertState: async ({ link, paymentId }) => {
      assert.equal(
        (await Payment.findById(paymentId).lean()).status,
        PaymentStatus.AMOUNT_MISMATCH_PENDING_REVIEW,
      );
      assert.equal((await PaymentLink.findById(link._id).lean()).status, LinkStatus.EXPIRED);
    },
  },
];

for (const sharedCase of sharedTopologyCases) {
  test(`expiry intent+link topology: one provider call for ${sharedCase.label}`, async () => {
    const { tenant, paymentId, orderId, linkId } = await seedSharedIntentLinkTopology({
      mockSuffix: sharedCase.mockSuffix,
    });
    const attemptsBefore = (await Payment.findById(paymentId).lean()).gatewayReconcileAttempts ?? 0;
    const tracker = trackPhonePeOrderStatusCalls();
    try {
      await runPaymentExpiry(new Date());
      assert.equal(tracker.count, 1);
    } finally {
      tracker.restore();
    }
    const attemptsAfter = (await Payment.findById(paymentId).lean()).gatewayReconcileAttempts ?? 0;
    assert.equal(attemptsAfter - attemptsBefore, sharedCase.expectAttemptsDelta);
    const intent = await PaymentIntent.findById(orderId).lean();
    const link = await PaymentLink.findById(linkId).lean();
    await sharedCase.assertState({ intent, link, paymentId, tenantId: tenant._id });
  });
}

test("concurrent manual reconcile claims lease once and increments attempts atomically", async () => {
  const { tenant, paymentId } = await seedGatewayPayment();
  const [a, b] = await Promise.all([
    reconcilePaymentById({ tenantId: tenant._id, paymentId }),
    reconcilePaymentById({ tenantId: tenant._id, paymentId }),
  ]);
  const outcomes = [a.outcome, b.outcome];
  assert.ok(outcomes.includes("STILL_PENDING") || outcomes.includes("LEASE_BUSY"));
  assert.equal(outcomes.filter((o) => o === "LEASE_BUSY").length, 1);
  const row = await Payment.findById(paymentId).lean();
  assert.equal(row.gatewayReconcileAttempts, 1);
});

test("sequential pending reconciles increment attempts without loss", async () => {
  const { paymentId } = await seedGatewayPayment();
  for (let i = 0; i < 3; i += 1) {
    const payment = await Payment.findById(paymentId).lean();
    const result = await reconcileGatewayPayment(payment, { leaseWorkerLabel: `seq_${i}` });
    assert.equal(result.outcome, "STILL_PENDING");
  }
  assert.equal((await Payment.findById(paymentId).lean()).gatewayReconcileAttempts, 3);
});

test("reconcile exhaustion creates a single exhausted alert at threshold", async () => {
  const maxAttempts = env.PHONEPE_RECONCILE_MAX_ATTEMPTS ?? 5;
  const { tenant, paymentId } = await seedGatewayPayment({ mockSuffix: "__mock_transient__" });
  await Payment.updateOne(
    { _id: paymentId, tenantId: tenant._id },
    { $set: { gatewayReconcileAttempts: maxAttempts - 1 } },
  );
  let payment = await Payment.findById(paymentId).lean();
  await reconcileGatewayPayment(payment, { leaseWorkerLabel: "exhaust_1" });
  const alerts = await Alert.find({
    tenantId: tenant._id,
    type: "GATEWAY_RECONCILE_EXHAUSTED",
    entityId: paymentId,
  }).lean();
  assert.equal(alerts.length, 1);
  assert.equal((await Payment.findById(paymentId).lean()).reviewReason, "GATEWAY_RECONCILE_EXHAUSTED");
});
