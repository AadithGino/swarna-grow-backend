import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { SubscriptionStatus } from "../src/constants/enums.js";
import { Scheme, SchemePlan, SubscriptionPlan, Tenant } from "../src/models/index.js";
import * as platform from "../src/services/platform.service.js";
import { createId } from "../src/lib/ids.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("cancelled subscription blocks authenticated requests", async () => {
  const { tenant, user } = await seedTenantUser({});
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "subscription.status": SubscriptionStatus.CANCELLED } },
  );
  const response = await request(app)
    .get("/api/v1/admin/customers")
    .set("authorization", `Bearer ${bearerFor(user)}`);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "SUBSCRIPTION_CANCELLED");
});

test("branch creation beyond plan limit is rejected", async () => {
  const { tenant, user } = await seedTenantUser({});
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "subscription.limits.branches": 1 } },
  );
  const response = await request(app)
    .post("/api/v1/admin/branches")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", createId("idem"))
    .send({ code: "BRX", name: "Extra Branch" });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "LIMIT_BRANCHES");
});

test("downgrade usage counts plan templates not enrolments", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await SchemePlan.create([
    { _id: createId("schemePlan"), tenantId: tenant._id, code: "P1", name: "Plan 1", status: "ACTIVE", paymentPattern: "FIXED", valueBasis: "CASH", durationMonths: 12, installmentCount: 12 },
    { _id: createId("schemePlan"), tenantId: tenant._id, code: "P2", name: "Plan 2", status: "ACTIVE", paymentPattern: "FIXED", valueBasis: "CASH", durationMonths: 12, installmentCount: 12 },
  ]);
  for (let i = 0; i < 5; i += 1) {
    await Scheme.create({
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: `ENR-${i}`,
      planSnapshot: { paymentPattern: "FIXED" },
      valueBasis: "CASH",
      paymentPattern: "FIXED",
      status: "ACTIVE",
      startDate: "2025-01-01",
      maturityDate: "2025-12-01",
      version: 1,
    });
  }
  const subPlan = await SubscriptionPlan.create({
    _id: createId("subplan"),
    tier: "STARTER",
    name: "Starter",
    limits: { schemePlans: 1, branches: 5, staffSeats: 5, activeCustomers: 100 },
    features: {},
  });
  await assert.rejects(
    () => platform.changeSubscription(tenant._id, "change-plan", { subscriptionPlanId: subPlan._id }),
    (error) => error.code === "VALIDATION_FAILED" && error.details?.some?.((row) => row.limitKey === "schemePlans"),
  );
});
