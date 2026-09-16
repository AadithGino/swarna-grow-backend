import argon2 from "argon2";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env, SECRET_DEFAULTS } from "../src/config/env.js";
import { BillingCycle, PlanTier, PlatformRole, UserStatus, UserType } from "../src/constants/enums.js";
import { DEFAULT_PLAN_FEATURES, limitsFromApi } from "../src/constants/plan-features.js";
import { SubscriptionPlan, User } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";

if (env.NODE_ENV === "production" && env.SEED_PLATFORM_PASSWORD === SECRET_DEFAULTS.SEED_PLATFORM_PASSWORD) {
  throw new Error("Set a non-default SEED_PLATFORM_PASSWORD before seeding production.");
}

await connectDatabase();
try {
  const plans = [
    { _id: "splan_starter", tier: PlanTier.STARTER, name: "Starter", sortOrder: 1, monthlyPricePaise: 300000, pricePaise: 300000, yearlyPricePaise: 3240000, trialDays: 14, limits: limitsFromApi({ activeCustomers: 100, branches: 1, staffSeats: 3, schemePlans: 3, whatsappMessagesPerMonth: 1000 }) },
    { _id: "splan_growth", tier: PlanTier.GROWTH, name: "Growth", sortOrder: 2, highlighted: true, monthlyPricePaise: 500000, pricePaise: 500000, yearlyPricePaise: 5400000, trialDays: 14, limits: limitsFromApi({ activeCustomers: 1000, branches: 2, staffSeats: 10, schemePlans: 10, whatsappMessagesPerMonth: 5000 }) },
    { _id: "splan_pro", tier: PlanTier.PRO, name: "Pro", sortOrder: 3, monthlyPricePaise: 800000, pricePaise: 800000, yearlyPricePaise: 8640000, trialDays: 14, limits: limitsFromApi({ activeCustomers: 3000, branches: 5, staffSeats: 30, schemePlans: 25, whatsappMessagesPerMonth: 20000 }) },
    { _id: "splan_custom", tier: PlanTier.CUSTOM, name: "Custom", sortOrder: 4, priceLabel: "Contact Us", trialDays: 0, limits: limitsFromApi({ activeCustomers: null, branches: null, staffSeats: null, schemePlans: null, whatsappMessagesPerMonth: null }) },
  ];
  for (const plan of plans) {
    const payload = {
      ...plan,
      billingCycle: BillingCycle.MONTHLY,
      features: DEFAULT_PLAN_FEATURES[plan.tier],
      active: true,
    };
    const byId = await SubscriptionPlan.findById(plan._id).lean();
    if (byId) {
      await SubscriptionPlan.updateOne({ _id: plan._id }, { $set: payload });
      continue;
    }
    const legacy = await SubscriptionPlan.findOne({ tier: plan.tier, billingCycle: BillingCycle.MONTHLY }).lean();
    if (legacy && legacy._id !== plan._id) {
      await SubscriptionPlan.deleteOne({ _id: legacy._id });
    }
    await SubscriptionPlan.updateOne({ _id: plan._id }, { $set: payload }, { upsert: true });
  }
  const passwordHash = await argon2.hash(env.SEED_PLATFORM_PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const platformUserPatch = {
    name: "Ops Admin",
    email: env.SEED_PLATFORM_EMAIL,
    mobile: env.SEED_PLATFORM_MOBILE,
    role: PlatformRole.SUPER_ADMIN,
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ["*"],
    tenantId: null,
    branchId: null,
    mustSetPassword: false,
    type: UserType.PLATFORM_USER,
  };
  const existingPlatform = await User.findOne({ type: UserType.PLATFORM_USER }).select("_id").lean();
  if (existingPlatform) {
    await User.updateOne({ _id: existingPlatform._id }, { $set: platformUserPatch });
  } else {
    await User.create({ _id: createId("platformUser"), ...platformUserPatch });
  }
  process.stdout.write(`Seed complete. Platform login: ${env.SEED_PLATFORM_EMAIL}\n`);
} finally {
  await disconnectDatabase();
}
