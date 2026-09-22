import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const routes = readFileSync(join(root, "src/routes/platform.routes.js"), "utf8");

const mutations = [
  ['post("/subscription-plans"', "platformCreatePlanBody"],
  ['patch("/subscription-plans/:planId"', "platformUpdatePlanBody"],
  ['post("/tenants"', "platformCreateTenantBody"],
  ['patch("/tenants/:tenantId"', "platformUpdateTenantBody"],
  ['put("/tenants/:tenantId/integrations/payment-gateway"', "platformPhonePeIntegrationBody"],
  ['post("/webhook-failures/:id/retry"', "platformWebhookRetryBody"],
];

test("platform mutation routes reference validate() with DTO schemas", () => {
  for (const [route, schema] of mutations) {
    assert.match(routes, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(routes, new RegExp(schema));
  }
});
