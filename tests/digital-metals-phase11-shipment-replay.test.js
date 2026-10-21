import { randomUUID } from "node:crypto";
process.env.NODE_ENV = "test";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { DigitalMetalRedemptionOrder } from "../src/models/index.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { seedDeliveryOrderReadyToDispatch } from "./helpers/digital-metals-shipment-replay-seed.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
  const { clearRedemptionFulfilmentTestHooksForTests } = await import(
    "../src/lib/digital-metals-redemption-fulfilment-test-hooks.js"
  );
  clearRedemptionFulfilmentTestHooksForTests();
});

test("dispatch replay recovers committed shipment when expectedVersion is stale", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken } = await seedDeliveryOrderReadyToDispatch({
    tenant,
    branch,
    user,
    customer,
    app,
  });
  const packing = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const staleVersion = packing.version;
  const idem = randomUUID();
  const dispatch = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", idem)
    .send({ expectedVersion: staleVersion, carrier: "DHL", trackingReference: "TRK-1" });
  assert.equal(dispatch.status, 200);
  const replay = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", idem)
    .send({ expectedVersion: staleVersion, carrier: "DHL", trackingReference: "TRK-1" });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body?.data?.status, "DISPATCHED");
  assert.equal(
    (await DigitalMetalRedemptionOrder.findById(orderId).lean()).shipmentHistory.filter((h) => h.event === "DISPATCHED")
      .length,
    1,
  );
});

test("dispatch idempotency key with mismatched payload conflicts", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken } = await seedDeliveryOrderReadyToDispatch({
    tenant,
    branch,
    user,
    customer,
    app,
  });
  const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const idem = randomUUID();
  assert.equal(
    (
      await request(app)
        .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/dispatch`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Idempotency-Key", idem)
        .send({ expectedVersion: row.version, carrier: "A", trackingReference: "1" })
    ).status,
    200,
  );
  const conflict = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", idem)
    .send({ expectedVersion: row.version, carrier: "B", trackingReference: "2" });
  assert.equal(conflict.status, 409);
});

test("dispatch survives simulated HTTP crash after commit via idempotency replay", async () => {
  const { redemptionFulfilmentTestHooks } = await import(
    "../src/lib/digital-metals-redemption-fulfilment-test-hooks.js"
  );
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { orderId, adminToken } = await seedDeliveryOrderReadyToDispatch({
    tenant,
    branch,
    user,
    customer,
    app,
  });
  const row = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  const idem = randomUUID();
  redemptionFulfilmentTestHooks.dispatchAfterCommitThrowKey = idem;
  const crashed = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", idem)
    .send({ expectedVersion: row.version, carrier: "DHL", trackingReference: "TRK-crash" });
  assert.ok(crashed.status >= 500, JSON.stringify(crashed.body));
  redemptionFulfilmentTestHooks.dispatchAfterCommitThrowKey = null;
  const recovered = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/dispatch`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", idem)
    .send({ expectedVersion: row.version, carrier: "DHL", trackingReference: "TRK-crash" });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body?.data?.status, "DISPATCHED");
  assert.equal(
    (await DigitalMetalRedemptionOrder.findById(orderId).lean()).shipmentHistory.filter((h) => h.event === "DISPATCHED")
      .length,
    1,
  );
});
