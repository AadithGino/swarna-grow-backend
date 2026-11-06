import test from "node:test";
import assert from "node:assert/strict";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import {
  buildPhonePeLegacyWebhookEventId,
  buildPhonePeWebhookEventId,
  canonicalPhonePeSemanticEventId,
  phonePeWebhookEventIdentityCandidates,
} from "../src/lib/phonepe-webhook-identity.js";
import {
  collectGatewayMerchantOrderIdCandidates,
  gatewayMerchantOrderIdWritePatch,
  resolveGatewayMerchantOrderIdForPayment,
  resolveGatewayMerchantOrderIdFromRows,
} from "../src/lib/phonepe-gateway-merchant-order-id.js";
import { env } from "../src/config/env.js";
import { PaymentIntentStatus, PaymentMode, PaymentStatus } from "../src/constants/enums.js";
import { reconcileGatewayPayment, resolveMerchantOrderIdForPayment } from "../src/services/phonepe-reconcile.service.js";
import { persistPhonePeVerifiedWebhook, persistVerifiedWebhook } from "../src/services/webhook-event.service.js";
import { Customer, Payment, PaymentIntent, PaymentLink, Scheme, WebhookEvent } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  armMockOrderStatusTemplate,
  clearPhonePeProviderTestHooks,
} from "../src/lib/phonepe-provider-test-hooks.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

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
      paymentRules: { partialPaymentAllowed: true, advancePaymentAllowed: false, maxAdvanceInstallments: 0, minPaymentPaise: 1000 },
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

test("webhook: same transactionId on attempt-failed vs completed yields distinct canonical ids", () => {
  const tenantId = "tenant_phase2";
  const txn = "txn_shared_lifecycle";
  const base = { originalMerchantOrderId: "plk_merchant", amount: 50_000 };
  const attemptId = buildPhonePeWebhookEventId({
    tenantId,
    type: CallbackType.CHECKOUT_TRANSACTION_ATTEMPT_FAILED,
    payload: { ...base, paymentDetails: [{ state: "FAILED", transactionId: txn }] },
  });
  const completedId = buildPhonePeWebhookEventId({
    tenantId,
    type: CallbackType.CHECKOUT_ORDER_COMPLETED,
    payload: { ...base, paymentDetails: [{ state: "COMPLETED", transactionId: txn }] },
  });
  assert.notEqual(attemptId, completedId);
  const legacy = buildPhonePeLegacyWebhookEventId({
    tenantId,
    payload: { paymentDetails: [{ transactionId: txn }] },
  });
  assert.equal(legacy, `pe:${tenantId}:${txn}`);
  assert.notEqual(legacy, attemptId);
});

test("webhook: legacy alias suppresses duplicate when canonical replay arrives after legacy row", async () => {
  const { tenant } = await seedGatewayFixture();
  const payload = {
    type: CallbackType.CHECKOUT_ORDER_COMPLETED,
    payload: {
      originalMerchantOrderId: "pmi_a",
      paymentDetails: [{ state: "COMPLETED", transactionId: "txn_legacy_dup" }],
    },
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const { primary, aliases, semanticKey } = phonePeWebhookEventIdentityCandidates({
    tenantId: tenant._id,
    type: payload.type,
    payload: payload.payload,
    rawBody,
  });
  assert.ok(aliases.length);
  await persistVerifiedWebhook({
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: aliases[0],
    rawBody,
    payload,
  });
  const second = await persistPhonePeVerifiedWebhook({
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: primary,
    identityAliases: aliases,
    semanticKey,
    rawBody,
    payload,
  });
  assert.equal(second, null);
  const count = await WebhookEvent.countDocuments({ tenantId: tenant._id, provider: "PHONEPE" });
  assert.equal(count, 1);
});

test("webhook: legacy alias without digest does not suppress distinct lifecycle event", async () => {
  const { tenant } = await seedGatewayFixture();
  const attemptPayload = {
    type: CallbackType.CHECKOUT_TRANSACTION_ATTEMPT_FAILED,
    payload: {
      originalMerchantOrderId: "plk_x",
      paymentDetails: [{ state: "FAILED", transactionId: "txn_distinct" }],
    },
  };
  const { aliases } = phonePeWebhookEventIdentityCandidates({
    tenantId: tenant._id,
    type: attemptPayload.type,
    payload: attemptPayload.payload,
    rawBody: null,
  });
  await persistVerifiedWebhook({
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: aliases[0],
    payload: attemptPayload,
  });
  const completedPayload = {
    type: CallbackType.CHECKOUT_ORDER_COMPLETED,
    payload: {
      originalMerchantOrderId: "plk_x",
      paymentDetails: [{ state: "COMPLETED", transactionId: "txn_distinct" }],
    },
  };
  const completedIdentity = phonePeWebhookEventIdentityCandidates({
    tenantId: tenant._id,
    type: completedPayload.type,
    payload: completedPayload.payload,
    rawBody: null,
  });
  const second = await persistPhonePeVerifiedWebhook({
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: completedIdentity.primary,
    identityAliases: completedIdentity.aliases,
    semanticKey: completedIdentity.semanticKey,
    payload: completedPayload,
  });
  assert.ok(second);
  assert.equal(await WebhookEvent.countDocuments({ tenantId: tenant._id, provider: "PHONEPE" }), 2);
});

test("merchant order id: fixed link uses link id not reservation intent id", async () => {
  const { tenant, branch, customer, scheme } = await seedGatewayFixture();
  const linkId = createId("paymentLink");
  const intentId = createId("paymentIntent");
  const providerOrderId = "phonepe_provider_order_distinct";
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${linkId}`,
    gatewayMerchantOrderId: linkId,
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    providerTransactionId: providerOrderId,
    paidAt: new Date(),
  });
  await PaymentLink.create({
    _id: linkId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    tokenHash: "hash",
    amountPaise: 50_000,
    expiresAt: new Date(Date.now() + 3600_000),
    paymentId,
    paymentIntentId: intentId,
  });
  await PaymentIntent.create({
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
    providerOrderId,
    version: 1,
  });
  const payment = await Payment.findById(paymentId).lean();
  assert.equal(await resolveMerchantOrderIdForPayment(payment), linkId);
  assert.notEqual(await resolveMerchantOrderIdForPayment(payment), intentId);
  assert.notEqual(await resolveMerchantOrderIdForPayment(payment), providerOrderId);
});

test("merchant order id: survives final receipt after success reconcile", async () => {
  assert.equal(env.PROVIDER_MODE, "mock");
  const { tenant, branch, customer, scheme } = await seedGatewayFixture();
  const linkId = createId("paymentLink");
  const intentId = createId("paymentIntent");
  armMockOrderStatusTemplate(linkId, "__mock_completed__");
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${linkId}`,
    gatewayMerchantOrderId: linkId,
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(Date.now() - 3600_000),
  });
  await PaymentLink.create({
    _id: linkId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    tokenHash: "hash2",
    amountPaise: 50_000,
    expiresAt: new Date(Date.now() + 3600_000),
    paymentId,
  });
  await PaymentIntent.create({
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
  await reconcileGatewayPayment(payment);
  await Payment.updateOne(
    { _id: paymentId },
    { $set: { receiptNumber: `RCPT-${Date.now()}` } },
  );
  const after = await Payment.findById(paymentId).lean();
  assert.equal(await resolveGatewayMerchantOrderIdForPayment(after), linkId);
});

test("merchant order id: conflicting bound candidates fail closed", () => {
  const paymentId = createId("payment");
  const linkId = createId("paymentLink");
  const intentId = createId("paymentIntent");
  const payment = {
    _id: paymentId,
    tenantId: "tnt_1",
    gatewayMerchantOrderId: intentId,
    receiptNumber: "RCPT-1",
  };
  const intent = {
    _id: intentId,
    tenantId: "tnt_1",
    paymentId,
    fixedFromInstallment: 1,
  };
  const link = { _id: linkId, tenantId: "tnt_1", paymentId };
  const { ambiguous } = collectGatewayMerchantOrderIdCandidates(payment, { intent, link });
  assert.equal(ambiguous, true);
  assert.equal(resolveGatewayMerchantOrderIdFromRows(payment, { intent, link }), null);
});

test("merchant order id: flexible public link uses link id with bound flexible intent", async () => {
  const { tenant, branch, customer, scheme } = await seedGatewayFixture();
  const linkId = createId("paymentLink");
  const intentId = createId("paymentIntent");
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${linkId}`,
    gatewayMerchantOrderId: linkId,
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentLink.create({
    _id: linkId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    tokenHash: "flex-link",
    amountPaise: 50_000,
    expiresAt: new Date(Date.now() + 3600_000),
    paymentId,
    paymentIntentId: intentId,
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    amountPaise: 50_000,
    positionVersion: 1,
    status: PaymentIntentStatus.PENDING,
    paymentId,
    version: 1,
  });
  const payment = await Payment.findById(paymentId).lean();
  const { ambiguous } = collectGatewayMerchantOrderIdCandidates(payment, {
    intent: await PaymentIntent.findById(intentId).lean(),
    link: await PaymentLink.findById(linkId).lean(),
  });
  assert.equal(ambiguous, false);
  assert.equal(await resolveGatewayMerchantOrderIdForPayment(payment), linkId);
});

test("merchant order id: write-once patch rejects conflicting merchant id", () => {
  assert.throws(
    () => gatewayMerchantOrderIdWritePatch({ gatewayMerchantOrderId: "plink_a" }, "pint_b"),
    (err) => err.code === "GATEWAY_MERCHANT_ORDER_ID_CONFLICT",
  );
  assert.deepEqual(
    gatewayMerchantOrderIdWritePatch({ gatewayMerchantOrderId: "plink_a" }, "plink_a"),
    {},
  );
});

test("webhook: semantic identity ignores raw JSON whitespace", () => {
  const tenantId = "tenant_ws";
  const payload = {
    originalMerchantOrderId: "ord_1",
    paymentDetails: [{ state: "COMPLETED", transactionId: "txn_ws" }],
  };
  const a = canonicalPhonePeSemanticEventId({
    tenantId,
    type: CallbackType.CHECKOUT_ORDER_COMPLETED,
    payload,
  });
  const b = canonicalPhonePeSemanticEventId({
    tenantId,
    type: CallbackType.CHECKOUT_ORDER_COMPLETED,
    payload: { ...payload, extra: undefined },
  });
  assert.equal(a, b);
});

test("merchant order id: flexible intent uses intent id from persisted field", () => {
  const intentId = createId("paymentIntent");
  const payment = {
    _id: createId("payment"),
    gatewayMerchantOrderId: intentId,
    receiptNumber: "RCPT-final-001",
    providerTransactionId: "pp_order_xyz",
  };
  const intent = { _id: createId("paymentIntent"), paymentId: payment._id, providerOrderId: "pp_order_xyz" };
  assert.equal(resolveGatewayMerchantOrderIdFromRows(payment, { intent }), intentId);
});
