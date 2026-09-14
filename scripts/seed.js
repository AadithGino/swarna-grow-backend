import argon2 from "argon2";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env, SECRET_DEFAULTS } from "../src/config/env.js";
import { BillingCycle, PlanTier, UserStatus, UserType } from "../src/constants/enums.js";
import { SubscriptionPlan, User } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";

if (env.NODE_ENV === "production" && env.SEED_PLATFORM_PASSWORD === SECRET_DEFAULTS.SEED_PLATFORM_PASSWORD) throw new Error("Set a non-default SEED_PLATFORM_PASSWORD before seeding production.");

await connectDatabase();
try {
  const plans = [
    { tier: PlanTier.STARTER, name: "Starter", pricePaise: 199900, limits: { activeCustomers: 250, branches: 1, staff: 3, schemePlans: 3, whatsappMessages: 1000 } },
    { tier: PlanTier.GROWTH, name: "Growth", pricePaise: 499900, limits: { activeCustomers: 1000, branches: 5, staff: 10, schemePlans: 10, whatsappMessages: 5000 } },
    { tier: PlanTier.PRO, name: "Pro", pricePaise: 999900, limits: { activeCustomers: 5000, branches: 25, staff: 50, schemePlans: 50, whatsappMessages: 25000 } },
  ];
  for (const plan of plans) await SubscriptionPlan.updateOne({ tier: plan.tier, billingCycle: BillingCycle.MONTHLY }, { $set: { ...plan, billingCycle: BillingCycle.MONTHLY, active: true }, $setOnInsert: { _id: createId("subscription") } }, { upsert: true });
  const passwordHash = await argon2.hash(env.SEED_PLATFORM_PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  await User.updateOne({ type: UserType.PLATFORM_USER, tenantId: null, mobile: env.SEED_PLATFORM_MOBILE }, { $set: { name: "Platform Admin", passwordHash, status: UserStatus.ACTIVE, permissions: ["*"] }, $setOnInsert: { _id: createId("user"), type: UserType.PLATFORM_USER, tenantId: null, mobile: env.SEED_PLATFORM_MOBILE } }, { upsert: true });
  process.stdout.write(`Seed complete. Platform mobile: ${env.SEED_PLATFORM_MOBILE}\n`);
} finally { await disconnectDatabase(); }
