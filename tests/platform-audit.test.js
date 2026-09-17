import test from "node:test";
import assert from "node:assert/strict";
import { AuditEvent, SubscriptionPlan } from "../src/models/index.js";
import { AuditEntityType, PlanTier, UserType } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { redactPlatformAuditPayload } from "../src/lib/platform-audit.js";
import {
  createInvoice,
  deprecateSubscriptionPlan,
  markInvoicePaid,
  setOwnerCredentials,
  updateAppConfig,
  updateSubscriptionPlan,
} from "../src/services/platform.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function platformReq(actorId = "pusr_test") {
  return {
    auth: { id: actorId, type: UserType.PLATFORM_USER, tenantId: "platform" },
    headers: { "user-agent": "platform-audit-test" },
    ip: "127.0.0.1",
  };
}

test("redactPlatformAuditPayload masks integration secrets", () => {
  const out = redactPlatformAuditPayload({
    accessToken: "super-secret-token",
    appSecret: "app-secret",
    name: "Tenant A",
    nested: { saltKey: "salt-value", label: "ok" },
  });
  assert.notEqual(out.accessToken, "super-secret-token");
  assert.notEqual(out.appSecret, "app-secret");
  assert.notEqual(out.nested.saltKey, "salt-value");
  assert.equal(out.name, "Tenant A");
  assert.equal(out.nested.label, "ok");
});

test("updateAppConfig writes a platform audit event", async () => {
  const req = platformReq();
  const next = await updateAppConfig({ android: { latestVersion: "2.0.0" } }, req);
  assert.equal(next.android.latestVersion, "2.0.0");
  const audit = await AuditEvent.findOne({ action: "PLATFORM_APP_CONFIG_UPDATED" }).lean();
  assert.ok(audit);
  assert.equal(audit.tenantId, "platform");
  assert.equal(audit.entityId, "global");
  assert.equal(audit.entityType, AuditEntityType.TENANT);
});

test("subscription plan update and deprecate are audited", async () => {
  const planId = createId("subscriptionPlan");
  await SubscriptionPlan.create({
    _id: planId,
    tier: PlanTier.STARTER,
    name: "Starter",
    pricePaise: 99900,
    active: true,
    version: 1,
  });
  const req = platformReq();
  await updateSubscriptionPlan(planId, { expectedVersion: 1, displayName: "Starter Plus" }, req);
  await deprecateSubscriptionPlan(planId, req);
  const actions = await AuditEvent.find({ entityId: planId }).sort({ occurredAt: 1 }).lean();
  assert.deepEqual(actions.map((row) => row.action), ["PLATFORM_PLAN_UPDATED", "PLATFORM_PLAN_DEPRECATED"]);
});

test("invoice create, mark paid, and owner credential reset are audited without secrets", async () => {
  const { tenant, user } = await seedTenantUser();
  const req = platformReq();
  const invoice = await createInvoice(tenant._id, {
    amountPaise: 500000,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    dueDate: "2026-02-07",
  }, req);
  await markInvoicePaid(invoice.id, { reference: "NEFT-001" }, req);
  await setOwnerCredentials(tenant._id, { temporaryPassword: "TempPass!123" }, req);

  const createAudit = await AuditEvent.findOne({ action: "PLATFORM_INVOICE_CREATED", entityId: invoice.id }).lean();
  assert.ok(createAudit);
  assert.equal(createAudit.tenantId, tenant._id);

  const paidAudit = await AuditEvent.findOne({ action: "PLATFORM_INVOICE_PAID", entityId: invoice.id }).lean();
  assert.ok(paidAudit);
  assert.equal(paidAudit.after.status, "PAID");

  const ownerAudit = await AuditEvent.findOne({ action: "PLATFORM_OWNER_CREDENTIALS_RESET", entityId: user._id }).lean();
  assert.ok(ownerAudit);
  assert.equal(ownerAudit.after.ownerId, user._id);
  assert.equal(ownerAudit.after.temporaryPassword, undefined);
  assert.equal(ownerAudit.after.passwordHash, undefined);
});
