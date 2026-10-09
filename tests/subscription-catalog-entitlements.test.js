import test from "node:test";
import assert from "node:assert/strict";
import { BillingCycle, PlanTier } from "../src/constants/enums.js";
import { SubscriptionPlan, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { isPlanFeatureEnabled, resolvePlanFeatureBooleans } from "../src/lib/feature-entitlements.js";
import { attachSubscriptionCatalogPlan } from "../src/lib/subscription-plan-for-tenant.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("legacy tenant without snapshot inherits ecommerce from live GROWTH catalog", async () => {
  await SubscriptionPlan.create({
    _id: createId("subscriptionPlan"),
    tier: PlanTier.GROWTH,
    name: "Growth",
    billingCycle: BillingCycle.MONTHLY,
    monthlyPricePaise: 500_000,
    pricePaise: 500_000,
    features: { ecommerce: true },
    active: true,
  });
  const tenant = await Tenant.create({
    _id: createId("tenant"),
    code: "MEHER",
    name: "MEHER",
    mobile: "+919800000099",
    subscription: { tier: PlanTier.GROWTH, features: [] },
  });
  const raw = tenant.toObject();
  assert.equal(isPlanFeatureEnabled(raw, "ecommerce"), false);
  const hydrated = await attachSubscriptionCatalogPlan(raw);
  assert.equal(isPlanFeatureEnabled(hydrated, "ecommerce"), true);
  assert.equal(resolvePlanFeatureBooleans(hydrated).ecommerce, true);
});
