import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { TenantRole } from "../src/constants/enums.js";
import { seal } from "../src/lib/crypto.js";
import { canonicalMobile } from "../src/lib/mobile.js";
import { AuditEvent, InboundMessage, Tenant, WebhookEvent } from "../src/models/index.js";
import { processWebhook } from "../src/workers/processors.js";
import { seedAdminGatewayContext, seedUserOnTenant } from "./helpers/gateway-http-fixture.js";
import { resetTestDb, seedCustomer, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();
const APP_SECRET = "test-whatsapp-secret";

function signBody(rawBody, secret = APP_SECRET) {
  const hex = createHmac("sha256", secret).update(rawBody).digest("hex");
  return `sha256=${hex}`;
}

function inboundPayload({ messageId = "wamid.test.1", from = "919888877766", text = "Hello" } = {}) {
  return {
    entry: [{
      changes: [{
        value: {
          messages: [{
            id: messageId,
            from,
            timestamp: `${Math.floor(Date.now() / 1000)}`,
            type: "text",
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

async function postWhatsAppWebhook(tenantId, payload, { secret = APP_SECRET } = {}) {
  const raw = JSON.stringify(payload);
  return request(app)
    .post(`/api/v1/webhooks/whatsapp/${tenantId}`)
    .set("content-type", "application/json")
    .set("x-hub-signature-256", signBody(raw, secret))
    .send(raw);
}

async function processLatestWebhook() {
  const event = await WebhookEvent.findOne({ provider: "WHATSAPP" }).sort({ createdAt: -1 }).lean();
  assert.ok(event);
  await processWebhook({ data: { webhookEventId: event._id }, attemptsMade: 0 });
  return event;
}

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedTenantWhatsApp(tenantId) {
  await Tenant.updateOne(
    { _id: tenantId },
    { $set: { "integrationSecrets.whatsapp.appSecret": seal(APP_SECRET) } },
  );
}

test("valid signed inbound persists and admin APIs enforce scope", async () => {
  const ctx = await seedAdminGatewayContext();
  await seedTenantWhatsApp(ctx.tenant._id);
  const waFrom = ctx.customer.mobile.replace(/^\+/, "");
  const post = await postWhatsAppWebhook(ctx.tenant._id, inboundPayload({ from: waFrom }));
  assert.equal(post.status, 200);
  await processLatestWebhook();
  const row = await InboundMessage.findOne({ tenantId: ctx.tenant._id }).lean();
  assert.ok(row);
  assert.equal(row.webhookEventId != null, true);
  const list = await request(app)
    .get("/api/v1/admin/messaging/inbound")
    .set("authorization", `Bearer ${ctx.token}`)
    .expect(200);
  assert.equal(list.body.data.length, 1);
  assert.equal(JSON.stringify(list.body.data).includes(APP_SECRET), false);
  const detail = await request(app)
    .get(`/api/v1/admin/messaging/inbound/${row._id}`)
    .set("authorization", `Bearer ${ctx.token}`)
    .expect(200);
  assert.equal(detail.body.data.webhookEventId, undefined);
  const read1 = await request(app)
    .post(`/api/v1/admin/messaging/inbound/${row._id}/read`)
    .set("authorization", `Bearer ${ctx.token}`)
    .set("x-idempotency-key", "read-once-12345678")
    .send({})
    .expect(200);
  const read2 = await request(app)
    .post(`/api/v1/admin/messaging/inbound/${row._id}/read`)
    .set("authorization", `Bearer ${ctx.token}`)
    .set("x-idempotency-key", "read-once-98765432")
    .send({})
    .expect(200);
  assert.equal(read1.body.data.status, "READ");
  assert.equal(read2.body.data.status, "READ");
});

test("signature mismatch when raw bytes differ from signed payload", async () => {
  const ctx = await seedAdminGatewayContext();
  await seedTenantWhatsApp(ctx.tenant._id);
  const payload = inboundPayload({ messageId: "wamid.rawbytes.1" });
  const signedRaw = JSON.stringify(payload);
  const tamperedRaw = signedRaw.replace("Hello", "Hello!");
  const res = await request(app)
    .post(`/api/v1/webhooks/whatsapp/${ctx.tenant._id}`)
    .set("content-type", "application/json")
    .set("x-hub-signature-256", signBody(signedRaw))
    .send(tamperedRaw);
  assert.equal(res.status, 401);
  assert.equal(await InboundMessage.countDocuments({}), 0);
});

test("malformed and wrong-length signatures fail without persistence", async () => {
  const ctx = await seedAdminGatewayContext();
  await seedTenantWhatsApp(ctx.tenant._id);
  const raw = JSON.stringify(inboundPayload({ messageId: "wamid.sigshape.1" }));
  for (const header of ["SHA256=deadbeef", "sha256=abc", "sha256="]) {
    const res = await request(app)
      .post(`/api/v1/webhooks/whatsapp/${ctx.tenant._id}`)
      .set("content-type", "application/json")
      .set("x-hub-signature-256", header)
      .send(raw);
    assert.equal(res.status, 401);
  }
  assert.equal(await InboundMessage.countDocuments({}), 0);
});

test("oversized webhook payload rejected before persistence", async () => {
  const ctx = await seedAdminGatewayContext();
  await seedTenantWhatsApp(ctx.tenant._id);
  const pad = "x".repeat(2_097_152);
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.big", text: { body: pad } }] } }] }] });
  const res = await request(app)
    .post(`/api/v1/webhooks/whatsapp/${ctx.tenant._id}`)
    .set("content-type", "application/json")
    .set("x-hub-signature-256", signBody(raw))
    .send(raw);
  assert.equal(res.status, 413);
  assert.equal(await WebhookEvent.countDocuments({ provider: "WHATSAPP" }), 0);
});

test("duplicate provider message id is scoped per tenant", async () => {
  const ctxA = await seedAdminGatewayContext();
  const ctxB = await seedAdminGatewayContext();
  await seedTenantWhatsApp(ctxA.tenant._id);
  await seedTenantWhatsApp(ctxB.tenant._id);
  const payload = inboundPayload({ messageId: "wamid.tenant.scope" });
  await postWhatsAppWebhook(ctxA.tenant._id, payload);
  await processLatestWebhook();
  await postWhatsAppWebhook(ctxB.tenant._id, payload);
  await processLatestWebhook();
  assert.equal(await InboundMessage.countDocuments({ providerMessageId: "wamid.tenant.scope" }), 2);
});

test("invalid signature rejected with no inbound rows", async () => {
  const ctx = await seedAdminGatewayContext();
  await seedTenantWhatsApp(ctx.tenant._id);
  const res = await postWhatsAppWebhook(ctx.tenant._id, inboundPayload(), { secret: "wrong" });
  assert.equal(res.status, 401);
  assert.equal(await InboundMessage.countDocuments({}), 0);
  assert.equal(await WebhookEvent.countDocuments({ status: "SIGNATURE_FAILED" }), 1);
});

test("duplicate provider message id is idempotent", async () => {
  const ctx = await seedAdminGatewayContext();
  await seedTenantWhatsApp(ctx.tenant._id);
  const payload = inboundPayload({ messageId: "wamid.dup.1" });
  await postWhatsAppWebhook(ctx.tenant._id, payload);
  await processLatestWebhook();
  await postWhatsAppWebhook(ctx.tenant._id, payload);
  await processLatestWebhook();
  assert.equal(await InboundMessage.countDocuments({ providerMessageId: "wamid.dup.1" }), 1);
});

test("unknown sender stored as unmatched without wrong customer attach", async () => {
  const ctx = await seedAdminGatewayContext();
  await seedTenantWhatsApp(ctx.tenant._id);
  await seedCustomer({
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    mobile: canonicalMobile("919800000001"),
  });
  await postWhatsAppWebhook(ctx.tenant._id, inboundPayload({ from: "919711122233", messageId: "wamid.unknown" }));
  await processLatestWebhook();
  const row = await InboundMessage.findOne({ providerMessageId: "wamid.unknown" }).lean();
  assert.equal(row.status, "UNMATCHED");
  assert.equal(row.customerId, undefined);
});

test("invalid admin read does not write audit", async () => {
  const ctx = await seedAdminGatewayContext();
  const before = await AuditEvent.countDocuments({});
  await request(app)
    .post("/api/v1/admin/messaging/inbound/inb_missing/read")
    .set("authorization", `Bearer ${ctx.token}`)
    .set("x-idempotency-key", "read-invalid-123456")
    .send({})
    .expect(404);
  assert.equal(await AuditEvent.countDocuments({}), before);
});

test("branch manager can read inbound for own branch", async () => {
  const ctx = await seedAdminGatewayContext();
  await seedTenantWhatsApp(ctx.tenant._id);
  const waFrom = ctx.customer.mobile.replace(/^\+/, "");
  await postWhatsAppWebhook(ctx.tenant._id, inboundPayload({ messageId: "wamid.scope", from: waFrom }));
  await processLatestWebhook();
  const row = await InboundMessage.findOne({ providerMessageId: "wamid.scope" }).lean();
  const manager = await seedUserOnTenant({
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    role: TenantRole.BRANCH_MANAGER,
    mobile: "+919700000011",
  });
  await request(app)
    .get(`/api/v1/admin/messaging/inbound/${row._id}`)
    .set("authorization", `Bearer ${manager.token}`)
    .expect(200);
});
