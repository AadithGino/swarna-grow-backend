import test from "node:test";
import assert from "node:assert/strict";
import { patchesForProductModules, summarizeProductModules } from "../src/lib/platform-tenant-product-modules.js";

test("enableAll sets plan overrides and tenant operations", () => {
  const tenant = {
    subscription: { tier: "STARTER", featureOverrides: {} },
    operations: {},
    featureFlags: {},
  };
  const patches = patchesForProductModules(tenant, { enableAll: true });
  assert.equal(patches.featureOverrides.ecommerce, true);
  assert.equal(patches.featureOverrides.ecommercePayments, true);
  assert.equal(patches.featureOverrides.digitalMetals, true);
  assert.equal(patches.operationsPatch.ecommerceEnabled, true);
  assert.equal(patches.operationsPatch.ecommercePaymentsRolloutEnabled, true);
  assert.equal(patches.operationsPatch.digitalMetalsEnabled, true);
  assert.equal(patches.featureFlags.onlinePayments, true);

  const merged = {
    ...tenant,
    subscription: {
      ...tenant.subscription,
      featureOverrides: patches.featureOverrides,
    },
    operations: patches.operationsPatch,
  };
  const summary = summarizeProductModules(merged);
  assert.equal(summary.ecommerce.active, true);
  assert.equal(summary.digitalMetals.active, true);
});