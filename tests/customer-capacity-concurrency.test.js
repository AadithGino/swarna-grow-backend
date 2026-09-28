import test from "node:test";
import assert from "node:assert/strict";
import { Customer, Tenant } from "../src/models/index.js";
import { CustomerStatus } from "../src/constants/enums.js";
import { createCustomer, blockCustomer } from "../src/services/customer.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function adminReq(ctx, body = {}, params = {}) {
  return {
    auth: { id: ctx.user._id, tenantId: ctx.tenant._id, type: "TENANT_USER" },
    scope: { tenantId: ctx.tenant._id, branchId: ctx.branch._id },
    body,
    params,
  };
}

test("second active customer is blocked when plan limit is reached", async () => {
  const ctx = await seedTenantUser();
  await Tenant.updateOne(
    { _id: ctx.tenant._id },
    { $set: { "subscription.limits.activeCustomers": 1 } },
  );
  await createCustomer(adminReq(ctx, {
    name: "Seat test",
    mobile: "+919900000001",
    branchId: ctx.branch._id,
  }));
  await assert.rejects(
    () =>
      createCustomer(adminReq(ctx, {
        mobile: "+919900000002",
        name: "Seat test 2",
        branchId: ctx.branch._id,
      })),
    (err) => err?.code === "LIMIT_CUSTOMERS",
  );
  const row = await Tenant.findById(ctx.tenant._id).select("usageCounters").lean();
  assert.equal(row.usageCounters?.activeCustomers, 1);
});

test("parallel customer creates: exactly one success and one capacity rejection", async () => {
  const ctx = await seedTenantUser();
  await Tenant.updateOne(
    { _id: ctx.tenant._id },
    { $set: { "subscription.limits.activeCustomers": 1 } },
  );
  const mkReq = (mobile, name) =>
    adminReq(ctx, { name, mobile, branchId: ctx.branch._id });
  const results = await Promise.allSettled([
    createCustomer(mkReq("+919900000011", "P1")),
    createCustomer(mkReq("+919900000012", "P2")),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const fail = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(fail.length, 1);
  assert.equal(fail[0].reason?.code, "LIMIT_CUSTOMERS");
  const active = await Customer.countDocuments({
    tenantId: ctx.tenant._id,
    status: CustomerStatus.ACTIVE,
  });
  assert.equal(active, 1);
  const row = await Tenant.findById(ctx.tenant._id).select("usageCounters").lean();
  assert.equal(row.usageCounters?.activeCustomers, 1);
});

test("duplicate mobile parallel create leaves one customer and counter 1", async () => {
  const ctx = await seedTenantUser();
  await Tenant.updateOne(
    { _id: ctx.tenant._id },
    { $set: { "subscription.limits.activeCustomers": 5 } },
  );
  const body = { name: "Dup", mobile: "+919900000099", branchId: ctx.branch._id };
  const results = await Promise.allSettled([
    createCustomer(adminReq(ctx, body)),
    createCustomer(adminReq(ctx, { ...body, name: "Dup 2" })),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const dup = results.filter((r) => r.status === "rejected" && r.reason?.code === "CUSTOMER_MOBILE_EXISTS").length;
  assert.equal(ok, 1);
  assert.equal(dup, 1);
  const row = await Tenant.findById(ctx.tenant._id).select("usageCounters").lean();
  assert.equal(row.usageCounters?.activeCustomers, 1);
});

test("reactivation at capacity is blocked", async () => {
  const ctx = await seedTenantUser();
  await Tenant.updateOne(
    { _id: ctx.tenant._id },
    { $set: { "subscription.limits.activeCustomers": 1 } },
  );
  const first = await createCustomer(adminReq(ctx, {
    name: "First",
    mobile: "+919900000021",
    branchId: ctx.branch._id,
  }));
  const customerId = first._id ?? first.id;
  await blockCustomer(adminReq(ctx, {}, { customerId }), true);
  await createCustomer(adminReq(ctx, {
    name: "Replacement",
    mobile: "+919900000022",
    branchId: ctx.branch._id,
  }));
  await assert.rejects(
    () => blockCustomer(adminReq(ctx, {}, { customerId }), false),
    (err) => err?.code === "LIMIT_CUSTOMERS",
  );
});

test("unblock after freeing a seat succeeds and keeps counter aligned", async () => {
  const ctx = await seedTenantUser();
  await Tenant.updateOne(
    { _id: ctx.tenant._id },
    { $set: { "subscription.limits.activeCustomers": 1 } },
  );
  const first = await createCustomer(adminReq(ctx, {
    name: "A",
    mobile: "+919900000031",
    branchId: ctx.branch._id,
  }));
  const firstId = first._id ?? first.id;
  await blockCustomer(adminReq(ctx, {}, { customerId: firstId }), true);
  const second = await createCustomer(adminReq(ctx, {
    name: "B",
    mobile: "+919900000032",
    branchId: ctx.branch._id,
  }));
  const secondId = second._id ?? second.id;
  await blockCustomer(adminReq(ctx, {}, { customerId: secondId }), true);
  await blockCustomer(adminReq(ctx, {}, { customerId: firstId }), false);
  const row = await Tenant.findById(ctx.tenant._id).select("usageCounters").lean();
  assert.equal(row.usageCounters?.activeCustomers, 1);
  const active = await Customer.countDocuments({
    tenantId: ctx.tenant._id,
    status: CustomerStatus.ACTIVE,
  });
  assert.equal(active, 1);
});
