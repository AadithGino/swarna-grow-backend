import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import { createApp } from "../src/app.js";
import { DIGITAL_METAL_OUTBOX_TOPICS } from "../src/lib/digital-metals-outbox.js";
import { digitalMetalInboxEventKey } from "../src/lib/digital-metals-customer-notice.js";
import { deliverDigitalMetalCustomerPushNotice } from "../src/lib/digital-metals-inbox-notify.js";
import { PlanTier, MessageType } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import {
  DigitalMetalOutboxEvent,
  DigitalMetalPhysicalOutEvent,
  DigitalMetalRedemptionCatalogItem,
  DigitalMetalRedemptionOrder,
  Message,
  Tenant,
} from "../src/models/index.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { makeTenantQuoteReady } from "./helpers/digital-metals-live-ready.js";
import { createId } from "../src/lib/ids.js";
import { signAccessToken } from "../src/services/token.service.js";
import { Session } from "../src/models/index.js";
import { withTransaction } from "../src/lib/transaction.js";
import { creditWalletForTest } from "../src/services/digital-metals-ledger.service.js";
import { seedCustomerDeliveryAddress } from "./helpers/digital-metals-redemption-delivery-fixture.js";

const app = createApp();
const G2 = 2 * UG_PER_G;

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
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

async function seedDeliveryOrderAtInvestigation({ tenant, branch, user, customer }) {
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: 5 * UG_PER_G,
      idempotencyKey: randomUUID(),
    }),
  );
  const item = await DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: tenant._id,
    sku: "GOLD-2G",
    label: "2g coin",
    metal: "GOLD",
    finenessPpm: 999_000,
    unitQuantityUg: G2,
    mintingRule: { type: "NONE" },
    deliveryEnabled: true,
    pickupEnabled: false,
    active: true,
  });
  const token = await customerToken({ tenant, branch, customer });
  const deliveryAddressId = await seedCustomerDeliveryAddress({
    tenantId: tenant._id,
    customerId: customer._id,
  });
  const quote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/redemption")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      catalogueItemId: item._id,
      metal: "GOLD",
      finenessPpm: 999000,
      unitCount: 1,
      fulfilmentMode: "DELIVERY",
      deliveryAddressId,
    });
  const orderId = (
    await request(app)
      .post("/api/v1/app/digital-metals/redemption/orders")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        quoteId: quote.body.data.quoteId,
        termsVersionAccepted: quote.body.data.termsVersion,
        termsContentHashAccepted: quote.body.data.termsContentHash,
      })
  ).body.data.id;
  const adminToken = bearerFor(user);
  for (const step of ["accept", "packing"]) {
    const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
    const body =
      step === "accept"
        ? { expectedVersion: row.version, fulfilmentBranchId: branch._id }
        : { expectedVersion: row.version };
    const res = await request(app)
      .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/${step}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send(body);
    assert.equal(res.status, 200, step);
  }
  const packing = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const dispatchIdem = randomUUID();
  const dispatch = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", dispatchIdem)
    .send({ expectedVersion: packing.version, carrier: "BlueDart", trackingReference: "ORIG-1" });
  assert.equal(dispatch.status, 200);
  const dispatched = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const inv = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/investigation`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: dispatched.version, reason: "Damaged in transit" });
  assert.equal(inv.status, 200);
  return { orderId, adminToken, customer, tenant, dispatchIdem };
}

test("original dispatch and replacement dispatch create distinct outbox intents (real Mongo)", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken } = await seedDeliveryOrderAtInvestigation({
    tenant,
    branch,
    user,
    customer,
  });
  const outboxBefore = await DigitalMetalOutboxEvent.find({
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.REDEMPTION_CUSTOMER_NOTICE,
    "payload.orderId": orderId,
  }).lean();
  const dispatchedNotices = outboxBefore.filter((o) => o.payload.transition === "DISPATCHED");
  assert.equal(dispatchedNotices.length, 1);
  assert.ok(dispatchedNotices[0].payload.shipmentEventId);

  const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const replacement = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/replacement-dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: row.version, carrier: "BlueDart", trackingReference: "REPL-1" });
  assert.equal(replacement.status, 200);

  const outboxAfter = await DigitalMetalOutboxEvent.find({
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.REDEMPTION_CUSTOMER_NOTICE,
    "payload.orderId": orderId,
  }).lean();
  const dispatchedAfter = outboxAfter.filter((o) => o.payload.transition === "DISPATCHED");
  const replacementNotices = outboxAfter.filter((o) => o.payload.transition === "REPLACEMENT_DISPATCHED");
  assert.equal(dispatchedAfter.length, 1);
  assert.equal(replacementNotices.length, 1);
  assert.notEqual(dispatchedAfter[0].key, replacementNotices[0].key);
  assert.ok(replacementNotices[0].payload.shipmentEventId);
});

test("replacement dispatch replay is idempotent for shipment and outbox (real Mongo)", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken } = await seedDeliveryOrderAtInvestigation({
    tenant,
    branch,
    user,
    customer,
  });
  const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const idem = randomUUID();
  const first = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/replacement-dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", idem)
    .send({ expectedVersion: row.version, carrier: "X", trackingReference: "R1" });
  assert.equal(first.status, 200);
  const second = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/replacement-dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", idem)
    .send({ expectedVersion: row.version, carrier: "X", trackingReference: "R1" });
  assert.equal(second.status, 200);
  const order = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const replacements = (order.shipmentHistory ?? []).filter((h) => h.event === "REPLACEMENT_DISPATCHED");
  assert.equal(replacements.length, 1);
  assert.equal(
    await DigitalMetalOutboxEvent.countDocuments({
      tenantId: tenant._id,
      topic: DIGITAL_METAL_OUTBOX_TOPICS.REDEMPTION_CUSTOMER_NOTICE,
      "payload.transition": "REPLACEMENT_DISPATCHED",
      "payload.orderId": orderId,
    }),
    1,
  );
});

test("replacement dispatch does not create physical-out events (real Mongo)", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken } = await seedDeliveryOrderAtInvestigation({
    tenant,
    branch,
    user,
    customer,
  });
  const before = await DigitalMetalPhysicalOutEvent.countDocuments({ redemptionOrderId: orderId });
  const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const res = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/replacement-dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: row.version, carrier: "C", trackingReference: "R2" });
  assert.equal(res.status, 200);
  assert.equal(await DigitalMetalPhysicalOutEvent.countDocuments({ redemptionOrderId: orderId }), before);
});

test("replacement dispatch rollback creates neither shipment row nor outbox intent (real Mongo)", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken } = await seedDeliveryOrderAtInvestigation({
    tenant,
    branch,
    user,
    customer,
  });
  const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const originalCreate = DigitalMetalOutboxEvent.create.bind(DigitalMetalOutboxEvent);
  DigitalMetalOutboxEvent.create = async (docs, opts) => {
    const doc = Array.isArray(docs) ? docs[0] : docs;
    if (doc?.payload?.transition === "REPLACEMENT_DISPATCHED") {
      throw new Error("SIMULATED_OUTBOX_FAILURE");
    }
    return originalCreate(docs, opts);
  };
  try {
    const res = await request(app)
      .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/replacement-dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({ expectedVersion: row.version, carrier: "C", trackingReference: "RB" });
    assert.notEqual(res.status, 200);
    const order = await DigitalMetalRedemptionOrder.findById(orderId).lean();
    assert.equal(order.status, "INVESTIGATION");
    assert.equal(
      (order.shipmentHistory ?? []).filter((h) => h.event === "REPLACEMENT_DISPATCHED").length,
      0,
    );
    assert.equal(
      await DigitalMetalOutboxEvent.countDocuments({
        tenantId: tenant._id,
        "payload.transition": "REPLACEMENT_DISPATCHED",
        "payload.orderId": orderId,
      }),
      0,
    );
  } finally {
    DigitalMetalOutboxEvent.create = originalCreate;
  }
});

test("replacement notification dedupe reuses inbox event on dispatch retry (real Mongo)", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken } = await seedDeliveryOrderAtInvestigation({
    tenant,
    branch,
    user,
    customer,
  });
  const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/replacement-dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: row.version, carrier: "C", trackingReference: "R3" });
  const outbox = await DigitalMetalOutboxEvent.findOne({
    tenantId: tenant._id,
    "payload.transition": "REPLACEMENT_DISPATCHED",
    "payload.orderId": orderId,
  }).lean();
  assert.ok(outbox?.payload?.shipmentEventId);
  const inboxEventKey = digitalMetalInboxEventKey(
    "redemption",
    orderId,
    `REPLACEMENT_DISPATCHED:${outbox.payload.shipmentEventId}`,
  );
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "settings.reminderConfig.push.enabled": true } },
  );
  const first = await deliverDigitalMetalCustomerPushNotice({
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    type: MessageType.DIGITAL_METAL_REDEMPTION_UPDATE,
    inboxEventKey,
    templateParams: { title: "t", body: "b", deepLink: "/x" },
  });
  assert.equal(first.outcome, "QUEUED");
  const second = await deliverDigitalMetalCustomerPushNotice({
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    type: MessageType.DIGITAL_METAL_REDEMPTION_UPDATE,
    inboxEventKey,
    templateParams: { title: "t2", body: "b2", deepLink: "/x" },
  });
  assert.equal(second.outcome, "ALREADY_NOTIFIED");
  assert.equal(await Message.countDocuments({ tenantId: tenant._id, "templateParams.inboxEventKey": inboxEventKey }), 1);
});
