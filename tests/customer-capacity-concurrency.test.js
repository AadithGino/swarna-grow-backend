import test from "node:test";
import assert from "node:assert/strict";
import { Tenant } from "../src/models/index.js";
import { createCustomer } from "../src/services/customer.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("second active customer is blocked when plan limit is reached", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "subscription.limits.activeCustomers": 1 } },
  );
  const baseReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    body: {
      name: "Seat test",
      mobile: "+919900000001",
      branchId: branch._id,
    },
  };
  const secondReq = {
    ...baseReq,
    body: { ...baseReq.body, mobile: "+919900000002", name: "Seat test 2" },
  };
  await createCustomer(baseReq);
  await assert.rejects(
    () => createCustomer(secondReq),
    (err) => err?.code === "LIMIT_CUSTOMERS",
  );
  const row = await Tenant.findById(tenant._id).select("usageCounters").lean();
  assert.equal(row.usageCounters?.activeCustomers, 1);
});

test("parallel customer creates: at most one succeeds when limit is one", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "subscription.limits.activeCustomers": 1 } },
  );
  const mkReq = (mobile, name) => ({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    body: { name, mobile, branchId: branch._id },
  });
  const results = await Promise.allSettled([
    createCustomer(mkReq("+919900000011", "P1")),
    createCustomer(mkReq("+919900000012", "P2")),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  assert.ok(ok <= 1);
  const row = await Tenant.findById(tenant._id).select("usageCounters").lean();
  assert.ok((row.usageCounters?.activeCustomers ?? 0) <= 1);
});
