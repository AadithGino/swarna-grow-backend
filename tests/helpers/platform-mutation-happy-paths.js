import argon2 from "argon2";
import request from "supertest";
import {
  BillingCycle,
  PlanTier,
  PlatformRole,
  UserStatus,
  UserType,
} from "../../src/constants/enums.js";
import { REQUIRED_TEMPLATE_TYPES } from "../../src/constants/template-registry.js";
import { createId } from "../../src/lib/ids.js";
import {
  Invoice,
  Session,
  SubscriptionPlan,
  TemplateDefinition,
  User,
  WebhookEvent,
} from "../../src/models/index.js";
import { Tenant } from "../../src/models/index.js";
import { bearerFor, seedBranch, seedTenantUser } from "./db.js";

export async function seedPlatformAdminToken(_app) {
  const user = await User.create({
    _id: createId("user"),
    type: UserType.PLATFORM_USER,
    role: PlatformRole.SUPER_ADMIN,
    name: "Platform Admin",
    passwordHash: await argon2.hash("9876", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
    status: UserStatus.ACTIVE,
    permissions: ["*"],
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    deviceId: "platform-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals = { testSessionId: session._id };
  return bearerFor(user);
}

export async function seedStarterPlan() {
  const existing = await SubscriptionPlan.findOne({ tier: PlanTier.STARTER }).lean();
  if (existing) return existing._id;
  const planId = createId("subscriptionPlan");
  await SubscriptionPlan.create({
    _id: planId,
    tier: PlanTier.STARTER,
    name: "Starter",
    pricePaise: 99_900,
    monthlyPricePaise: 99_900,
    billingCycle: BillingCycle.MONTHLY,
    active: true,
    version: 1,
  });
  return planId;
}

export async function seedGrowthPlan() {
  const existing = await SubscriptionPlan.findOne({ tier: PlanTier.GROWTH }).lean();
  if (existing) return existing._id;
  const planId = createId("subscriptionPlan");
  await SubscriptionPlan.create({
    _id: planId,
    tier: PlanTier.GROWTH,
    name: "Growth",
    pricePaise: 199_900,
    monthlyPricePaise: 199_900,
    billingCycle: BillingCycle.MONTHLY,
    active: true,
    version: 1,
  });
  return planId;
}

export async function seedTenantContext() {
  const starterPlanId = await seedStarterPlan();
  const { tenant, branch } = await seedTenantUser();
  await seedBranch({ tenantId: tenant._id, code: "HQ2", name: "HQ Two" });
  return { tenant, branch, starterPlanId };
}

export async function seedTenantGoLiveReady(tenantId) {
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "integrationSecrets.whatsapp.verifiedAt": new Date(),
        "integrationSecrets.phonepe.verifiedAt": new Date(),
      },
    },
  );
  for (const messageType of REQUIRED_TEMPLATE_TYPES) {
    await TemplateDefinition.create({
      _id: createId("tpl"),
      tenantId,
      messageType,
      body: `Body for ${messageType}`,
      active: true,
      version: 1,
    });
  }
}

export async function platformRequest(app, token, method, path, { body, idempotencyKey = `idem-${createId("idem")}` } = {}) {
  let req = request(app)[method.toLowerCase()](path)
    .set("authorization", `Bearer ${token}`);
  if (idempotencyKey) req = req.set("x-idempotency-key", idempotencyKey);
  if (body !== undefined) req = req.send(body);
  return req;
}

export async function seedPlatformInvoice(tenantId) {
  const invoiceId = createId("invoice");
  await Invoice.create({
    _id: invoiceId,
    tenantId,
    invoiceNumber: `PLT/2026/0001`,
    amountPaise: 50_000,
    subtotalPaise: 50_000,
    taxPaise: 0,
    dueDate: "2026-12-31",
    status: "ISSUED",
    version: 1,
  });
  return invoiceId;
}

export async function seedWebhookFailure(tenantId) {
  const id = createId("webhookEvent");
  await WebhookEvent.create({
    _id: id,
    tenantId,
    provider: "PHONEPE",
    status: "FAILED",
    providerEventId: `pe_${id}`,
  });
  return id;
}

export const planCreateBody = (tier = PlanTier.PRO) => ({
  code: `PLN${String(Date.now()).slice(-6)}`,
  name: "Valid Plan",
  tier,
  monthlyPricePaise: 149_900,
  limits: {
    activeCustomers: 100,
    branches: 5,
    staff: 10,
    schemePlans: 20,
    whatsappMessages: 1000,
  },
});

export const tenantCreateBody = (subscriptionPlanId) => {
  const suffix = String(Date.now()).slice(-7);
  return {
    name: "Valid Tenant Co",
    code: `VT${suffix}`,
    mobile: `+91970${suffix}`,
    email: `valid-${suffix}@example.com`,
    city: "Kochi",
    subscriptionPlanId,
    billingCycle: BillingCycle.MONTHLY,
  };
};
