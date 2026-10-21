import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import {
  armMockOrderStatus,
  clearPhonePeProviderTestHooks,
} from "../src/lib/phonepe-provider-test-hooks.js";
import {
  DigitalMetalBuyOrder,
  DigitalMetalBuyPaymentAttempt,
  DigitalMetalJournal,
  DigitalMetalOutboxEvent,
  DigitalMetalPaymentExceptionRefund,
  DigitalMetalWallet,
  Tenant,
} from "../src/models/index.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { makeTenantQuoteReady } from "./helpers/digital-metals-live-ready.js";
import { configureTenantPhonePe } from "./helpers/gateway-http-fixture.js";
import { createId } from "../src/lib/ids.js";
import { signAccessToken } from "../src/services/token.service.js";
import { Session } from "../src/models/index.js";
import { withTransaction } from "../src/lib/transaction.js";
import { creditWalletForTest, reserveWalletQuantity } from "../src/services/digital-metals-ledger.service.js";

const app = createApp();
const G4 = 4_000_000;
const G5 = 5_000_000;

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  clearPhonePeProviderTestHooks();
  process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
});
test.afterEach(async () => {
  const { clearDigitalMetalBuyFinalizeTestHooksForTests } = await import(
    "../src/lib/digital-metals-buy-finalize-test-hooks.js"
  );
  clearDigitalMetalBuyFinalizeTestHooksForTests();
  clearPhonePeProviderTestHooks();
});

async function enablePlan(tenantId) {
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "subscription.planFeaturesSnapshot.digitalMetals": true,
        "subscription.tier": PlanTier.GROWTH,
        "operations.digitalMetalsEnabled": true,
      },
    },
  );
}

async function customerToken({ tenant, branch, customer }) {
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "cust",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "cust",
    securityVersion: 0,
    sessionId: session._id,
  });
}

async function seedPayableBuyOrder({ tenant, branch, customer, token, adminToken }) {
  await enablePlan(tenant._id);
  await configureTenantPhonePe(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, adminToken);
  const quote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/buy")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ metal: "GOLD", finenessPpm: 999000, inputMode: "BUDGET_INR", budgetPaise: 600_000 });
  assert.equal(quote.status, 201);
  const order = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(order.status, 201);
  const pay = await request(app)
    .post(`/api/v1/app/digital-metals/buy-orders/${order.body.data.id}/payment-intents`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(pay.status, 201);
  const attempt = await DigitalMetalBuyPaymentAttempt.findOne({ orderId: order.body.data.id }).lean();
  return { order: order.body.data, attempt, token, customer, tenant, branch };
}

function mockCompletedStatus(attempt, amountPaise) {
  const providerOrderId = attempt.providerOrderId ?? attempt._id;
  armMockOrderStatus(providerOrderId, {
    state: "COMPLETED",
    merchantOrderId: attempt.merchantOrderId ?? attempt._id,
    amount: amountPaise,
    orderId: providerOrderId,
    paymentDetails: [
      {
        state: "COMPLETED",
        transactionId: `mock_txn_${attempt._id}`,
        amount: amountPaise,
      },
    ],
  });
  return providerOrderId;
}

test("concurrent webhook poll and maintenance finalization credits once", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, attempt } = await seedPayableBuyOrder({
    tenant,
    branch,
    customer,
    token,
    adminToken: bearerFor(user),
  });
  mockCompletedStatus(attempt, order.totalPayablePaise);
  const { finalizeDigitalMetalBuyPaymentSuccess, recoverDigitalMetalBuyOrderCredit } = await import(
    "../src/services/digital-metals-buy-finalize.service.js"
  );
  const {
    claimDigitalMetalBuyPaymentAttemptForReconcile,
    reconcileDigitalMetalBuyPaymentAttempt,
  } = await import("../src/services/digital-metals-payment-reconcile.service.js");
  const merchantOrderId = attempt.merchantOrderId ?? attempt._id;
  const payload = {
    tenantId: tenant._id,
    merchantOrderId,
    transactionId: `mock_txn_${attempt._id}`,
    amountPaise: order.totalPayablePaise,
    currency: "INR",
    providerPayload: {},
  };
  const claimed = await claimDigitalMetalBuyPaymentAttemptForReconcile(attempt._id);
  const results = await Promise.all([
    finalizeDigitalMetalBuyPaymentSuccess({ ...payload, source: "WEBHOOK" }),
    claimed
      ? reconcileDigitalMetalBuyPaymentAttempt(claimed, {
          leaseOwner: claimed.gatewayReconcileLeaseOwner,
        })
      : Promise.resolve({ outcome: "NO_LEASE" }),
    finalizeDigitalMetalBuyPaymentSuccess({ ...payload, transactionId: "dup-callback", source: "WEBHOOK" }),
    recoverDigitalMetalBuyOrderCredit(order.id, tenant._id),
  ]);
  const credited = results.filter(
    (r) => r?.outcome === "CREDITED" || r?.outcome === "ALREADY_SUCCESS" || r?.outcome === "ALREADY_CREDITED",
  );
  assert.ok(credited.length >= 1);
  const journals = await DigitalMetalJournal.countDocuments({
    tenantId: tenant._id,
    idempotencyKey: `purchase-credit:${order.id}`,
  });
  assert.equal(journals, 1);
});

test("missing webhook with abandoned browser session completes via reconcile poll", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, attempt } = await seedPayableBuyOrder({
    tenant,
    branch,
    customer,
    token,
    adminToken: bearerFor(user),
  });
  mockCompletedStatus(attempt, order.totalPayablePaise);
  await DigitalMetalBuyPaymentAttempt.updateOne(
    { _id: attempt._id },
    {
      $set: {
        gatewayReconcileNextAt: new Date(Date.now() - 1000),
        updatedAt: new Date(Date.now() - 20 * 60 * 1000),
      },
    },
  );
  const { claimDigitalMetalBuyPaymentAttemptForReconcile, reconcileDigitalMetalBuyPaymentAttempt } =
    await import("../src/services/digital-metals-payment-reconcile.service.js");
  const claimed = await claimDigitalMetalBuyPaymentAttemptForReconcile(attempt._id);
  assert.ok(claimed);
  const result = await reconcileDigitalMetalBuyPaymentAttempt(claimed, {
    leaseOwner: claimed.gatewayReconcileLeaseOwner,
  });
  assert.ok(["CREDITED", "ALREADY_SUCCESS"].includes(result.outcome));
  const fresh = await DigitalMetalBuyOrder.findById(order.id).lean();
  assert.equal(fresh.status, "CREDITED");
});

test("pause and plan downgrade during payment still finalize in-flight obligation", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order } = await seedPayableBuyOrder({
    tenant,
    branch,
    customer,
    token,
    adminToken: bearerFor(user),
  });
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "operations.digitalMetalsEnabled": false,
        "subscription.planFeaturesSnapshot.digitalMetals": false,
        "operations.digitalMetalsPaused": true,
      },
    },
  );
  const { completeTestHarnessBuyPayment } = await import(
    "../src/services/digital-metals-buy-payment.service.js"
  );
  const complete = await completeTestHarnessBuyPayment({
    auth: { id: customer._id, tenantId: tenant._id },
    params: { orderId: order.id },
    body: { outcome: "COMPLETED" },
  });
  assert.equal(complete.orderStatus, "CREDITED");
});

test("late success after payment window creates refund review without crediting metal", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, attempt } = await seedPayableBuyOrder({
    tenant,
    branch,
    customer,
    token,
    adminToken: bearerFor(user),
  });
  await DigitalMetalBuyOrder.updateOne(
    { _id: order.id },
    { $set: { paymentAcceptanceExpiresAt: new Date(Date.now() - 60_000), status: "EXPIRED" } },
  );
  const { finalizeDigitalMetalBuyPaymentSuccess } = await import(
    "../src/services/digital-metals-buy-finalize.service.js"
  );
  const result = await finalizeDigitalMetalBuyPaymentSuccess({
    tenantId: tenant._id,
    merchantOrderId: attempt.merchantOrderId ?? attempt._id,
    transactionId: "late-txn",
    amountPaise: order.totalPayablePaise,
    currency: "INR",
    providerPayload: {},
  });
  assert.equal(result.outcome, "LATE_SUCCESS_REVIEW");
  const fresh = await DigitalMetalBuyOrder.findById(order.id).lean();
  assert.equal(fresh.status, "REFUND_REVIEW");
  assert.equal(fresh.paymentExceptionStatus, "LATE_SUCCESS");
  const refundCase = await DigitalMetalPaymentExceptionRefund.findOne({ orderId: order.id }).lean();
  assert.ok(refundCase);
});

test("unknown refund provider outcome stays pending and blocks duplicate initiation", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const orderId = createId("dmbo");
  const refundId = createId("dmref");
  await DigitalMetalBuyOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    branchId: branch._id,
    quoteId: createId("dmq"),
    status: "REFUND_REVIEW",
    metal: "GOLD",
    finenessPpm: 999000,
    quantityUg: UG_PER_G,
    totalPayablePaise: 606_000,
    quoteExpiresAt: new Date(Date.now() + 86_400_000),
    paymentAcceptanceExpiresAt: new Date(Date.now() + 86_400_000),
    termsAcceptedAt: new Date(),
    idempotencyKey: randomUUID(),
    paymentExceptionStatus: "LATE_SUCCESS",
    snapshot: {},
  });
  await DigitalMetalPaymentExceptionRefund.create({
    _id: refundId,
    tenantId: tenant._id,
    orderId,
    paymentAttemptId: createId("dmpay"),
    merchantOrderId: createId("dmpay"),
    amountPaise: 606_000,
    exceptionType: "LATE_SUCCESS",
    status: "PROVIDER_PENDING",
    providerRefundId: refundId,
  });
  const { initiateAdminDigitalMetalBuyOrderRefund, confirmDigitalMetalPaymentExceptionRefundFromProvider } =
    await import("../src/services/digital-metals-payment-exception.service.js");
  const inFlight = await initiateAdminDigitalMetalBuyOrderRefund({
    auth: { id: createId("user"), tenantId: tenant._id },
    params: { orderId },
  });
  assert.equal(inFlight.inFlight, true);
  const unknown = await confirmDigitalMetalPaymentExceptionRefundFromProvider({
    tenantId: tenant._id,
    payload: { merchantRefundId: refundId, state: "PENDING" },
  });
  assert.equal(unknown.outcome, "UNKNOWN");
  const still = await DigitalMetalPaymentExceptionRefund.findById(refundId).lean();
  assert.equal(still.status, "PROVIDER_PENDING");
});

test("invoice outbox crash reclaims stale lease and completes on retry", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const orderId = createId("dmbo");
  await DigitalMetalBuyOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    branchId: branch._id,
    quoteId: createId("dmq"),
    status: "CREDITED",
    metal: "GOLD",
    finenessPpm: 999000,
    quantityUg: UG_PER_G,
    totalPayablePaise: 606_000,
    quoteExpiresAt: new Date(Date.now() + 86_400_000),
    paymentAcceptanceExpiresAt: new Date(Date.now() + 86_400_000),
    termsAcceptedAt: new Date(),
    idempotencyKey: randomUUID(),
    creditedAt: new Date(),
    invoiceStatus: "PENDING",
    snapshot: { totalPayablePaise: 606_000, taxLines: [] },
  });
  const eventId = createId("dmobx");
  const { DIGITAL_METAL_OUTBOX_TOPICS } = await import("../src/lib/digital-metals-outbox.js");
  await DigitalMetalOutboxEvent.create({
    _id: eventId,
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_INVOICE_REQUEST,
    key: `${orderId}:invoice`,
    payload: { orderId },
    status: "PROCESSING",
    dispatchLeaseOwner: "stale_worker",
    dispatchLeaseExpiresAt: new Date(Date.now() - 60_000),
    availableAt: new Date(Date.now() - 120_000),
  });
  const { runDigitalMetalOutboxDispatch } = await import(
    "../src/services/digital-metals-outbox-dispatch.service.js"
  );
  await runDigitalMetalOutboxDispatch();
  const fresh = await DigitalMetalBuyOrder.findById(orderId).lean();
  assert.equal(fresh.invoiceStatus, "READY");
  assert.ok(fresh.invoiceUploadId);
  const evt = await DigitalMetalOutboxEvent.findById(eventId).lean();
  assert.equal(evt.status, "PROCESSED");
});

test("refund success on credited order with reserved metal does not claw back holdings", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, attempt } = await seedPayableBuyOrder({
    tenant,
    branch,
    customer,
    token,
    adminToken: bearerFor(user),
  });
  const { completeTestHarnessBuyPayment } = await import(
    "../src/services/digital-metals-buy-payment.service.js"
  );
  await completeTestHarnessBuyPayment({
    auth: { id: customer._id, tenantId: tenant._id },
    params: { orderId: order.id },
    body: { outcome: "COMPLETED" },
  });
  await withTransaction(async (session) => {
    await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G5 - UG_PER_G,
      idempotencyKey: "top-up-reserve-test",
    });
    await reserveWalletQuantity(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G4,
      purpose: "SELL",
      idempotencyKey: "reserve-for-refund-test",
    });
  });
  const walletBefore = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  const refundId = createId("dmref");
  await DigitalMetalPaymentExceptionRefund.create({
    _id: refundId,
    tenantId: tenant._id,
    orderId: order.id,
    paymentAttemptId: attempt._id,
    merchantOrderId: attempt.merchantOrderId ?? attempt._id,
    amountPaise: order.totalPayablePaise,
    exceptionType: "DUPLICATE_PAYMENT",
    status: "PROVIDER_PENDING",
    providerRefundId: refundId,
  });
  await DigitalMetalBuyOrder.updateOne(
    { _id: order.id },
    { $set: { paymentExceptionStatus: "DUPLICATE_PAYMENT_REFUND_REQUIRED" } },
  );
  const { confirmDigitalMetalPaymentExceptionRefundFromProvider } = await import(
    "../src/services/digital-metals-payment-exception.service.js"
  );
  await confirmDigitalMetalPaymentExceptionRefundFromProvider({
    tenantId: tenant._id,
    payload: { merchantRefundId: refundId, state: "COMPLETED" },
  });
  const walletAfter = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.equal(walletAfter.heldUg, walletBefore.heldUg);
  assert.equal(walletAfter.reservedUg, walletBefore.reservedUg);
  assert.ok(Number(walletAfter.heldUg) - Number(walletAfter.reservedUg) >= 0);
});
