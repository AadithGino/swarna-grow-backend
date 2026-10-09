import test from "node:test";
import assert from "node:assert/strict";
import { PlanTier } from "../src/constants/enums.js";
import { Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { isPlanFeatureEnabled, resolvePlanFeatureBooleans } from "../src/lib/feature-entitlements.js";
import {
  assertCanEnableEcommerceStore,
  isEcommerceOperational,
  presentEcommerceAccessState,
} from "../src/lib/ecommerce-access.js";
import * as tenantSettings from "../src/services/tenant-settings.service.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function tenantRow(overrides = {}) {
  return {
    subscription: {
      tier: PlanTier.STARTER,
      features: [],
      planFeaturesSnapshot: null,
      featureOverrides: {},
    },
    operations: { ecommerceEnabled: false },
    ...overrides,
  };
}

test("ecommerce defaults false for tier and legacy snapshot without key", () => {
  const legacy = tenantRow({
    subscription: {
      tier: PlanTier.GROWTH,
      planFeaturesSnapshot: { flexibleScheme: true },
      features: [],
    },
  });
  assert.equal(isPlanFeatureEnabled(legacy, "ecommerce"), false);
  assert.equal(resolvePlanFeatureBooleans(legacy).ecommerce, false);
});

test("unknown snapshot keys do not grant ecommerce", () => {
  const tenant = tenantRow({
    subscription: {
      tier: PlanTier.PRO,
      planFeaturesSnapshot: { onlineStore: true, ecomerce: true },
    },
  });
  assert.equal(isPlanFeatureEnabled(tenant, "ecommerce"), false);
});

test("plan override and entitlement combinations for store activation", () => {
  const entitledNotEnabled = tenantRow({
    subscription: {
      tier: PlanTier.STARTER,
      planFeaturesSnapshot: { ecommerce: true },
    },
    operations: { ecommerceEnabled: false },
  });
  assert.deepEqual(presentEcommerceAccessState(entitledNotEnabled), {
    planEntitled: true,
    enabled: false,
    active: false,
  });

  const enabledNotEntitled = tenantRow({
    subscription: { tier: PlanTier.STARTER, planFeaturesSnapshot: {} },
    operations: { ecommerceEnabled: true },
  });
  assert.equal(isEcommerceOperational(enabledNotEntitled), false);

  const active = tenantRow({
    subscription: {
      tier: PlanTier.STARTER,
      planFeaturesSnapshot: { ecommerce: true },
    },
    operations: { ecommerceEnabled: true },
  });
  assert.equal(isEcommerceOperational(active), true);
});

test("feature override can disable entitled plan snapshot", () => {
  const tenant = tenantRow({
    subscription: {
      tier: PlanTier.CUSTOM,
      planFeaturesSnapshot: { ecommerce: true },
      featureOverrides: { ecommerce: false },
    },
    operations: { ecommerceEnabled: true },
  });
  assert.equal(isEcommerceOperational(tenant), false);
});

test("tenant isolation: ecommerce state is per-tenant", () => {
  const a = tenantRow({
    subscription: { tier: PlanTier.PRO, planFeaturesSnapshot: { ecommerce: true } },
    operations: { ecommerceEnabled: true },
  });
  const b = tenantRow({
    subscription: { tier: PlanTier.PRO, planFeaturesSnapshot: { ecommerce: true } },
    operations: { ecommerceEnabled: false },
  });
  assert.equal(isEcommerceOperational(a), true);
  assert.equal(isEcommerceOperational(b), false);
});

test("assertCanEnableEcommerceStore rejects without plan entitlement", () => {
  assert.throws(
    () => assertCanEnableEcommerceStore(tenantRow()),
    (err) => err.code === "FEATURE_NOT_ENTITLED" && err.statusCode === 403,
  );
});

test("patchSettingsOperations rejects enable without entitlement", async () => {
  const tenant = await Tenant.create({
    _id: createId("tenant"),
    code: "ECO1",
    name: "Eco Jewellers",
    mobile: "+919811111111",
    subscription: { tier: PlanTier.GROWTH, features: [], planFeaturesSnapshot: {} },
    operations: { ecommerceEnabled: false },
    version: 1,
  });
  await assert.rejects(
    () =>
      tenantSettings.patchSettingsOperations({
        auth: { tenantId: tenant._id, id: "usr_owner" },
        body: { expectedVersion: 1, ecommerceEnabled: true },
      }),
    (err) => err.code === "FEATURE_NOT_ENTITLED" && err.statusCode === 403,
  );
  const fresh = await Tenant.findById(tenant._id).lean();
  assert.notEqual(fresh.operations?.ecommerceEnabled, true);
});

test("patchSettingsOperations allows disable and enable when entitled", async () => {
  const tenant = await Tenant.create({
    _id: createId("tenant"),
    code: "ECO2",
    name: "Eco Pro",
    mobile: "+919822222222",
    subscription: {
      tier: PlanTier.PRO,
      planFeaturesSnapshot: { ecommerce: true },
      features: [],
    },
    operations: { ecommerceEnabled: true },
    version: 1,
  });
  const disabled = await tenantSettings.patchSettingsOperations({
    auth: { tenantId: tenant._id, id: "usr_owner" },
    body: { expectedVersion: 1, ecommerceEnabled: false },
  });
  assert.equal(disabled.ecommerceEnabled, false);
  assert.equal(disabled.ecommerce.active, false);

  const enabled = await tenantSettings.patchSettingsOperations({
    auth: { tenantId: tenant._id, id: "usr_owner" },
    body: { expectedVersion: 2, ecommerceEnabled: true },
  });
  assert.equal(enabled.ecommerceEnabled, true);
  assert.equal(enabled.ecommerce.active, true);
});
