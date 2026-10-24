import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { EcommerceOrder } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { enableEcommercePaymentsTestHarness } from "./helpers/ecommerce-checkout-fixtures.js";
import { seedReady, quoteAndOrder } from "./helpers/ecommerce-payment-test-flow.js";
import { Permission } from "../src/constants/permissions.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  stopTestDb,
  startTestDb,
} from "./helpers/db.js";
import { customerToken } from "./helpers/ecommerce-payment-test-flow.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.describe("ecommerce integration gaps", () => {
  test.beforeEach(async () => {
    await resetTestDb();
    enableEcommercePaymentsTestHarness();
  });

  test("admin customer ecommerce orders require scope and paginate", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const token = bearerFor(user, [
    ...(ROLE_PERMISSIONS[user.role] ?? []),
    Permission.ECOMMERCE_READ,
    Permission.CUSTOMER_READ,
  ]);
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+918800000401",
  });
  const other = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+918800000402",
  });
  const { product } = await seedReady({ tenant, user, branch, app });
  await quoteAndOrder({
    tenant,
    branch,
    product,
    customer,
    app,
  });
  const denied = await request(app)
    .get(`/api/v1/admin/customers/${createId("customer")}/ecommerce/orders`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(denied.status, 404);

  const list = await request(app)
    .get(`/api/v1/admin/customers/${customer._id}/ecommerce/orders?limit=10`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(list.status, 200);
  assert.equal(Array.isArray(list.body.data), true);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.meta?.ecommerceSummary?.orderCount, 1);

  const isolated = await request(app)
    .get(`/api/v1/admin/customers/${other._id}/ecommerce/orders`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(isolated.status, 200);
  assert.equal(isolated.body.data.length, 0);
});

test("customer shop orders cursor list paginates", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+918800000101",
  });
  const token = await customerToken({ tenant, branch, customer });

  for (let i = 0; i < 4; i += 1) {
    await EcommerceOrder.create({
      _id: createId("eord"),
      tenantId: tenant._id,
      customerId: customer._id,
      orderNumber: `EC-TEST-${i}`,
      status: "CANCELLED",
      fulfilmentMode: "BRANCH_PICKUP",
      totalPaise: 1000,
      subtotalPaise: 1000,
      lines: [],
    });
  }

  const page1 = await request(app)
    .get("/api/v1/app/shop/orders?limit=2")
    .set("authorization", `Bearer ${token}`);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.length, 2);
  assert.ok(page1.body.meta?.nextCursor);

  const page2 = await request(app)
    .get(`/api/v1/app/shop/orders?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(page2.status, 200);
  assert.ok(page2.body.data.length >= 1);
});

test("grievance rejects forged order relatedEntity", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+918800000301",
  });
  const other = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+918800000302",
  });
  const orderId = createId("eord");
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: other._id,
    orderNumber: "EC-GRIEV-1",
    status: "DELIVERED",
    fulfilmentMode: "BRANCH_PICKUP",
    totalPaise: 50_000,
    subtotalPaise: 50_000,
    lines: [{ name: "Ring", quantity: 1, unitPricePaise: 50_000, lineTotalPaise: 50_000 }],
  });
  const victimToken = await customerToken({ tenant, branch, customer: other });
  const intruderToken = await customerToken({ tenant, branch, customer });

  const bad = await request(app)
    .post("/api/v1/app/grievances")
    .set("authorization", `Bearer ${intruderToken}`)
    .set("x-idempotency-key", createId("grv"))
    .send({
      category: "OTHER",
      subject: "Help with order",
      description: "Need help with my shop order please.",
      relatedEntity: { type: "ORDER", id: orderId },
    });
  assert.equal(bad.status, 422);

  const ok = await request(app)
    .post("/api/v1/app/grievances")
    .set("authorization", `Bearer ${victimToken}`)
    .set("x-idempotency-key", createId("grv"))
    .send({
      category: "OTHER",
      subject: "Help with order",
      description: "Need help with my shop order please.",
      relatedEntity: { type: "ORDER", id: orderId },
    });
  assert.equal(ok.status, 201);
});
});
