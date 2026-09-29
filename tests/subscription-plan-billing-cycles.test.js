import test from "node:test";
import assert from "node:assert/strict";
import { BillingCycle, PlanTier } from "../src/constants/enums.js";
import { SubscriptionPlan } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as platform from "../src/services/platform.service.js";
import { getSubscriptionForAdmin } from "../src/services/tenant-settings.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { Tenant } from "../src/models/index.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("subscription plan round-trips supportedBillingCycles and annual price", async () => {
  const created = await platform.createSubscriptionPlan({
    tier: PlanTier.GROWTH,
    name: "Dual cycle",
    monthlyPricePaise: 5_000_00,
    yearlyPricePaise: 50_000_00,
    supportedBillingCycles: [BillingCycle.MONTHLY, BillingCycle.ANNUAL],
    features: { flexibleScheme: false },
    limits: { activeCustomers: 50, branches: 3, staffSeats: 3, schemePlans: 5 },
  });
  const fetched = await platform.getSubscriptionPlan(created.id ?? created._id);
  assert.deepEqual(fetched.supportedBillingCycles, [BillingCycle.MONTHLY, BillingCycle.ANNUAL]);
  assert.equal(fetched.yearlyPricePaise ?? fetched.yearlyPrice?.amountPaise, 50_000_00);
});

test("annual tenant admin subscription resolves plan by planId and billing cycle", async () => {
  const plan = await SubscriptionPlan.create({
    _id: createId("subscriptionPlan"),
    tier: PlanTier.STARTER,
    name: "Starter annual",
    billingCycle: BillingCycle.MONTHLY,
    supportedBillingCycles: [BillingCycle.MONTHLY, BillingCycle.ANNUAL],
    monthlyPricePaise: 2_000_00,
    yearlyPricePaise: 20_000_00,
    pricePaise: 2_000_00,
    active: true,
    limits: {},
    features: {},
  });
  const { tenant, user } = await seedTenantUser();
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planId": plan._id,
        "subscription.billingCycle": BillingCycle.ANNUAL,
        "subscription.tier": PlanTier.STARTER,
      },
    },
  );
  const sub = await getSubscriptionForAdmin({
    auth: { tenantId: tenant._id, id: user._id },
  });
  assert.equal(sub.currentPlan.planId, plan._id);
  assert.equal(sub.currentPlan.billingCycle, BillingCycle.ANNUAL);
  assert.equal(sub.currentPlan.cyclePrice.amountPaise, 20_000_00);
});

test("legacy plan without supportedBillingCycles reads both cycles from monthly billingCycle", async () => {
  const plan = await SubscriptionPlan.create({
    _id: createId("subscriptionPlan"),
    tier: PlanTier.STARTER,
    name: "Legacy monthly",
    billingCycle: BillingCycle.MONTHLY,
    monthlyPricePaise: 1_000_00,
    pricePaise: 1_000_00,
    active: true,
    limits: {},
    features: {},
  });
  const fetched = await platform.getSubscriptionPlan(plan._id);
  assert.deepEqual(fetched.supportedBillingCycles, [BillingCycle.MONTHLY]);
});

test("duplicate supportedBillingCycles rejected at platform create", async () => {
  await assert.rejects(
    () =>
      platform.createSubscriptionPlan({
        tier: PlanTier.STARTER,
        name: "Dup cycles",
        monthlyPricePaise: 1_000_00,
        supportedBillingCycles: [BillingCycle.MONTHLY, BillingCycle.MONTHLY],
      }),
    (err) => err?.code === "VALIDATION_FAILED",
  );
});
