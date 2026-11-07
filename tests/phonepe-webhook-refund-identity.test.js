import test from "node:test";
import assert from "node:assert/strict";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import {
  buildPhonePeWebhookEventId,
  phonePeWebhookEventIdentityCandidates,
} from "../src/lib/phonepe-webhook-identity.js";
import { PaymentIntentStatus, PaymentMode, PaymentStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  armMockOrderStatusTemplate,
  clearPhonePeProviderTestHooks,
} from "../src/lib/phonepe-provider-test-hooks.js";
import { Customer, LedgerEntry, Payment, PaymentIntent, PaymentRefund, Scheme } from "../src/models/index.js";
import {
  finalizeGatewaySuccess,
  GatewayFinalizeOutcome,
} from "../src/services/finalize-gateway-success.service.js";
import { persistPhonePeVerifiedWebhook } from "../src/services/webhook-event.service.js";
import { reconcileGatewayPayment } from "../src/services/phonepe-reconcile.service.js";
import { processWebhook } from "../src/workers/processors.js";
import { WebhookEvent } from "../src/models/index.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import {
  collectGatewayMerchantOrderIdCandidates,
  inferGatewayMerchantOrderIdFromCheckoutFlow,
} from "../src/lib/phonepe-gateway-merchant-order-id.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearPhonePeProviderTestHooks();
});

async function seedGatewayFixture() {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Gateway Customer",
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
  return { tenant, branch, customer, scheme };
}

async function seedPaidIntentPayment({ amountPaise = 100_000 } = {}) {
  const { tenant, branch, user } = await seedTenantUser();
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Refund Webhook",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const schemeId = createId("scheme");
  const intentId = createId("paymentIntent");
  armMockOrderStatusTemplate(intentId, "__mock_completed__");
  const paymentId = createId("payment");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
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
    installmentAmountPaise: amountPaise,
    installments: [{
      number: 1,
      dueDate: "2026-01-05",
      amountPaise,
      paidPaise: 0,
      status: "DUE",
      graceEndsAt: "2026-01-10",
    }],
    positionVersion: 1,
    version: 1,
    createdBy: user._id,
  });
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId,
    receiptNumber: `PENDING-${intentId}`,
    gatewayMerchantOrderId: intentId,
    amountPaise,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  const intent = await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId,
    amountPaise,
    positionVersion: 1,
    status: PaymentIntentStatus.PENDING,
    paymentId,
    version: 1,
  });
  const fin = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    merchantOrderId: intentId,
    transactionId: `txn_${intentId}`,
    amountPaise,
    providerPayload: {},
    webhookEventId: `wh_${intentId}`,
    intent,
  });
  assert.equal(fin.outcome, GatewayFinalizeOutcome.SUCCESS);
  return { tenant, paymentId, intentId, amountPaise };
}

test("refund webhook keys include merchant refund identity; shared eventId stays distinct", () => {
  const tenantId = "tnt_ref";
  const sharedEventId = "evt_shared_correlation";
  const base = {
    originalMerchantOrderId: "ord_1",
    eventId: sharedEventId,
    amount: 25_000,
    currency: "INR",
  };
  const a = buildPhonePeWebhookEventId({
    tenantId,
    type: "PG_REFUND_COMPLETED",
    payload: { ...base, merchantRefundId: "mref_a", refundId: "pref_a" },
  });
  const b = buildPhonePeWebhookEventId({
    tenantId,
    type: "PG_REFUND_COMPLETED",
    payload: { ...base, merchantRefundId: "mref_b", refundId: "pref_b" },
  });
  assert.notEqual(a, b);
  assert.match(a, /:ref:mref_a/);
  assert.match(b, /:ref:mref_b/);
});

test("mongo: two partial refund completions persist with shared provider eventId", async () => {
  const { tenant, paymentId, intentId } = await seedPaidIntentPayment();
  const sharedEventId = "phonepe_evt_same";
  const mkEnvelope = (merchantRefundId, amount) => ({
    type: CallbackType.PG_REFUND_COMPLETED,
    payload: {
      originalMerchantOrderId: intentId,
      merchantRefundId,
      refundId: merchantRefundId,
      eventId: sharedEventId,
      amount,
      currency: "INR",
    },
  });
  for (const [merchantRefundId, amount] of [["mref_p1", 30_000], ["mref_p2", 70_000]]) {
    const envelope = mkEnvelope(merchantRefundId, amount);
    const identity = phonePeWebhookEventIdentityCandidates({
      tenantId: tenant._id,
      type: envelope.type,
      payload: envelope.payload,
      rawBody: Buffer.from(JSON.stringify(envelope)),
    });
    const row = await persistPhonePeVerifiedWebhook({
      tenantId: tenant._id,
      provider: "PHONEPE",
      providerEventId: identity.primary,
      identityAliases: identity.aliases,
      semanticKey: identity.semanticKey,
      rawBody: Buffer.from(JSON.stringify(envelope)),
      payload: envelope,
    });
    assert.ok(row, `expected persist for ${merchantRefundId}`);
  }
  assert.equal(await WebhookEvent.countDocuments({ tenantId: tenant._id, provider: "PHONEPE" }), 2);
  const payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.status, PaymentStatus.SUCCESS);
  assert.equal(await PaymentRefund.countDocuments({ paymentId }), 0);
});

test("mongo: refund webhook replays dedupe per refund identity", async () => {
  const { tenant, intentId } = await seedPaidIntentPayment({ amountPaise: 50_000 });
  const envelope = {
    type: CallbackType.PG_REFUND_COMPLETED,
    payload: {
      originalMerchantOrderId: intentId,
      merchantRefundId: "mref_replay",
      refundId: "mref_replay",
      eventId: "evt_replay",
      amount: 50_000,
      currency: "INR",
    },
  };
  const rawBody = Buffer.from(JSON.stringify(envelope));
  const identity = phonePeWebhookEventIdentityCandidates({
    tenantId: tenant._id,
    type: envelope.type,
    payload: envelope.payload,
    rawBody,
  });
  const first = await persistPhonePeVerifiedWebhook({
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: identity.primary,
    identityAliases: identity.aliases,
    semanticKey: identity.semanticKey,
    rawBody,
    payload: envelope,
  });
  const replay = await persistPhonePeVerifiedWebhook({
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: identity.primary,
    identityAliases: identity.aliases,
    semanticKey: identity.semanticKey,
    rawBody,
    payload: envelope,
  });
  assert.ok(first);
  assert.equal(replay, null);
  assert.equal(await WebhookEvent.countDocuments({ tenantId: tenant._id, provider: "PHONEPE" }), 1);
});

test("mongo: reused correlation id does not collapse refund accepted vs completed", async () => {
  const { tenant, intentId } = await seedPaidIntentPayment({ amountPaise: 40_000 });
  const sharedEventId = "evt_lifecycle_shared";
  const accepted = {
    type: CallbackType.PG_REFUND_ACCEPTED,
    payload: {
      originalMerchantOrderId: intentId,
      merchantRefundId: "mref_lc",
      eventId: sharedEventId,
      amount: 40_000,
      currency: "INR",
    },
  };
  const completed = {
    type: CallbackType.PG_REFUND_COMPLETED,
    payload: {
      originalMerchantOrderId: intentId,
      merchantRefundId: "mref_lc",
      eventId: sharedEventId,
      amount: 40_000,
      currency: "INR",
    },
  };
  for (const envelope of [accepted, completed]) {
    const identity = phonePeWebhookEventIdentityCandidates({
      tenantId: tenant._id,
      type: envelope.type,
      payload: envelope.payload,
      rawBody: null,
    });
    const row = await persistPhonePeVerifiedWebhook({
      tenantId: tenant._id,
      provider: "PHONEPE",
      providerEventId: identity.primary,
      identityAliases: identity.aliases,
      semanticKey: identity.semanticKey,
      payload: envelope,
    });
    assert.ok(row);
  }
  assert.equal(await WebhookEvent.countDocuments({ tenantId: tenant._id, provider: "PHONEPE" }), 2);
});

test("worker: two partial refund webhooks each produce one ledger reversal", async () => {
  const { tenant, paymentId, intentId } = await seedPaidIntentPayment();
  async function ingestRefund(merchantRefundId, amount) {
    const envelope = {
      type: CallbackType.PG_REFUND_COMPLETED,
      payload: {
        originalMerchantOrderId: intentId,
        merchantRefundId,
        refundId: merchantRefundId,
        amount,
        currency: "INR",
      },
    };
    const identity = phonePeWebhookEventIdentityCandidates({
      tenantId: tenant._id,
      type: envelope.type,
      payload: envelope.payload,
      rawBody: Buffer.from(JSON.stringify(envelope)),
    });
    const event = await persistPhonePeVerifiedWebhook({
      tenantId: tenant._id,
      provider: "PHONEPE",
      providerEventId: identity.primary,
      identityAliases: identity.aliases,
      semanticKey: identity.semanticKey,
      rawBody: Buffer.from(JSON.stringify(envelope)),
      payload: envelope,
    });
    assert.ok(event);
    await processWebhook({ data: { webhookEventId: event._id }, id: `job_${merchantRefundId}` });
    const stored = await WebhookEvent.findById(event._id).lean();
    assert.equal(stored.status, "COMPLETED");
  }
  await ingestRefund("mref_w1", 25_000);
  await ingestRefund("mref_w2", 75_000);
  assert.equal(await LedgerEntry.countDocuments({ paymentId, type: "REVERSAL" }), 2);
  const payment = await Payment.findById(paymentId).lean();
  assert.equal(payment.refundedAmountPaise, 100_000);
  assert.equal(payment.status, PaymentStatus.REVERSED);
});

test("merchant order id: fixed reservation without verified gateway ref is ambiguous", async () => {
  const { tenant, branch, customer, scheme } = await seedGatewayFixture();
  const intentId = createId("paymentIntent");
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  const intent = await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    amountPaise: 50_000,
    fixedFromInstallment: 1,
    fixedThroughInstallment: 1,
    positionVersion: 1,
    status: PaymentIntentStatus.PENDING,
    paymentId,
    version: 1,
  });
  const payment = await Payment.findById(paymentId).lean();
  assert.equal(inferGatewayMerchantOrderIdFromCheckoutFlow(payment, { intent }), null);
  const { ambiguous, candidates, review } = collectGatewayMerchantOrderIdCandidates(payment, { intent });
  assert.equal(ambiguous, true);
  assert.equal(candidates.length, 0);
  assert.equal(review?.reason, "UNVERIFIED_FIXED_RESERVATION_RECEIPT");
  armMockOrderStatusTemplate(intentId, "__mock_completed__");
  const progress = await reconcileGatewayPayment(payment);
  assert.equal(progress.outcome, "NO_MERCHANT_ORDER_ID");
});

test("merchant order id: pending receipt intent id ignored for fixed reservation without stored ref", async () => {
  const { tenant, branch, customer, scheme } = await seedGatewayFixture();
  const intentId = createId("paymentIntent");
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  const intent = await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    amountPaise: 50_000,
    fixedFromInstallment: 1,
    fixedThroughInstallment: 1,
    positionVersion: 1,
    status: PaymentIntentStatus.PENDING,
    paymentId,
    version: 1,
  });
  const payment = await Payment.findById(paymentId).lean();
  const { ambiguous, review } = collectGatewayMerchantOrderIdCandidates(payment, { intent });
  assert.equal(ambiguous, true);
  assert.equal(review?.reason, "UNVERIFIED_FIXED_RESERVATION_RECEIPT");
});
