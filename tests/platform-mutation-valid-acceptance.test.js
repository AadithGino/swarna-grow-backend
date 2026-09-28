import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { parseAuthenticatedPlatformMutationKeys } from "../src/lib/platform-mutation-registry.js";
import { AuditEvent, Tenant } from "../src/models/index.js";
import { platformRouteValidators } from "../src/validators/platform.validators.js";
import {
  planCreateBody,
  platformRequest,
  seedGrowthPlan,
  seedPlatformAdminToken,
  seedPlatformInvoice,
  seedStarterPlan,
  seedTenantContext,
  seedTenantGoLiveReady,
  seedWebhookFailure,
  tenantCreateBody,
} from "./helpers/platform-mutation-happy-paths.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();
const routesSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/routes/platform.routes.js"),
  "utf8",
);
const routeKeys = parseAuthenticatedPlatformMutationKeys(routesSource);
/** @type {Record<string, boolean>} */
export const validRouteCoverage = Object.fromEntries(routeKeys.map((k) => [k, false]));

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function mark(routeKey) {
  validRouteCoverage[routeKey] = true;
}

test("POST /auth/logout valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const res = await platformRequest(app, token, "POST", "/api/v1/platform/auth/logout", { body: {} });
  assert.equal(res.status, 200);
  mark("POST /auth/logout");
});

test("POST /subscription-plans valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const res = await platformRequest(app, token, "POST", "/api/v1/platform/subscription-plans", {
    body: planCreateBody(PlanTier.PRO),
    idempotencyKey: "valid-post-plan",
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.data?.id ?? res.body.data?.tier);
  mark("POST /subscription-plans");
});

test("PATCH /subscription-plans/:planId valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const planId = await seedStarterPlan();
  const res = await platformRequest(app, token, "PATCH", `/api/v1/platform/subscription-plans/${planId}`, {
    body: { name: "Starter Plus", expectedVersion: 1 },
    idempotencyKey: "valid-patch-plan",
  });
  assert.equal(res.status, 200);
  mark("PATCH /subscription-plans/:planId");
});

test("POST /subscription-plans/:planId/deprecate valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const planId = await seedStarterPlan();
  const res = await platformRequest(app, token, "POST", `/api/v1/platform/subscription-plans/${planId}/deprecate`, {
    body: { reason: "End of life" },
    idempotencyKey: "valid-deprecate",
  });
  assert.equal(res.status, 200);
  mark("POST /subscription-plans/:planId/deprecate");
});

test("POST /tenants valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const planId = await seedGrowthPlan();
  const res = await platformRequest(app, token, "POST", "/api/v1/platform/tenants", {
    body: tenantCreateBody(planId),
    idempotencyKey: "valid-post-tenant",
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.data?.id ?? res.body.data?.tenant?.id);
  mark("POST /tenants");
});

test("PATCH /tenants/:tenantId valid acceptance and version increment", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const before = await Tenant.findById(tenant._id).lean();
  const res = await platformRequest(app, token, "PATCH", `/api/v1/platform/tenants/${tenant._id}`, {
    body: { expectedVersion: before.version ?? 0, name: "Renamed Valid Tenant" },
    idempotencyKey: "valid-patch-tenant",
  });
  assert.equal(res.status, 200);
  const after = await Tenant.findById(tenant._id).lean();
  assert.ok(after.version > (before.version ?? 0));
  mark("PATCH /tenants/:tenantId");
});

test("PATCH /tenants/:tenantId stale expectedVersion returns conflict", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const res = await platformRequest(app, token, "PATCH", `/api/v1/platform/tenants/${tenant._id}`, {
    body: { expectedVersion: 999, name: "Should fail" },
    idempotencyKey: "stale-patch-tenant",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error?.code, "VERSION_CONFLICT");
});

test("POST /tenants/:tenantId/owner-credentials valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const res = await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/owner-credentials`, {
    body: { password: "1234" },
    idempotencyKey: "valid-owner-cred",
  });
  assert.equal(res.status, 200);
  mark("POST /tenants/:tenantId/owner-credentials");
});

test("POST /tenants/:tenantId/go-live valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  await seedTenantGoLiveReady(tenant._id);
  const res = await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/go-live`, {
    body: { reason: "Ready for production" },
    idempotencyKey: "valid-go-live",
  });
  assert.equal(res.status, 200);
  mark("POST /tenants/:tenantId/go-live");
});

test("POST /tenants/:tenantId/suspend valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const suspend = await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/suspend`, {
    body: { reason: "Billing hold" },
    idempotencyKey: "valid-suspend",
  });
  assert.equal(suspend.status, 200);
  mark("POST /tenants/:tenantId/suspend");
});

test("POST /tenants/:tenantId/reactivate valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/suspend`, {
    body: { reason: "Hold" },
    idempotencyKey: "pre-suspend-reactivate",
  });
  const reactivate = await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/reactivate`, {
    body: { note: "Cleared" },
    idempotencyKey: "valid-reactivate",
  });
  assert.equal(reactivate.status, 200);
  mark("POST /tenants/:tenantId/reactivate");
});

test("PUT integrations and verify valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const wa = await platformRequest(app, token, "PUT", `/api/v1/platform/tenants/${tenant._id}/integrations/whatsapp`, {
    body: { phoneNumberId: "123456789012345" },
    idempotencyKey: "valid-wa-put",
  });
  assert.equal(wa.status, 200);
  mark("PUT /tenants/:tenantId/integrations/whatsapp");
  const waVerify = await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/integrations/whatsapp/verify`, {
    body: {},
    idempotencyKey: "valid-wa-verify",
  });
  assert.ok([200, 422, 503].includes(waVerify.status));
  mark("POST /tenants/:tenantId/integrations/whatsapp/verify");
  const pg = await platformRequest(app, token, "PUT", `/api/v1/platform/tenants/${tenant._id}/integrations/payment-gateway`, {
    body: { clientId: "mock-client-id" },
    idempotencyKey: "valid-pg-put",
  });
  assert.equal(pg.status, 200);
  mark("PUT /tenants/:tenantId/integrations/payment-gateway");
  const pgVerify = await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/integrations/payment-gateway/verify`, {
    body: {},
    idempotencyKey: "valid-pg-verify",
  });
  assert.ok([200, 422, 503].includes(pgVerify.status));
  mark("POST /tenants/:tenantId/integrations/payment-gateway/verify");
  const fcm = await platformRequest(app, token, "PUT", `/api/v1/platform/tenants/${tenant._id}/integrations/fcm`, {
    body: { projectId: "proj-test", clientEmail: "fcm@test.example.com" },
    idempotencyKey: "valid-fcm-put",
  });
  assert.equal(fcm.status, 200);
  mark("PUT /tenants/:tenantId/integrations/fcm");
});

test("tenant templates valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const messageType = "PAYMENT_RECEIPT";
  const put = await platformRequest(app, token, "PUT", `/api/v1/platform/tenants/${tenant._id}/templates/${messageType}`, {
    body: { body: "Receipt {{amount}}", enabled: true },
    idempotencyKey: null,
  });
  assert.equal(put.status, 200);
  mark("PUT /tenants/:tenantId/templates/:messageType");
  const testSend = await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/templates/${messageType}/test`, {
    body: { mobile: "+919876543210" },
    idempotencyKey: "valid-template-test",
  });
  assert.ok([200, 202, 503].includes(testSend.status));
  mark("POST /tenants/:tenantId/templates/:messageType/test");
  const del = await platformRequest(app, token, "DELETE", `/api/v1/platform/tenants/${tenant._id}/templates/${messageType}`, {
    idempotencyKey: "valid-template-delete",
  });
  assert.equal(del.status, 200);
  mark("DELETE /tenants/:tenantId/templates/:messageType");
});

test("POST /tenants/:tenantId/subscription/change-plan valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const growthPlanId = await seedGrowthPlan();
  const change = await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/subscription/change-plan`, {
    body: { subscriptionPlanId: growthPlanId, billingCycle: "MONTHLY" },
    idempotencyKey: "valid-change-plan",
  });
  assert.equal(change.status, 200);
  mark("POST /tenants/:tenantId/subscription/change-plan");
});

test("PATCH /tenants/:tenantId/subscription/limits valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const row = await Tenant.findById(tenant._id).lean();
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "subscription.tier": PlanTier.CUSTOM, "subscription.limits.staff": 10 } },
  );
  const limits = await platformRequest(app, token, "PATCH", `/api/v1/platform/tenants/${tenant._id}/subscription/limits`, {
    body: { expectedVersion: row.version ?? 0, staff: 25 },
    idempotencyKey: "valid-limits",
  });
  assert.equal(limits.status, 200);
  mark("PATCH /tenants/:tenantId/subscription/limits");
});

test("POST /tenants/:tenantId/subscription/extend valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const extend = await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/subscription/extend`, {
    body: { days: 30 },
    idempotencyKey: "valid-extend",
  });
  assert.equal(extend.status, 200);
  mark("POST /tenants/:tenantId/subscription/extend");
});

test("POST /tenants/:tenantId/subscription/cancel valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const cancel = await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/subscription/cancel`, {
    body: { reason: "Customer requested cancellation" },
    idempotencyKey: "valid-cancel",
  });
  assert.equal(cancel.status, 200);
  mark("POST /tenants/:tenantId/subscription/cancel");
});

test("invoice and webhook valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const createInv = await platformRequest(app, token, "POST", `/api/v1/platform/tenants/${tenant._id}/invoices`, {
    body: { amountPaise: 50_000, description: "Platform fee", dueDate: "2026-12-31" },
    idempotencyKey: "valid-create-invoice",
  });
  assert.equal(createInv.status, 201);
  mark("POST /tenants/:tenantId/invoices");
  const invoiceId = createInv.body.data?.id ?? await seedPlatformInvoice(tenant._id);
  const paid = await platformRequest(app, token, "POST", `/api/v1/platform/invoices/${invoiceId}/mark-paid`, {
    body: { reference: "NEFT-001" },
    idempotencyKey: "valid-mark-paid",
  });
  assert.equal(paid.status, 200);
  mark("POST /invoices/:invoiceId/mark-paid");
  const webhookId = await seedWebhookFailure(tenant._id);
  const retry = await platformRequest(app, token, "POST", `/api/v1/platform/webhook-failures/${webhookId}/retry`, {
    body: {},
    idempotencyKey: "valid-webhook-retry",
  });
  assert.equal(retry.status, 202);
  mark("POST /webhook-failures/:id/retry");
});

test("PUT /app-config valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const cfg = await platformRequest(app, token, "PUT", "/api/v1/platform/app-config", {
    body: { android: { latestVersion: "2.0.0", minimumVersion: "1.0.0", forceUpdate: false } },
    idempotencyKey: "valid-app-config",
  });
  assert.equal(cfg.status, 200);
  mark("PUT /app-config");
});

test("PUT /tenants/:tenantId/flags valid acceptance", async () => {
  const token = await seedPlatformAdminToken(app);
  const { tenant } = await seedTenantContext();
  const flags = await platformRequest(app, token, "PUT", `/api/v1/platform/tenants/${tenant._id}/flags`, {
    body: { flags: { onlinePayments: true } },
    idempotencyKey: "valid-flags",
  });
  assert.equal(flags.status, 200);
  const audit = await AuditEvent.findOne({ action: "PLATFORM_TENANT_FLAGS_UPDATED", entityId: tenant._id }).lean();
  assert.ok(audit);
  mark("PUT /tenants/:tenantId/flags");
});

test("platform mutation valid coverage table is complete", () => {
  const missing = routeKeys.filter((k) => !validRouteCoverage[k]);
  assert.deepEqual(missing, [], `Missing valid HTTP acceptance for: ${missing.join(", ")}`);
  assert.equal(routeKeys.length, 27);
  assert.equal(Object.keys(platformRouteValidators).length, 27);
  for (const key of routeKeys) {
    const row = platformRouteValidators[key];
    assert.ok(row.body || row.params, key);
  }
});
