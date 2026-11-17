import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommerceOrderPaymentExceptionStatus,
  EcommerceOrderStatus,
  EcommercePaymentAttemptStatus,
  EcommercePriceMode,
  EcommerceStockPolicy,
  PlanTier,
} from "../src/constants/enums.js";
import {
  EcommerceInventory,
  EcommerceOrder,
  EcommercePaymentAttempt,
  EcommercePaymentAttemptEvent,
  Session,
  Tenant,
  WebhookEvent,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { processWebhook } from "../src/workers/processors.js";
import { configureTenantPhonePe } from "./helpers/gateway-http-fixture.js";
import {
  disableEcommercePaymentsTestHarness,
  enableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.describe("commerce phase D2 HTTP", () => {
  test.beforeEach(async () => {
    await resetTestDb();
    enableEcommercePaymentsTestHarness();
  });

async function enableStore(tenant) {
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true, ecommercePayments: true },
        "subscription.tier": PlanTier.PRO,
        "operations.ecommerceEnabled": true,
        "operations.ecommercePaymentsRolloutEnabled": true,
      },
    },
  );
  await configureTenantPhonePe(tenant._id);
}

async function customerToken({ tenant, branch, customer }) {
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "dev",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const { signAccessToken } = await import("../src/services/token.service.js");
  return signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "dev",
    securityVersion: 0,
    sessionId: session._id,
  });
}

async function seedReady({ tenant, user, branch, qty = 5 }) {
  await enableStore(tenant);
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: taxReadyCatalogBody(),
  });
  const adminHeaders = {
    authorization: `Bearer ${bearerFor(user)}`,
    "x-idempotency-key": createId("idem"),
  };
  await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders)
    .send(taxReadyFulfilmentBody(branch._id));
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    body: {
      name: "PayItem",
      slug: `pay-${createId("p").slice(-4)}`,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 100_000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders)
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: qty });
  return { product, adminHeaders };
}

async function quoteAndOrder({ tenant, branch, product, customer }) {
  const token = await customerToken({ tenant, branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const quoteRes = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: branch._id,
    });
  assert.equal(quoteRes.status, 201);
  const orderRes = await request(app)
    .post("/api/v1/app/shop/orders")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("o") })
    .send({ quoteId: quoteRes.body.data.id });
  if (orderRes.status !== 201) {
    throw new Error(JSON.stringify(orderRes.body));
  }
  return {
    token,
    orderId: orderRes.body.data.id,
    totalPaise: orderRes.body.data.totalPaise,
    productId: product.id,
  };
}

async function postCompletedWebhook({ tenantId, merchantOrderId, amountPaise, transactionId = "txn-ec-1" }) {
  const eventId = createId("webhook");
  await WebhookEvent.create({
    _id: eventId,
    tenantId,
    provider: "PHONEPE",
    providerEventId: `pe-${merchantOrderId}-${transactionId}`,
    status: "QUEUED",
    payload: {
      type: CallbackType.CHECKOUT_ORDER_COMPLETED,
      payload: {
        originalMerchantOrderId: merchantOrderId,
        amount: amountPaise,
        paymentDetails: [{ state: "COMPLETED", transactionId }],
      },
    },
  });
  await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  return eventId;
}

for (const scenario of ["top-up", "fully covered", "rejected", "invalidated", "replay after backing loss", "harmless projection rebuild", "capture after backing loss", "scheme shipping", "scheme shipping without backing"]) {
  const full = ["fully covered", "rejected"].includes(scenario);
  test(`matured scheme checkout handles ${scenario} orders`, async () => {
    const { tenant, user, branch } = await seedTenantUser({});
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    const { product, adminHeaders } = await seedReady({ tenant, user, branch });
    const { EcommerceProduct, EcommerceFulfilmentSettings, Scheme, LedgerEntry, EcommerceSchemeReservation, Redemption } =
      await import("../src/models/index.js");
    await EcommerceProduct.updateOne({ _id: product.id }, { $set: { schemePurchasePolicy: "ALLOW" } });
    await EcommerceFulfilmentSettings.updateOne({ tenantId: tenant._id }, { $set: { schemeCheckoutEnabled: true, "storePolicies.returnEligibilityDays": 7 } });
    const amount = full ? 400_000 : 75_000;
    const scheme = await Scheme.create({
      tenantId: tenant._id, branchId: branch._id, customerId: customer._id,
      planId: createId("plan"), enrollmentNumber: createId("enroll"),
      planSnapshot: {
        name: "Matured checkout scheme", paymentPattern: "FIXED",
        benefit: { type: "FIXED_BONUS_AMOUNT", bonusBasis: "FLAT", bonusValue: 25_000 },
        redemptionRules: { allowedModes: ["PURCHASE_ADJUSTMENT"] },
        schemePurchaseRules: { channel: "ONLINE", settlementBases: ["CASH_VALUE"] },
      },
      valueBasis: "CASH", paymentPattern: "FIXED", status: "MATURED",
      startDate: "2025-01-01", maturityDate: "2025-02-01", installmentAmountPaise: amount,
      installments: [{ number: 1, dueDate: "2025-01-01", amountPaise: amount, paidPaise: amount, status: "PAID" }],
      createdBy: user._id,
    });
    await LedgerEntry.create({
      tenantId: tenant._id, branchId: branch._id, customerId: customer._id, schemeId: scheme._id,
      type: "INSTALLMENT_PAYMENT", sequence: 1, amountPaise: amount, actorType: "USER", actorId: user._id,
    });
    const token = await customerToken({ tenant, branch, customer });
    const headers = { authorization: `Bearer ${token}` };
    const cart = await request(app).put("/api/v1/app/shop/cart").set(headers).set("x-idempotency-key", createId("c"))
      .send({ lines: [{ productId: product.id, quantity: 2 }] });
    assert.equal(cart.status, 200, JSON.stringify(cart.body));
    const shipping = scenario.startsWith("scheme shipping");
    let q;
    if (shipping) {
      await EcommerceFulfilmentSettings.updateOne({ tenantId: tenant._id }, { $set: {
        deliveryEnabled: true, serviceablePincodes: ["686692"], deliveryChargePaise: 0,
      } });
      const addr = await request(app).post("/api/v1/app/shop/addresses").set(headers).set("x-idempotency-key", createId("addr"))
        .send({ line1: "Home", city: "Kottayam", state: "Kerala", pincode: "686692" });
      assert.equal(addr.status, 201, JSON.stringify(addr.body));
      q = await request(app).post("/api/v1/app/shop/quotes").set(headers).set("x-idempotency-key", createId("q"))
        .send({ fulfilmentMode: "DELIVERY", addressId: addr.body.data.id });
      assert.equal(q.status, 201, JSON.stringify(q.body));
    } else {
      q = await request(app).post("/api/v1/app/shop/quotes").set(headers).set("x-idempotency-key", createId("q"))
        .send({ fulfilmentMode: "BRANCH_PICKUP", pickupBranchId: branch._id });
      assert.equal(q.status, 201, JSON.stringify(q.body));
    }
    const quoteId = q.body.data.id;
    const selection = { schemeId: scheme._id, basis: "CASH_VALUE" };
    const preview = await request(app).get(`/api/v1/app/shop/quotes/${quoteId}/scheme-preview`).set(headers).query(selection);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const { applied, topUpPaise, makingChargeWaivedPaise } = preview.body.data;
    assert.equal(topUpPaise, full ? 0 : 106_000);
    const orderRequest = { quoteId, schemePurchase: { ...selection, applied, topUpPaise, makingChargeWaivedPaise } };
    const placed = await request(app).post("/api/v1/app/shop/orders").set(headers).set("x-idempotency-key", createId("o"))
      .send(orderRequest);
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const order = placed.body.data;
    assert.equal(order.totalPaise, topUpPaise);
    assert.equal(order.paymentAllowed, false);
    const purchase = order.financialSnapshot.schemePurchase;
    const requestedRedemption = await Redemption.findById(purchase.redemptionId).lean();
    assert.equal(requestedRedemption.status, "REQUESTED");
    assert.equal(requestedRedemption.benefitPaise, 25_000);
    assert.equal(requestedRedemption.principalPaise + requestedRedemption.benefitPaise, applied);
    if (scenario === "rejected") {
      const rejected = await request(app).post(`/api/v1/admin/ecommerce/orders/${order.id}/fulfilment-transition`)
        .set(adminHeaders).send({ expectedVersion: order.version, targetStatus: "CANCELLED" });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.equal(rejected.body.data.status, "CANCELLED");
      assert.equal((await Redemption.findById(purchase.redemptionId).lean()).status, "REJECTED");
      assert.equal((await EcommerceSchemeReservation.findOne({ orderId: order.id }).lean()).status, "RELEASED");
      return;
    }
    const approve = await request(app).post(`/api/v1/admin/ecommerce/orders/${order.id}/fulfilment-transition`)
      .set(adminHeaders).send({ expectedVersion: order.version, targetStatus: "PAID" });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    if (full) {
      assert.equal(approve.body.data.status, "PAID");
    } else {
      const paymentKey = createId("pay");
      const intent = await request(app).post(`/api/v1/app/shop/orders/${order.id}/payment-intents`)
        .set(headers).set("x-idempotency-key", paymentKey).send({ redirectUrl: "https://example.com/return" });
      assert.ok([200, 201].includes(intent.status), JSON.stringify(intent.body));
      const attempt = await EcommercePaymentAttempt.findOne({ orderId: order.id }).lean();
      assert.equal(attempt.amountPaise, topUpPaise);
      if (scenario === "replay after backing loss") {
        await Scheme.updateOne({ _id: scheme._id }, { $set: { status: "CLOSED_PREMATURE" }, $inc: { version: 1 } });
        const fresh = await request(app).post(`/api/v1/app/shop/orders/${order.id}/payment-intents`)
          .set(headers).set("x-idempotency-key", createId("pay")).send({ redirectUrl: "https://example.com/return" });
        assert.equal(fresh.status, 409, JSON.stringify(fresh.body));
        assert.equal(fresh.body.error.code, "SCHEME_BACKING_CHANGED");
        const replay = await request(app).post(`/api/v1/app/shop/orders/${order.id}/payment-intents`)
          .set(headers).set("x-idempotency-key", paymentKey).send({ redirectUrl: "https://example.com/return" });
        assert.equal(replay.status, 409, JSON.stringify(replay.body));
        assert.equal(replay.body.error.code, "SCHEME_BACKING_CHANGED");
        const poll = await request(app).get(`/api/v1/app/shop/orders/${order.id}/payment-intents/${attempt._id}`).set(headers);
        assert.equal(poll.status, 409, JSON.stringify(poll.body));
        assert.equal(poll.body.error.code, "SCHEME_BACKING_CHANGED");
        return;
      }
      if (scenario === "capture after backing loss") {
        await Scheme.updateOne({ _id: scheme._id }, { $set: { status: "CLOSED_PREMATURE" }, $inc: { version: 1 } });
        const callback = { tenantId: tenant._id, merchantOrderId: attempt.merchantOrderId ?? attempt._id, amountPaise: topUpPaise };
        await postCompletedWebhook(callback);
        const captured = await EcommerceOrder.findById(order.id).lean();
        assert.equal(captured.status, "CANCELLED");
        assert.equal(captured.paymentExceptionPayload.reason, "SCHEME_BACKING_CHANGED");
        const { EcommercePaymentExceptionRefund, EcommerceStockReservation } = await import("../src/models/index.js");
        const refund = await EcommercePaymentExceptionRefund.findOne({ orderId: order.id }).lean();
        assert.equal(refund.amountPaise, topUpPaise);
        assert.equal(refund.status, "ASSIGNED");
        assert.equal(await EcommerceStockReservation.countDocuments({ orderId: order.id, releasedAt: null }), 0);
        assert.equal((await EcommerceSchemeReservation.findOne({ orderId: order.id }).lean()).status, "RELEASED");
        assert.equal((await Redemption.findById(purchase.redemptionId).lean()).status, "REJECTED");
        return;
      }
      const payment = await request(app).post(`/api/v1/app/shop/orders/${order.id}/test-harness/complete-payment`)
        .set(headers).set("x-idempotency-key", createId("pay")).send({ outcome: "COMPLETED", paymentAttemptId: attempt._id });
      assert.equal(payment.status, 200, JSON.stringify(payment.body));
    }
    assert.equal((await EcommerceSchemeReservation.findOne({ orderId: order.id }).lean()).status, "HELD");
    const paid = await EcommerceOrder.findById(order.id).lean();
    assert.equal(paid.status, "PAID");
    if (shipping) {
      if (scenario === "scheme shipping without backing") {
        await Scheme.updateOne({ _id: scheme._id }, { $set: { status: "CLOSED_PREMATURE" }, $inc: { version: 1 } });
      }
      const ship = await request(app).post(`/api/v1/admin/ecommerce/orders/${order.id}/ship`)
        .set(adminHeaders).set("x-idempotency-key", createId("ship"))
        .send({ expectedVersion: paid.version, carrierName: "BlueDart", trackingNumber: "BD999", trackingUrl: "https://example.com/t/BD999" });
      if (scenario === "scheme shipping without backing") {
        assert.equal(ship.status, 409, JSON.stringify(ship.body));
        assert.equal(ship.body.error.code, "SCHEME_BACKING_CHANGED");
        assert.equal((await EcommerceOrder.findById(order.id).lean()).status, "PAID");
        return;
      }
      assert.equal(ship.status, 200, JSON.stringify(ship.body));
      const delivered = await request(app).post(`/api/v1/admin/ecommerce/orders/${order.id}/confirm-delivery`)
        .set(adminHeaders).set("x-idempotency-key", createId("deliver"))
        .send({ expectedVersion: ship.body.data.version, proofReference: "POD-12345", recipientName: "Anu Joseph" });
      assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
      assert.equal((await EcommerceSchemeReservation.findOne({ orderId: order.id }).lean()).status, "CONSUMED");
      assert.equal((await Redemption.findById(purchase.redemptionId).lean()).status, "COMPLETED");
      return;
    }
    await EcommerceOrder.updateOne({ _id: order.id }, { $set: {
      status: "READY_FOR_PICKUP", "fulfilmentHandover.recordedAt": new Date(),
    } });
    if (scenario === "invalidated") {
      await Scheme.updateOne({ _id: scheme._id }, { $set: { status: "CLOSED_PREMATURE" }, $inc: { version: 1 } });
    }
    if (scenario === "harmless projection rebuild") {
      const { recomputeScheme } = await import("../src/services/scheme.service.js");
      await recomputeScheme({ params: { schemeId: scheme._id }, scope: { tenantId: tenant._id },
        auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: "TENANT_OWNER" },
        headers: {}, ip: "127.0.0.1" });
    }
    const delivered = await request(app).post(`/api/v1/admin/ecommerce/orders/${order.id}/fulfilment-transition`)
      .set(adminHeaders).send({ expectedVersion: paid.version, targetStatus: "DELIVERED" });
    if (scenario === "invalidated") {
      assert.equal(delivered.status, 409, JSON.stringify(delivered.body));
      assert.equal(delivered.body.error.code, "SCHEME_BACKING_CHANGED");
      assert.equal((await EcommerceOrder.findById(order.id).lean()).status, "READY_FOR_PICKUP");
      assert.equal((await Redemption.findById(purchase.redemptionId).lean()).status, "APPROVED");
      return;
    }
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
    assert.equal((await EcommerceSchemeReservation.findOne({ orderId: order.id }).lean()).status, "CONSUMED");
    assert.equal((await Redemption.findById(purchase.redemptionId).lean()).status, "COMPLETED");

    for (const returnedCount of [1, 2]) {
      const returned = await request(app).post(`/api/v1/app/shop/orders/${order.id}/return-requests`)
        .set(headers).set("x-idempotency-key", createId("return"))
        .send({ reason: "Return one of the two items", items: [{ productId: product.id, quantity: 1 }] });
      assert.equal(returned.status, 201, JSON.stringify(returned.body));
      let row = returned.body.data.request;
      assert.equal(row.refundEntitlementPaise, topUpPaise / 2);
      for (const [action, body] of [
        ["decision", { decision: "APPROVE" }],
        ["received", {}],
        ["inspection", { inspectionNote: "Checked at store", inspectionOutcome: "APPROVED_FOR_RESALE", confirmRestockInventory: true }],
        ...(!full ? [["record-manual-refund", { amountPaise: topUpPaise / 2, recipient: "Customer",
          method: "UPI", reference: `TEST-REFUND-${returnedCount}`, proofNote: "Refund proof recorded" }]] : []),
        ["resolve", { resolutionNote: "One returned item settled" }],
      ]) {
        const res = await request(app).post(`/api/v1/admin/ecommerce/return-requests/${row.id}/${action}`)
          .set(adminHeaders).set("x-idempotency-key", createId("return")).send({ expectedVersion: row.version, ...body });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        row = res.body.data.request;
      }
      if (!full) {
        const detail = await request(app).get(`/api/v1/app/shop/orders/${order.id}`).set(headers);
        assert.equal(detail.status, 200);
        assert.equal(detail.body.data.refundStatus, returnedCount === 1 ? "PARTIALLY_REFUNDED" : "REFUNDED");
        assert.equal(detail.body.data.refundedPaise, topUpPaise * returnedCount / 2);
      }
    }
    const restored = await EcommerceSchemeReservation.findOne({ orderId: order.id }).lean();
    assert.equal(restored.restoredUnits, applied);
    if (!full) {
      const { EcommercePaymentExceptionRefund } = await import("../src/models/index.js");
      const refunds = await EcommercePaymentExceptionRefund.find({ orderId: order.id }).lean();
      assert.equal(refunds.length, 2);
      assert.equal(refunds.reduce((sum, refund) => sum + refund.amountPaise, 0), topUpPaise);
    }
    assert.equal((await EcommerceInventory.findOne({ tenantId: tenant._id, productId: product.id }).lean()).quantityOnHand, 5);
  });
}

test("payment intent blocked when test harness off", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  await enableStore(tenant);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { product } = await seedReady({ tenant, user, branch });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer });
  disableEcommercePaymentsTestHarness();
  const res = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({
      authorization: `Bearer ${token}`,
      "x-idempotency-key": createId("pay"),
    })
    .send({ redirectUrl: "https://example.com/return" });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code, "PAYMENT_NOT_AVAILABLE");
});

test("payment intent idempotent replay and webhook marks PAID", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise, productId } = await quoteAndOrder({
    tenant,
    branch,
    product,
    customer,
  });
  const idem = createId("pay");
  const body = { redirectUrl: "https://example.com/return" };
  const [a, b] = await Promise.all([
    request(app)
      .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
      .send(body),
    request(app)
      .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
      .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
      .send(body),
  ]);
  assert.ok([200, 201].includes(a.status));
  assert.ok([200, 201].includes(b.status));
  const attemptId = a.body.data.paymentIntent.id;
  assert.equal(a.body.data.paymentIntent.id, b.body.data.paymentIntent.id);
  const attempts = await EcommercePaymentAttempt.countDocuments({ orderId });
  assert.equal(attempts, 1);

  const differentBody = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
    .send({ redirectUrl: "https://example.com/changed-return" });
  assert.equal(differentBody.status, 409);
  assert.equal(differentBody.body.error?.code, "IDEMPOTENCY_KEY_REUSED");

  const merchantOrderId = a.body.data.paymentIntent.merchantOrderId;
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId,
    amountPaise: totalPaise,
  });
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PAID);
  const inv = await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean();
  assert.equal(inv.quantityOnHand, 4);

  const poll = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}/payment-intents/${attemptId}`)
    .set({ authorization: `Bearer ${token}` });
  assert.equal(poll.status, 200);
  assert.equal(poll.body.data.paymentIntent.paymentCompleted, true);
});

test("payment-intent replay cannot initiate a provider charge after order expiry", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId } = await quoteAndOrder({ tenant, branch, product, customer });
  const idem = createId("pay");
  const body = { redirectUrl: "https://example.com/return" };
  const first = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
    .send(body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const attemptId = first.body.data.paymentIntent.id;
  await EcommercePaymentAttempt.updateOne(
    { _id: attemptId },
    { $set: { status: EcommercePaymentAttemptStatus.PENDING, sdkToken: null, providerOrderId: null } },
  );
  await EcommerceOrder.updateOne(
    { _id: orderId },
    { $set: { status: EcommerceOrderStatus.PAYMENT_EXPIRED, expiresAt: new Date(0) } },
  );
  const replay = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": idem })
    .send(body);
  assert.equal(replay.status, 422, JSON.stringify(replay.body));
  assert.equal(replay.body.error?.code, "ORDER_NOT_PAYABLE");
  const attempt = await EcommercePaymentAttempt.findById(attemptId).lean();
  assert.equal(attempt.sdkToken, null);
});

test("webhook amount mismatch recorded and order stays unpaid", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const merchantOrderId = created.body.data.paymentIntent.merchantOrderId;
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId,
    amountPaise: totalPaise - 1,
  });
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PENDING_PAYMENT);
  const ev = await EcommercePaymentAttemptEvent.findOne({
    tenantId: tenant._id,
    outcome: "AMOUNT_MISMATCH",
  }).lean();
  assert.ok(ev);
});

test("late success after payment expiry goes to refund exception", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const merchantOrderId = created.body.data.paymentIntent.merchantOrderId;
  await EcommerceOrder.updateOne(
    { _id: orderId },
    { $set: { status: EcommerceOrderStatus.PAYMENT_EXPIRED, stockReleasedAt: new Date() } },
  );
  await postCompletedWebhook({ tenantId: tenant._id, merchantOrderId, amountPaise: totalPaise });
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PAYMENT_EXPIRED);
  assert.equal(
    order.paymentExceptionStatus,
    EcommerceOrderPaymentExceptionStatus.LATE_SUCCESS_REFUND_REQUIRED,
  );
});

test("duplicate completed webhook is safe", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise } = await quoteAndOrder({ tenant, branch, product, customer });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const merchantOrderId = created.body.data.paymentIntent.merchantOrderId;
  await postCompletedWebhook({ tenantId: tenant._id, merchantOrderId, amountPaise: totalPaise });
  await postCompletedWebhook({
    tenantId: tenant._id,
    merchantOrderId,
    amountPaise: totalPaise,
    transactionId: "txn-dup",
  });
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.PAID);
  const succeeded = await EcommercePaymentAttempt.countDocuments({
    orderId,
    status: EcommercePaymentAttemptStatus.SUCCEEDED,
  });
  assert.equal(succeeded, 1);
});

test("cross-customer payment intent poll returns 404", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { product } = await seedReady({ tenant, user, branch });
  const customerA = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const customerB = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+918800000002",
  });
  const { token: tokenA, orderId } = await quoteAndOrder({
    tenant,
    branch,
    product,
    customer: customerA,
  });
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${tokenA}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  const attemptId = created.body.data.paymentIntent.id;
  const tokenB = await customerToken({ tenant, branch, customer: customerB });
  const res = await request(app)
    .get(`/api/v1/app/shop/orders/${orderId}/payment-intents/${attemptId}`)
    .set({ authorization: `Bearer ${tokenB}` });
  assert.equal(res.status, 404);
});
});
