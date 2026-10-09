import test from "node:test";
import assert from "node:assert/strict";
import { PlanTier } from "../src/constants/enums.js";
import * as commerce from "../src/services/ecommerce-commerce.service.js";
import { attachSubscriptionCatalogPlan } from "../src/lib/subscription-plan-for-tenant.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function entitledTenant(tenant) {
  return {
    ...tenant.toObject(),
    subscription: {
      ...tenant.subscription,
      tier: PlanTier.PRO,
      planFeaturesSnapshot: { ecommerce: true },
    },
    operations: { ecommerceEnabled: true },
  };
}

async function customerReq(tenant, customerId) {
  const base = entitledTenant(tenant);
  const hydrated = await attachSubscriptionCatalogPlan(base);
  return {
    auth: { tenantId: tenant._id, id: customerId, type: "CUSTOMER" },
    tenant: hydrated,
    body: {},
    params: {},
    query: {},
  };
}

test("customer addresses are tenant-scoped", async () => {
  const a = await seedTenantUser({ tenantCode: "ECA1" });
  const b = await seedTenantUser({ tenantCode: "ECA2" });
  const reqA = await customerReq(a.tenant, "cust_a");
  reqA.body = {
    line1: "12 MG Road",
    city: "Kochi",
    state: "Kerala",
    pincode: "682001",
    isDefault: true,
  };
  const created = await commerce.createCustomerAddress(reqA);
  assert.ok(created.id);
  const listA = await commerce.listCustomerAddresses(reqA);
  assert.equal(listA.items.length, 1);

  const reqB = await customerReq(b.tenant, "cust_b");
  const listB = await commerce.listCustomerAddresses(reqB);
  assert.equal(listB.items.length, 0);

  await assert.rejects(
    () =>
      commerce.patchCustomerAddress({
        ...reqB,
        params: { addressId: created.id },
        body: { expectedVersion: 1, city: "Hacked" },
      }),
    (err) => err.statusCode === 404,
  );
});
