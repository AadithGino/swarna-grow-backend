import test from "node:test";
import assert from "node:assert/strict";
import { PushOutcomeKind } from "../src/lib/fcm-outcomes.js";
import { seal } from "../src/lib/crypto.js";
import { connectRedis, disconnectRedis } from "../src/config/redis.js";
import {
  pushProvider,
  pushProviderTestHooks,
} from "../src/integrations/push.provider.js";

test.before(async () => {
  const ok = await connectRedis().catch(() => false);
  assert.ok(ok, "Redis required for push provider tests (FCM rate limiter)");
});
test.after(async () => {
  await disconnectRedis().catch(() => {});
});

const originalFetch = globalThis.fetch;

const tenant = {
  _id: "tnt_test",
  integrationSecrets: {
    fcm: {
      projectId: "project-test",
      serviceAccountJsonSealed: seal(JSON.stringify({
        client_email: "x@test.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n",
      })),
      credentialVersion: 1,
    },
  },
};

test("push provider returns provider message name on success", async () => {
  pushProviderTestHooks.forceLive = true;
  pushProviderTestHooks.accessTokenProvider = async () => "test-access-token";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ name: "projects/p/messages/abc123" }),
    headers: { get: () => null },
  });
  const result = await pushProvider.send({
    tenant,
    devices: [{ token: "device-token-1", deviceRegistrationId: "dvr_1" }],
    title: "Hello",
    body: "World",
    messageType: "PAYMENT_DUE",
  });
  assert.equal(result.successCount, 1);
  assert.equal(result.outcomes[0].kind, PushOutcomeKind.SUCCESS);
  assert.equal(result.outcomes[0].providerMessageId, "projects/p/messages/abc123");
  pushProviderTestHooks.accessTokenProvider = null;
  pushProviderTestHooks.forceLive = false;
  globalThis.fetch = originalFetch;
});

test("push provider does not mark INVALID_ARGUMENT tokens invalid", async () => {
  pushProviderTestHooks.forceLive = true;
  pushProviderTestHooks.accessTokenProvider = async () => "test-access-token";
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({
      error: { status: "INVALID_ARGUMENT", details: [{ errorCode: "INVALID_ARGUMENT" }] },
    }),
    headers: { get: () => null },
  });
  const result = await pushProvider.send({
    tenant,
    devices: [{ token: "device-token-2", deviceRegistrationId: "dvr_2" }],
    title: "Hello",
    body: "World",
  });
  assert.equal(result.successCount, 0);
  assert.equal(result.invalidRegistrationIds.length, 0);
  assert.equal(result.outcomes[0].kind, PushOutcomeKind.PERMANENT_PAYLOAD_ERROR);
  pushProviderTestHooks.accessTokenProvider = null;
  pushProviderTestHooks.forceLive = false;
  globalThis.fetch = originalFetch;
});
