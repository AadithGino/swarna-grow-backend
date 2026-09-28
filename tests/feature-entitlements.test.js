import test from "node:test";
import assert from "node:assert/strict";
import {
  assertFeatureEntitled,
  assertPlatformCapability,
  effectivePlatformFlags,
  isPlatformFlagEnabled,
  resolvePlanFeatureBooleans,
} from "../src/lib/feature-entitlements.js";
import { PlanTier } from "../src/constants/enums.js";

const baseTenant = {
  subscription: { tier: PlanTier.STARTER, features: [], planFeaturesSnapshot: null },
  featureFlags: {},
};

test("unset platform kill switches default to enabled", () => {
  assert.equal(isPlatformFlagEnabled(baseTenant, "onlinePayments"), true);
});

test("overlap feature requires plan and platform flag", () => {
  const tenant = {
    ...baseTenant,
    subscription: {
      tier: PlanTier.GROWTH,
      planFeaturesSnapshot: { customerSelfEnrol: true },
      features: [],
    },
    featureFlags: { customerSelfEnrol: false },
  };
  assert.throws(
    () => assertFeatureEntitled(tenant, "customerSelfEnrol"),
    (err) => err.code === "FEATURE_NOT_ENTITLED",
  );
  const flags = effectivePlatformFlags({
    ...tenant,
    featureFlags: { customerSelfEnrol: true },
  });
  assert.equal(flags.customerSelfEnrol, true);
});

test("online payments capability respects explicit disable", () => {
  assertPlatformCapability(baseTenant, "onlinePayments");
  assert.throws(
    () =>
      assertPlatformCapability(
        { ...baseTenant, featureFlags: { onlinePayments: false } },
        "onlinePayments",
      ),
    (err) => err.code === "PLATFORM_CAPABILITY_DISABLED",
  );
});

test("planFeaturesSnapshot overrides tier defaults", () => {
  const tenant = {
    ...baseTenant,
    subscription: {
      tier: PlanTier.STARTER,
      planFeaturesSnapshot: { flexibleScheme: true },
    },
  };
  assert.equal(resolvePlanFeatureBooleans(tenant).flexibleScheme, true);
});
