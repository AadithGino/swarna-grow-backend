import test from "node:test";
import assert from "node:assert/strict";
import { PushOutcomeKind } from "../src/lib/fcm-outcomes.js";
import { PushDeviceDeliveryStatus } from "../src/constants/enums.js";
import {
  applyPushOutcomes,
  claimDeliveriesForProcessing,
  ensurePushDeliveries,
  releaseDeferredDeliveries,
  PushDeliveryApplyResult,
} from "../src/services/push-delivery.service.js";
import { clearFcmPushTestHooks } from "../src/lib/fcm-push-test-hooks.js";
import { PushDeviceDelivery } from "../src/models/index.js";
import { startTestDb, stopTestDb, resetTestDb } from "./helpers/db.js";
test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearFcmPushTestHooks();
});

test("unique claim token per delivery attempt", async () => {
  const tenantId = "tnt_claim";
  const messageId = "msg_claim";
  await ensurePushDeliveries({
    tenantId,
    messageId,
    devices: [{ deviceRegistrationId: "dvr_1", tokenHash: "h1" }],
  });
  const first = await claimDeliveriesForProcessing({
    tenantId,
    messageId,
    deviceRegistrationIds: ["dvr_1"],
  });
  await releaseDeferredDeliveries({
    tenantId,
    messageId,
    claims: [{ deviceRegistrationId: "dvr_1", claimToken: first[0].claimToken }],
  });
  const second = await claimDeliveriesForProcessing({
    tenantId,
    messageId,
    deviceRegistrationIds: ["dvr_1"],
  });
  assert.notEqual(first[0].claimToken, second[0].claimToken);
});

test("stale owner cannot apply success while new owner holds claim", async () => {
  const tenantId = "tnt_stale";
  const messageId = "msg_stale";
  await ensurePushDeliveries({
    tenantId,
    messageId,
    devices: [{ deviceRegistrationId: "dvr_stale", tokenHash: "hx" }],
  });
  const claimedA = await claimDeliveriesForProcessing({
    tenantId,
    messageId,
    deviceRegistrationIds: ["dvr_stale"],
  });
  const tokenA = claimedA[0].claimToken;
  await PushDeviceDelivery.updateOne(
    { tenantId, messageId, deviceRegistrationId: "dvr_stale" },
    {
      $set: {
        claimExpiresAt: new Date(Date.now() - 1000),
        status: PushDeviceDeliveryStatus.PROCESSING,
      },
    },
  );
  const claimedB = await claimDeliveriesForProcessing({
    tenantId,
    messageId,
    deviceRegistrationIds: ["dvr_stale"],
  });
  const tokenB = claimedB[0].claimToken;
  assert.notEqual(tokenA, tokenB);

  const lost = await applyPushOutcomes({
    tenantId,
    messageId,
    outcomes: [{
      deviceRegistrationId: "dvr_stale",
      claimToken: tokenA,
      kind: PushOutcomeKind.SUCCESS,
      attempt: 1,
    }],
  });
  assert.equal(lost[0].result, PushDeliveryApplyResult.CLAIM_LOST);

  const ok = await applyPushOutcomes({
    tenantId,
    messageId,
    outcomes: [{
      deviceRegistrationId: "dvr_stale",
      claimToken: tokenB,
      kind: PushOutcomeKind.SUCCESS,
      attempt: 1,
    }],
  });
  assert.equal(ok[0].result, PushDeliveryApplyResult.APPLIED);
  const row = await PushDeviceDelivery.findOne({ tenantId, messageId, deviceRegistrationId: "dvr_stale" }).lean();
  assert.equal(row.status, PushDeviceDeliveryStatus.SUCCEEDED);
  assert.equal(row.claimToken, undefined);
});

test("rate-limit defer release restores attempt with exact claim token only", async () => {
  const tenantId = "tnt_defer";
  const messageId = "msg_defer";
  await ensurePushDeliveries({
    tenantId,
    messageId,
    devices: [{ deviceRegistrationId: "dvr_def", tokenHash: "hd" }],
  });
  const claimed = await claimDeliveriesForProcessing({
    tenantId,
    messageId,
    deviceRegistrationIds: ["dvr_def"],
  });
  const before = claimed[0].attemptCount;
  await releaseDeferredDeliveries({
    tenantId,
    messageId,
    claims: [{ deviceRegistrationId: "dvr_def", claimToken: claimed[0].claimToken }],
  });
  const row = await PushDeviceDelivery.findOne({ tenantId, messageId, deviceRegistrationId: "dvr_def" }).lean();
  assert.equal(row.attemptCount, before - 1);
  assert.equal(row.status, PushDeviceDeliveryStatus.RETRYABLE_FAILED);
});

test("non-expired claim cannot be stolen", async () => {
  const tenantId = "tnt_no_steal";
  const messageId = "msg_no_steal";
  await ensurePushDeliveries({
    tenantId,
    messageId,
    devices: [{ deviceRegistrationId: "dvr_ns", tokenHash: "hn" }],
  });
  const claimedA = await claimDeliveriesForProcessing({
    tenantId,
    messageId,
    deviceRegistrationIds: ["dvr_ns"],
  });
  const claimedB = await claimDeliveriesForProcessing({
    tenantId,
    messageId,
    deviceRegistrationIds: ["dvr_ns"],
  });
  assert.equal(claimedB.length, 0);
  assert.ok(claimedA[0].claimExpiresAt > new Date());
});

test("apply outcome hook inaccessible outside test mode", async () => {
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const script = `
    import assert from "node:assert/strict";
    import { armPauseBeforeApplyPushOutcome } from "./src/lib/fcm-push-test-hooks.js";
    assert.throws(() => armPauseBeforeApplyPushOutcome(), /NODE_ENV=test/);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
});

test("terminal delivery row cannot regress on retry", async () => {
  const tenantId = "tnt_term";
  const messageId = "msg_term";
  await PushDeviceDelivery.create({
    _id: "pdd_term2",
    tenantId,
    messageId,
    deviceRegistrationId: "dvr_term",
    status: PushDeviceDeliveryStatus.SUCCEEDED,
    attemptCount: 1,
    claimToken: "stale",
  });
  const results = await applyPushOutcomes({
    tenantId,
    messageId,
    outcomes: [{
      deviceRegistrationId: "dvr_term",
      claimToken: "stale",
      kind: PushOutcomeKind.TRANSIENT,
      attempt: 2,
    }],
  });
  assert.equal(results[0].result, PushDeliveryApplyResult.SKIPPED);
});
