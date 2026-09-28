import test from "node:test";
import assert from "node:assert/strict";
import { BillingCycle, PlanTier } from "../src/constants/enums.js";
import { SubscriptionPlan, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { isPlanFeatureEnabled } from "../src/lib/feature-entitlements.js";
import * as platform from "../src/services/platform.service.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function growthPlanWithFlexibleDisabled() {
  return SubscriptionPlan.create({
    _id: createId("subscriptionPlan"),
    tier: PlanTier.GROWTH,
    name: "Growth audit",
    billingCycle: BillingCycle.MONTHLY,
    supportedBillingCycles: [BillingCycle.MONTHLY, BillingCycle.ANNUAL],
    monthlyPricePaise: 9_900_00,
    yearlyPricePaise: 99_000_00,
    pricePaise: 9_900_00,
    features: { flexibleScheme: false },
    limits: { activeCustomers: 100, branches: 5, staffSeats: 5, schemePlans: 10 },
    active: true,
  });
}

test("platform createTenant persists explicit false in planFeaturesSnapshot", async () => {
  const plan = await growthPlanWithFlexibleDisabled();
  const result = await platform.createTenant({
    body: {
      businessName: "Audit Jewellers",
      ownerName: "Owner",
      ownerMobile: "+919876543210",
      ownerEmail: "owner@audit.test",
      subscriptionPlanId: plan._id,
      billingCycle: BillingCycle.ANNUAL,
      createDefaultBranch: false,
    },
  });
  const tenant = await Tenant.findById(result.tenant.id).lean();
  assert.equal(tenant.subscription.planId, plan._id);
  assert.equal(tenant.subscription.billingCycle, BillingCycle.ANNUAL);
  assert.equal(tenant.subscription.planFeaturesSnapshot.flexibleScheme, false);
  assert.equal(isPlanFeatureEnabled(tenant, "flexibleScheme"), false);
});

test("changeSubscription refreshes snapshot from plan template", async () => {
  const plan = await growthPlanWithFlexibleDisabled();
  const created = await platform.createTenant({
    body: {
      businessName: "Change Plan Co",
      ownerName: "Owner",
      ownerMobile: "+919876543211",
      subscriptionPlanId: plan._id,
      billingCycle: BillingCycle.MONTHLY,
      createDefaultBranch: false,
    },
  });
  await platform.changeSubscription(created.tenant.id, "change-plan", {
    subscriptionPlanId: plan._id,
    billingCycle: BillingCycle.ANNUAL,
  });
  const tenant = await Tenant.findById(created.tenant.id).lean();
  assert.equal(tenant.subscription.billingCycle, BillingCycle.ANNUAL);
  assert.equal(tenant.subscription.planFeaturesSnapshot.flexibleScheme, false);
});

test("legacy tenant without snapshot keeps tier-default entitlements until plan assignment", async () => {
  const tenant = await Tenant.create({
    _id: createId("tenant"),
    code: "legacy1",
    name: "Legacy",
    mobile: "+919800000099",
    subscription: {
      tier: PlanTier.GROWTH,
      features: [],
      planFeaturesSnapshot: null,
    },
  });
  assert.equal(isPlanFeatureEnabled(tenant.toObject(), "flexibleScheme"), true);
  const plan = await growthPlanWithFlexibleDisabled();
  await platform.changeSubscription(tenant._id, "change-plan", {
    subscriptionPlanId: plan._id,
    billingCycle: BillingCycle.MONTHLY,
  });
  const updated = await Tenant.findById(tenant._id).lean();
  assert.equal(updated.subscription.planFeaturesSnapshot.flexibleScheme, false);
});

test("plan template edit does not mutate existing tenant snapshot", async () => {
  const plan = await growthPlanWithFlexibleDisabled();
  const created = await platform.createTenant({
    body: {
      businessName: "Snapshot Stick",
      ownerName: "Owner",
      ownerMobile: "+919876543212",
      subscriptionPlanId: plan._id,
      createDefaultBranch: false,
    },
  });
  const before = await Tenant.findById(created.tenant.id).lean();
  await SubscriptionPlan.updateOne(
    { _id: plan._id },
    { $set: { features: { flexibleScheme: true } }, $inc: { version: 1 } },
  );
  const after = await Tenant.findById(created.tenant.id).lean();
  assert.deepEqual(after.subscription.planFeaturesSnapshot, before.subscription.planFeaturesSnapshot);
  assert.equal(isPlanFeatureEnabled(after, "flexibleScheme"), false);
});
