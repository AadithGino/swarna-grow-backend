import test from "node:test";
import assert from "node:assert/strict";
import { JobStatus } from "../src/constants/enums.js";
import { buildWhatsAppWebhookEventId } from "../src/lib/whatsapp-webhook-identity.js";
import { resetWebhookMetricsForTests } from "../src/lib/webhook-metrics.js";
import {
  claimWebhookForProcessing,
  persistVerifiedWebhook,
  persistWebhookSignatureFailure,
  reclaimExpiredWebhookLeases,
} from "../src/services/webhook-event.service.js";
import { WebhookEvent } from "../src/models/index.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  resetWebhookMetricsForTests();
});

test("signature failure persists digest only without raw body", async () => {
  const { tenant } = await seedTenantUser();
  const event = await persistWebhookSignatureFailure({
    tenantId: tenant._id,
    provider: "PHONEPE",
    rawBody: Buffer.from('{"fake":true}'),
    signatureHeader: "Bearer secret-value",
    clientIp: "127.0.0.1",
  });
  assert.ok(event);
  const stored = await WebhookEvent.findById(event._id).lean();
  assert.equal(stored.status, JobStatus.SIGNATURE_FAILED);
  assert.equal(stored.rawBody, undefined);
  assert.ok(stored.bodyDigest);
  assert.ok(stored.signatureDigest);
  assert.notEqual(stored.signatureDigest, "Bearer secret-value");
  assert.ok(stored.purgeAt);
});

test("claimWebhookForProcessing reclaims expired lease", async () => {
  const { tenant } = await seedTenantUser();
  const event = await persistVerifiedWebhook({
    tenantId: tenant._id,
    provider: "WHATSAPP",
    providerEventId: "wa:test:1",
    payload: { entry: [{ id: "e1" }] },
  });
  await WebhookEvent.updateOne(
    { _id: event._id },
    {
      $set: {
        status: JobStatus.PROCESSING,
        leaseOwner: "stale-worker",
        leaseExpiresAt: new Date(Date.now() - 1000),
      },
    },
  );
  const reclaimed = await reclaimExpiredWebhookLeases();
  assert.equal(reclaimed.reclaimed, 1);
  const claimed = await claimWebhookForProcessing(event._id, "new-worker");
  assert.ok(claimed);
  assert.equal(claimed.leaseOwner, "new-worker");
});

test("buildWhatsAppWebhookEventId is stable for status id", () => {
  const id = buildWhatsAppWebhookEventId({
    tenantId: "tnt_1",
    payload: {
      entry: [{
        changes: [{ value: { statuses: [{ id: "wamid.abc" }] } }],
      }],
    },
  });
  assert.equal(id, "wa:tnt_1:wamid.abc");
});

test("duplicate verified webhook returns null", async () => {
  const { tenant } = await seedTenantUser();
  const first = await persistVerifiedWebhook({
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: "pe:dup:1",
    payload: { type: "TEST" },
  });
  const second = await persistVerifiedWebhook({
    tenantId: tenant._id,
    provider: "PHONEPE",
    providerEventId: "pe:dup:1",
    payload: { type: "TEST" },
  });
  assert.ok(first);
  assert.equal(second, null);
});
