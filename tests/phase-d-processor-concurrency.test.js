process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { env } from "../src/config/env.js";
import { PushOutcomeKind } from "../src/lib/fcm-outcomes.js";
import { PushDeviceDeliveryStatus, MessageType } from "../src/constants/enums.js";
import {
  armPauseBeforeApplyPushOutcome,
  clearFcmPushTestHooks,
} from "../src/lib/fcm-push-test-hooks.js";
import {
  ensurePushDeliveries,
  claimDeliveriesForProcessing,
  PushDeliveryApplyResult,
} from "../src/services/push-delivery.service.js";
import { markDeviceSuccess } from "../src/services/device-registration.service.js";
import { pushProviderTestHooks } from "../src/integrations/push.provider.js";
import { processMessage } from "../src/workers/processors.js";
import { Alert, DeviceRegistration, Message, PushDeviceDelivery } from "../src/models/index.js";
import { registerFcmDevice } from "../src/services/device-registration.service.js";
import { DevicePrincipalType } from "../src/constants/enums.js";
import { startTestDb, stopTestDb, resetTestDb, seedTenantUser, seedCustomer } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => {
  pushProviderTestHooks.sendOverride = null;
  clearFcmPushTestHooks();
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  pushProviderTestHooks.sendOverride = null;
  clearFcmPushTestHooks();
});

async function seedPushMessage({ tenant, branch, customer, deviceRegId }) {
  const message = await Message.create({
    _id: createId("msg"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    type: MessageType.MANUAL_PUSH,
    status: "QUEUED",
    channel: "PUSH",
    templateKey: MessageType.MANUAL_PUSH,
    templateParams: { title: "T", body: "B", broadcastId: "pbc_test" },
    dispatchPriority: 10,
  });
  await ensurePushDeliveries({
    tenantId: tenant._id,
    messageId: message._id,
    devices: [{ deviceRegistrationId: deviceRegId, tokenHash: "hash_proc" }],
  });
  return message;
}

test("stale worker apply loses claim without device or message side effects", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_proc_a",
    platform: "android",
    fcmToken: "proc-token-a",
  });
  const message = await seedPushMessage({
    tenant, branch, customer, deviceRegId: reg._id,
  });
  const pause = armPauseBeforeApplyPushOutcome();
  pushProviderTestHooks.sendOverride = async ({ devices }) => ({
    outcomes: devices.map((device) => ({
      deviceRegistrationId: device.deviceRegistrationId,
      kind: PushOutcomeKind.SUCCESS,
      providerMessageId: "mock/success",
    })),
    successCount: devices.length,
    failureCount: 0,
    invalidRegistrationIds: [],
    invalidTokens: [],
  });

  const jobA = processMessage({
    data: { messageId: message._id },
    moveToDelayed: async () => {},
    token: "tok_a",
  });
  await pause.waitUntilPaused();
  await PushDeviceDelivery.updateMany(
    { tenantId: tenant._id, messageId: message._id },
    { $set: { claimExpiresAt: new Date(Date.now() - 1000) } },
  );
  pause.disarm();
  const reclaimed = await claimDeliveriesForProcessing({
    tenantId: tenant._id,
    messageId: message._id,
    deviceRegistrationIds: [reg._id],
  });
  assert.equal(reclaimed.length, 1);
  const { applyPushOutcomes } = await import("../src/services/push-delivery.service.js");
  await applyPushOutcomes({
    tenantId: tenant._id,
    messageId: message._id,
    outcomes: [{
      deviceRegistrationId: reg._id,
      claimToken: reclaimed[0].claimToken,
      kind: PushOutcomeKind.SUCCESS,
      providerMessageId: "mock/b",
    }],
  });
  await markDeviceSuccess(tenant._id, [reg._id]);
  message.status = "SENT";
  await message.save();
  pause.resume();
  await jobA;

  const delivery = await PushDeviceDelivery.findOne({
    tenantId: tenant._id,
    messageId: message._id,
    deviceRegistrationId: reg._id,
  }).lean();
  assert.equal(delivery.status, PushDeviceDeliveryStatus.SUCCEEDED);
  assert.ok(delivery.succeededAt);
  const regRow = await DeviceRegistration.findById(reg._id).lean();
  assert.ok(regRow.lastSuccessAt || delivery.succeededAt);
  const msg = await Message.findById(message._id).lean();
  assert.equal(msg.status, "SENT");
  pause.disarm();
});

test("duplicate worker with active claim does not mark message failed", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_proc_dup",
    platform: "android",
    fcmToken: "proc-token-dup",
  });
  const message = await seedPushMessage({
    tenant, branch, customer, deviceRegId: reg._id,
  });
  await claimDeliveriesForProcessing({
    tenantId: tenant._id,
    messageId: message._id,
    deviceRegistrationIds: [reg._id],
  });
  await processMessage({
    data: { messageId: message._id },
    moveToDelayed: async () => {},
    token: "tok",
  });
  const msg = await Message.findById(message._id).lean();
  assert.notEqual(msg.status, "FAILED");
});

test("exhaustion alert not created when stale worker loses claim on transient outcome", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_proc_ex",
    platform: "android",
    fcmToken: "proc-token-ex",
  });
  const message = await seedPushMessage({
    tenant, branch, customer, deviceRegId: reg._id,
  });
  const maxAttempts = env.FCM_MAX_ATTEMPTS ?? 3;
  await PushDeviceDelivery.updateOne(
    { tenantId: tenant._id, messageId: message._id, deviceRegistrationId: reg._id },
    { $set: { attemptCount: maxAttempts - 1, status: PushDeviceDeliveryStatus.RETRYABLE_FAILED } },
  );
  const claimed = await claimDeliveriesForProcessing({
    tenantId: tenant._id,
    messageId: message._id,
    deviceRegistrationIds: [reg._id],
  });
  const staleToken = claimed[0].claimToken;
  await PushDeviceDelivery.updateOne(
    { tenantId: tenant._id, messageId: message._id, deviceRegistrationId: reg._id },
    { $set: { claimExpiresAt: new Date(Date.now() - 1000) } },
  );
  await claimDeliveriesForProcessing({
    tenantId: tenant._id,
    messageId: message._id,
    deviceRegistrationIds: [reg._id],
  });
  const { applyPushOutcomes } = await import("../src/services/push-delivery.service.js");
  const lost = await applyPushOutcomes({
    tenantId: tenant._id,
    messageId: message._id,
    outcomes: [{
      deviceRegistrationId: reg._id,
      claimToken: staleToken,
      kind: PushOutcomeKind.TRANSIENT,
      attempt: maxAttempts,
    }],
  });
  assert.equal(lost[0].result, PushDeliveryApplyResult.CLAIM_LOST);
  const alerts = await Alert.countDocuments({
    tenantId: tenant._id,
    type: "FCM_DELIVERY_EXHAUSTED",
    entityId: message._id,
  });
  assert.equal(alerts, 0);
});

test("terminal message status remains immutable", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_proc_term",
    platform: "android",
    fcmToken: "proc-token-term",
  });
  const message = await Message.create({
    _id: createId("msg"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    type: MessageType.MANUAL_PUSH,
    status: "DELIVERED",
    channel: "PUSH",
    templateKey: MessageType.MANUAL_PUSH,
    templateParams: { title: "T", body: "B" },
    dispatchPriority: 10,
  });
  await ensurePushDeliveries({
    tenantId: tenant._id,
    messageId: message._id,
    devices: [{ deviceRegistrationId: reg._id, tokenHash: "hx" }],
  });
  await processMessage({
    data: { messageId: message._id },
    moveToDelayed: async () => {},
    token: "tok",
  });
  const msg = await Message.findById(message._id).lean();
  assert.equal(msg.status, "DELIVERED");
});

test("concurrent ensurePushDeliveries through processMessage creates one row per device", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_conc_create",
    platform: "android",
    fcmToken: "proc-conc-create",
  });
  const message = await Message.create({
    _id: createId("msg"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    type: MessageType.MANUAL_PUSH,
    status: "QUEUED",
    channel: "PUSH",
    templateKey: MessageType.MANUAL_PUSH,
    templateParams: { title: "T", body: "B" },
    dispatchPriority: 10,
  });
  pushProviderTestHooks.sendOverride = async ({ devices }) => ({
    outcomes: devices.map((device) => ({
      deviceRegistrationId: device.deviceRegistrationId,
      kind: PushOutcomeKind.SUCCESS,
      providerMessageId: "mock/conc-create",
    })),
    successCount: devices.length,
    failureCount: 0,
    invalidRegistrationIds: [],
    invalidTokens: [],
  });
  await Promise.all([
    processMessage({ data: { messageId: message._id }, moveToDelayed: async () => {}, token: "a" }),
    processMessage({ data: { messageId: message._id }, moveToDelayed: async () => {}, token: "b" }),
  ]);
  assert.equal(
    await PushDeviceDelivery.countDocuments({
      tenantId: tenant._id,
      messageId: message._id,
      deviceRegistrationId: reg._id,
    }),
    1,
  );
  const row = await PushDeviceDelivery.findOne({
    tenantId: tenant._id,
    messageId: message._id,
    deviceRegistrationId: reg._id,
  }).lean();
  assert.notEqual(row.status, PushDeviceDeliveryStatus.PERMANENT_FAILED);
});
