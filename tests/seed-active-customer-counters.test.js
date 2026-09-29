import test from "node:test";
import assert from "node:assert/strict";
import { Tenant } from "../src/models/index.js";
import { createCustomer } from "../src/services/customer.service.js";
import {
  countActiveCustomersForTenant,
  parityForTenant,
  syncActiveCustomerCounterForTenant,
  verifyAllTenantsInSync,
} from "../src/lib/active-customer-counter-sync.js";
import { withTransaction } from "../src/lib/transaction.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function adminReq(ctx, body = {}) {
  return {
    auth: { id: ctx.user._id, tenantId: ctx.tenant._id, type: "TENANT_USER" },
    scope: { tenantId: ctx.tenant._id, branchId: ctx.branch._id },
    body,
    params: {},
  };
}

test("parity row reflects drift between stored counter and ACTIVE customers", async () => {
  const ctx = await seedTenantUser();
  await Tenant.updateOne(
    { _id: ctx.tenant._id },
    { $set: { "usageCounters.activeCustomers": 9 } },
  );
  const tenant = await Tenant.findById(ctx.tenant._id).lean();
  const row = await parityForTenant(tenant);
  assert.equal(row.actual, 0);
  assert.equal(row.stored, 9);
  assert.equal(row.delta, -9);
  assert.equal(row.inSync, false);
});

test("apply sync updates only activeCustomers fields and preserves other tenant fields", async () => {
  const ctx = await seedTenantUser();
  await Tenant.updateOne(
    { _id: ctx.tenant._id },
    { $set: { suspendReason: "counter-backfill-test", "usageCounters.activeCustomers": 0 } },
  );
  await createCustomer(adminReq(ctx, {
    name: "B",
    mobile: "+919900000012",
    branchId: ctx.branch._id,
  }));
  await syncActiveCustomerCounterForTenant(ctx.tenant._id);
  const row = await Tenant.findById(ctx.tenant._id).select("usageCounters suspendReason").lean();
  assert.equal(row.usageCounters.activeCustomers, 1);
  assert.equal(row.suspendReason, "counter-backfill-test");
});

test("rerun sync is idempotent when already in sync", async () => {
  const ctx = await seedTenantUser();
  await syncActiveCustomerCounterForTenant(ctx.tenant._id);
  const before = await Tenant.findById(ctx.tenant._id).select("usageCounters").lean();
  await syncActiveCustomerCounterForTenant(ctx.tenant._id);
  const after = await Tenant.findById(ctx.tenant._id).select("usageCounters").lean();
  assert.equal(after.usageCounters.activeCustomers, before.usageCounters.activeCustomers);
});

test("parallel customer create and backfill: final counter matches ACTIVE count", async () => {
  const ctx = await seedTenantUser();
  await Tenant.updateOne(
    { _id: ctx.tenant._id },
    { $set: { "subscription.limits.activeCustomers": 10, "usageCounters.activeCustomers": 0 } },
  );
  const results = await Promise.allSettled([
    syncActiveCustomerCounterForTenant(ctx.tenant._id),
    createCustomer(adminReq(ctx, {
      name: "Race",
      mobile: "+919900000099",
      branchId: ctx.branch._id,
    })),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.ok(fulfilled.length >= 1);
  const active = await countActiveCustomersForTenant(ctx.tenant._id);
  const tenant = await Tenant.findById(ctx.tenant._id).select("usageCounters").lean();
  assert.equal(tenant.usageCounters.activeCustomers, active);
});

test("rolled-back customer create does not leak a seat on the counter", async () => {
  const ctx = await seedTenantUser();
  await syncActiveCustomerCounterForTenant(ctx.tenant._id);
  await assert.rejects(
    () =>
      withTransaction(async (session) => {
        const { reserveActiveCustomerSeat } = await import("../src/lib/tenant-customer-capacity.js");
        const tenant = await Tenant.findById(ctx.tenant._id).session(session);
        await reserveActiveCustomerSeat(tenant, session);
        throw new Error("abort");
      }),
    /abort/,
  );
  const active = await countActiveCustomersForTenant(ctx.tenant._id);
  const tenant = await Tenant.findById(ctx.tenant._id).select("usageCounters").lean();
  assert.equal(tenant.usageCounters.activeCustomers, active);
});

test("verifyAllTenantsInSync reports drift after manual counter corruption", async () => {
  const ctx = await seedTenantUser();
  await syncActiveCustomerCounterForTenant(ctx.tenant._id);
  await Tenant.updateOne(
    { _id: ctx.tenant._id },
    { $set: { "usageCounters.activeCustomers": 999 } },
  );
  const drift = await verifyAllTenantsInSync();
  assert.equal(drift.length, 1);
  assert.equal(drift[0].tenantId, ctx.tenant._id);
});
