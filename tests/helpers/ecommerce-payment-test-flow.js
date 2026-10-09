import assert from "node:assert/strict";
import request from "supertest";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import {
  EcommerceFulfilmentMode,
  EcommercePriceMode,
  EcommerceStockPolicy,
  PlanTier,
} from "../../src/constants/enums.js";
import { Session, Tenant, WebhookEvent } from "../../src/models/index.js";
import { createId } from "../../src/lib/ids.js";
import * as ecommerce from "../../src/services/ecommerce.service.js";
import { processWebhook } from "../../src/workers/processors.js";
import { configureTenantPhonePe } from "./gateway-http-fixture.js";
import { taxReadyCatalogBody, taxReadyFulfilmentBody } from "./ecommerce-checkout-fixtures.js";
import { bearerFor } from "./db.js";

export async function enableEcommercePaymentStore(tenant) {
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

export async function customerToken({ tenant, branch, customer }) {
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
  const { signAccessToken } = await import("../../src/services/token.service.js");
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

export async function seedReady({ tenant, user, branch, app, qty = 5 }) {
  await enableEcommercePaymentStore(tenant);
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

export async function quoteAndOrder({ tenant, branch, product, customer, app }) {
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
  assert.equal(orderRes.status, 201);
  return {
    token,
    orderId: orderRes.body.data.id,
    totalPaise: orderRes.body.data.totalPaise,
    productId: product.id,
  };
}

export function phonePeWebhookAuthorization() {
  return `Basic ${Buffer.from("wh-user:wh-pass").toString("base64")}`;
}

export async function postCompletedWebhookHttp({
  app,
  tenantId,
  merchantOrderId,
  amountPaise,
  transactionId = "txn-ec-http",
}) {
  const body = JSON.stringify({
    type: "CHECKOUT_ORDER_COMPLETED",
    payload: {
      originalMerchantOrderId: merchantOrderId,
      amount: amountPaise,
      currency: "INR",
      paymentDetails: [{ state: "COMPLETED", transactionId }],
    },
  });
  const res = await request(app)
    .post(`/api/v1/webhooks/phonepe/${tenantId}`)
    .set("Content-Type", "application/json")
    .set("Authorization", phonePeWebhookAuthorization())
    .send(body);
  let eventId = res.body?.data?.eventId;
  if (!eventId && res.status === 200) {
    const { WebhookEvent: WebhookEventModel } = await import("../../src/models/index.js");
    const latest = await WebhookEventModel.findOne({ tenantId, provider: "PHONEPE" })
      .sort({ createdAt: -1 })
      .lean();
    eventId = latest?._id;
  }
  if (eventId) {
    await processWebhook({ data: { webhookEventId: eventId }, attemptsMade: 0 });
  }
  return res;
}

export async function postRefundWebhookHttp({
  app,
  tenantId,
  type,
  payload,
  providerEventId,
}) {
  const res = await request(app)
    .post(`/api/v1/webhooks/phonepe/${tenantId}`)
    .set("Content-Type", "application/json")
    .set("Authorization", phonePeWebhookAuthorization())
    .send(JSON.stringify({ type, payload }));
  let eventId = res.body?.data?.eventId;
  if (!eventId && res.status === 200) {
    const { WebhookEvent: WebhookEventModel } = await import("../../src/models/index.js");
    const latest = await WebhookEventModel.findOne({ tenantId, provider: "PHONEPE" })
      .sort({ createdAt: -1 })
      .lean();
    eventId = latest?._id;
  }
  if (eventId) {
    await processWebhook({
      data: { webhookEventId: eventId },
      attemptsMade: 0,
    });
  }
  return { res, providerEventId: providerEventId ?? eventId };
}

export async function postCompletedWebhook({
  tenantId,
  merchantOrderId,
  amountPaise,
  transactionId = "txn-ec-1",
}) {
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
