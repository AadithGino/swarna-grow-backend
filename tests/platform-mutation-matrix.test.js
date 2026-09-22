import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  PlanTier,
  PlatformRole,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { assertPlatformMutationRegistry } from "../src/lib/platform-mutation-registry.js";
import { createId } from "../src/lib/ids.js";
import {
  AuditEvent,
  Session,
  SubscriptionPlan,
  User,
  WebhookEvent,
} from "../src/models/index.js";
import { platformRouteValidators } from "../src/validators/platform.validators.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();
const routesSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/routes/platform.routes.js"),
  "utf8",
);

/** Authenticated platform mutations (must stay in sync with platform.routes.js). */
export const PLATFORM_MUTATION_ROUTE_COUNT = 27;

function malformedBodyFor(routeKey) {
  if (routeKey === "PUT /app-config") {
    return { android: { forceUpdate: "not-a-boolean" } };
  }
  return { definitelyNotValid: true };
}

const planCreateBody = {
  code: "MATRIX01",
  name: "Matrix Plan",
  tier: PlanTier.STARTER,
  monthlyPricePaise: 99_900,
  limits: {
    activeCustomers: 100,
    branches: 5,
    staff: 10,
    schemePlans: 20,
    whatsappMessages: 1000,
  },
};

const IDS = {
  tenantId: createId("tenant"),
  planId: createId("subscriptionPlan"),
  invoiceId: createId("invoice"),
  messageType: "PAYMENT_RECEIPT",
  webhookFailureId: createId("webhookEvent"),
};

function routePath(routeKey, { invalidParam = false } = {}) {
  const space = routeKey.indexOf(" ");
  const template = routeKey.slice(space + 1);
  const tenant = invalidParam ? "ab" : IDS.tenantId;
  const plan = invalidParam ? "ab" : IDS.planId;
  const invoice = invalidParam ? "ab" : IDS.invoiceId;
  const messageType = invalidParam ? "a" : IDS.messageType;
  const webhookId = invalidParam ? "ab" : IDS.webhookFailureId;
  const resolved = template
    .replace(":tenantId", tenant)
    .replace(":planId", plan)
    .replace(":invoiceId", invoice)
    .replace(":messageType", messageType)
    .replace(":id", webhookId);
  return `/api/v1/platform${resolved}`;
}

function routeMethod(routeKey) {
  return routeKey.slice(0, routeKey.indexOf(" ")).toLowerCase();
}

async function seedPlatformToken() {
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

async function seedMatrixFixtures() {
  await SubscriptionPlan.updateOne(
    { _id: IDS.planId },
    {
      $setOnInsert: {
        _id: IDS.planId,
        tier: PlanTier.STARTER,
        name: "Starter",
        pricePaise: 99_900,
        active: true,
        version: 1,
      },
    },
    { upsert: true },
  );
  const { tenant } = await seedTenantUser();
  IDS.tenantId = tenant._id;
  await WebhookEvent.updateOne(
    { _id: IDS.webhookFailureId },
    {
      $setOnInsert: {
        _id: IDS.webhookFailureId,
        tenantId: tenant._id,
        provider: "PHONEPE",
        status: "FAILED",
        providerEventId: `pe_${IDS.webhookFailureId}`,
      },
    },
    { upsert: true },
  );
}

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  await seedMatrixFixtures();
});

test("platform mutation registry matches platform.routes.js", () => {
  const { routeCount, routes } = assertPlatformMutationRegistry({
    routesSource,
    validators: platformRouteValidators,
  });
  assert.equal(routeCount, PLATFORM_MUTATION_ROUTE_COUNT);
  assert.equal(Object.keys(platformRouteValidators).length, PLATFORM_MUTATION_ROUTE_COUNT);
  assert.equal(routes.length, PLATFORM_MUTATION_ROUTE_COUNT);
});

const routeKeys = Object.keys(platformRouteValidators).sort();

for (const routeKey of routeKeys) {
  const entry = platformRouteValidators[routeKey];
  const hasBody = Boolean(entry.body);
  const hasParams = Boolean(entry.params);

  if (hasBody) {
    test(`${routeKey} rejects malformed body`, async () => {
      const token = await seedPlatformToken();
      const before = await AuditEvent.countDocuments({});
      const res = await request(app)[routeMethod(routeKey)](routePath(routeKey))
        .set("authorization", `Bearer ${token}`)
        .set("x-idempotency-key", `malformed-${routeKey.replace(/\W/g, "_")}`)
        .send(malformedBodyFor(routeKey));
      assert.equal(res.status, 400);
      assert.equal(await AuditEvent.countDocuments({}), before);
    });

    test(`${routeKey} rejects unknown fields`, async () => {
      const token = await seedPlatformToken();
      const before = await AuditEvent.countDocuments({});
      const res = await request(app)[routeMethod(routeKey)](routePath(routeKey))
        .set("authorization", `Bearer ${token}`)
        .set("x-idempotency-key", `unknown-${routeKey.replace(/\W/g, "_")}`)
        .send({ unknownField: true, role: "SUPER_ADMIN", permissions: ["*"] });
      assert.equal(res.status, 400);
      assert.equal(await AuditEvent.countDocuments({}), before);
    });
  }

  if (hasParams) {
    test(`${routeKey} rejects invalid route params`, async () => {
      const token = await seedPlatformToken();
      const before = await AuditEvent.countDocuments({});
      const res = await request(app)[routeMethod(routeKey)](routePath(routeKey, { invalidParam: true }))
        .set("authorization", `Bearer ${token}`)
        .set("x-idempotency-key", `badparam-${routeKey.replace(/\W/g, "_")}`)
        .send(hasBody ? {} : undefined);
      assert.equal(res.status, 400);
      assert.equal(await AuditEvent.countDocuments({}), before);
    });
  }
}

test("PATCH /subscription-plans/:planId accepts partial body with expectedVersion", async () => {
  const token = await seedPlatformToken();
  const res = await request(app)
    .patch(routePath("PATCH /subscription-plans/:planId"))
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", "patch-partial-plan")
    .send({ name: "Starter v2", expectedVersion: 1 });
  assert.equal(res.status, 200);
});

test("PATCH /tenants/:tenantId rejects body without expectedVersion", async () => {
  const token = await seedPlatformToken();
  const { tenant } = await seedTenantUser();
  const res = await request(app)
    .patch(routePath("PATCH /tenants/:tenantId").replace(IDS.tenantId, tenant._id))
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", "patch-partial-tenant")
    .send({ name: "Renamed Tenant" });
  assert.equal(res.status, 400);
});

test("valid platform mutations accept strict DTOs", async () => {
  const token = await seedPlatformToken();

  const createPlan = await request(app)
    .post(routePath("POST /subscription-plans"))
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", "valid-create-plan")
    .send({ ...planCreateBody, code: "VALID01", tier: PlanTier.GROWTH });
  assert.equal(createPlan.status, 201);
  const createdPlanId = createPlan.body.data?.id ?? createPlan.body.data?._id;
  assert.ok(createdPlanId);

  const appConfig = await request(app)
    .put(routePath("PUT /app-config"))
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", "valid-app-config")
    .send({ android: { latestVersion: "1.2.3", minimumVersion: "1.0.0", forceUpdate: false } });
  assert.equal(appConfig.status, 200);

  const deprecate = await request(app)
    .post(`/api/v1/platform/subscription-plans/${createdPlanId}/deprecate`)
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", "valid-deprecate-plan")
    .send({ reason: "Superseded by matrix plan" });
  assert.equal(deprecate.status, 200);

  const retry = await request(app)
    .post(routePath("POST /webhook-failures/:id/retry"))
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", "valid-webhook-retry")
    .send({});
  assert.equal(retry.status, 202);
});

test("platform mutation matrix case count", () => {
  const bodyRoutes = routeKeys.filter((k) => platformRouteValidators[k].body).length;
  const paramRoutes = routeKeys.filter((k) => platformRouteValidators[k].params).length;
  const totalCases = 1 + bodyRoutes * 2 + paramRoutes + 3;
  assert.equal(bodyRoutes, 26);
  assert.equal(paramRoutes, 23);
  assert.equal(totalCases, 79);
  assert.equal(PLATFORM_MUTATION_ROUTE_COUNT, 27);
});
