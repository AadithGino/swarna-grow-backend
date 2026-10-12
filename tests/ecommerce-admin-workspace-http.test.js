import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { EcommerceOrder } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { bearerFor, resetTestDb, seedFixture, startTestDb, stopTestDb } from "./helpers/db.js";
import { EcommerceOrderStatus, EcommercePaymentMethod } from "../src/constants/enums.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

async function seedOrders(tenantId, customerId, count) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const id = createId("eord");
    ids.push(id);
    await EcommerceOrder.create({
      _id: id,
      tenantId,
      customerId,
      orderNumber: `EC-TEST-${String(i).padStart(3, "0")}`,
      status: EcommerceOrderStatus.PAID,
      paymentMethod: EcommercePaymentMethod.ONLINE,
      paidAt: new Date(Date.now() - i * 60_000),
      subtotalPaise: 10_000,
      taxPaise: 300,
      fulfilmentChargePaise: 0,
      totalPaise: 10_300,
      lines: [],
      version: 1,
      createdAt: new Date(Date.now() - i * 60_000),
    });
  }
  return ids;
}

test("admin orders list cursor pagination page 2 and totalCount", async () => {
  const { tenant, user, customer } = await seedFixture();
  await seedOrders(tenant._id, customer._id, 3);

  const page1 = await request(app)
    .get("/api/v1/admin/ecommerce/orders")
    .query({ limit: 2 })
    .set("authorization", `Bearer ${bearerFor(user)}`);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.length, 2);
  assert.equal(page1.body.meta.hasMore, true);
  assert.equal(page1.body.meta.totalCount, 3);
  assert.ok(page1.body.meta.nextCursor);

  const page2 = await request(app)
    .get("/api/v1/admin/ecommerce/orders")
    .query({ limit: 2, cursor: page1.body.meta.nextCursor })
    .set("authorization", `Bearer ${bearerFor(user)}`);
  assert.equal(page2.status, 200);
  assert.equal(page2.body.data.length, 1);
  assert.equal(page2.body.meta.hasMore, false);
});

test("admin orders search by order number", async () => {
  const { tenant, user, customer } = await seedFixture();
  await seedOrders(tenant._id, customer._id, 2);

  const res = await request(app)
    .get("/api/v1/admin/ecommerce/orders")
    .query({ q: "EC-TEST-001" })
    .set("authorization", `Bearer ${bearerFor(user)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.match(String(res.body.data[0].orderNumber), /001/);
});

test("tenant isolation on orders list", async () => {
  const a = await seedFixture();
  const b = await seedFixture();
  await seedOrders(a.tenant._id, a.customer._id, 1);
  await seedOrders(b.tenant._id, b.customer._id, 1);

  const res = await request(app)
    .get("/api/v1/admin/ecommerce/orders")
    .set("authorization", `Bearer ${bearerFor(a.user)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].customerId, a.customer._id);
});

test("ecommerce summary requires report.read", async () => {
  const { user } = await seedFixture();
  const denied = await request(app)
    .get("/api/v1/admin/ecommerce/summary")
    .query({ period: "THIS_MONTH" })
    .set("authorization", `Bearer ${bearerFor(user, ["ecommerce.read"])}`);
  assert.equal(denied.status, 403);
});

test("ecommerce summary zero data tenant", async () => {
  const { user } = await seedFixture();
  const res = await request(app)
    .get("/api/v1/admin/ecommerce/summary")
    .query({ period: "THIS_MONTH" })
    .set("authorization", `Bearer ${bearerFor(user)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.placement.ordersPlaced, 0);
  assert.equal(res.body.data.collections.netCollected.amountPaise, 0);
});

test("order-scoped returns endpoint", async () => {
  const { tenant, user, customer } = await seedFixture();
  const [orderId] = await seedOrders(tenant._id, customer._id, 1);
  const res = await request(app)
    .get(`/api/v1/admin/ecommerce/orders/${orderId}/returns`)
    .set("authorization", `Bearer ${bearerFor(user)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.orderId, orderId);
  assert.equal(res.body.data.items.length, 0);
});
