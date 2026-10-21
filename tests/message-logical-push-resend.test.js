process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert/strict";
import { MessageType, PushDeviceDeliveryStatus, DevicePrincipalType } from "../src/constants/enums.js";
import { PushOutcomeKind } from "../src/lib/fcm-outcomes.js";
import { createId } from "../src/lib/ids.js";
import { pushProviderTestHooks } from "../src/integrations/push.provider.js";
import { clearFcmPushTestHooks } from "../src/lib/fcm-push-test-hooks.js";
import { ensurePushDeliveries, listDeliveriesToSend } from "../src/services/push-delivery.service.js";
import { registerFcmDevice } from "../src/services/device-registration.service.js";
import { resendMessage } from "../src/services/messaging.service.js";
import { processMessage } from "../src/workers/processors.js";
import { Message, PushDeviceDelivery } from "../src/models/index.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
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

async function seedLogicalPushMessage({ tenant, branch, customer, inboxEventKey }) {
  return Message.create({
    _id: createId("message"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    type: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    status: "FAILED",
    channel: "PUSH",
    templateKey: MessageType.DIGITAL_METAL_PURCHASE_CREDITED,
    reminderDedupeKey: inboxEventKey,
    templateParams: { inboxEventKey, title: "t", body: "b" },
  });
}

function resendCtx(user, tenant, branch, messageId) {
  return {
    auth: { id: user._id, tenantId: tenant._id, role: user.role },
    scope: { tenantId: tenant._id, branchId: branch._id },
    headers: {},
    ip: "127.0.0.1",
    params: { messageId },
  };
}

test("logical resend revives DEAD_LETTER delivery and processMessage retries device (mock FCM)", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_resend_a",
    platform: "android",
    fcmToken: "token-resend-a",
  });
  const inboxEventKey = "digital_metal.test:resend-revive";
  const msg = await seedLogicalPushMessage({ tenant, branch, customer, inboxEventKey });
  await ensurePushDeliveries({
    tenantId: tenant._id,
    messageId: msg._id,
    devices: [{ deviceRegistrationId: reg._id, tokenHash: "hash_a" }],
  });
  await PushDeviceDelivery.updateOne(
    { tenantId: tenant._id, messageId: msg._id, deviceRegistrationId: reg._id },
    {
      $set: {
        status: PushDeviceDeliveryStatus.DEAD_LETTER,
        attemptCount: 3,
        deadLetteredAt: new Date(),
      },
    },
  );

  pushProviderTestHooks.sendOverride = async ({ devices }) => ({
    outcomes: devices.map((d) => ({
      deviceRegistrationId: d.deviceRegistrationId,
      kind: PushOutcomeKind.SUCCESS,
      providerMessageId: "mock/resend-ok",
    })),
    successCount: devices.length,
    failureCount: 0,
    invalidRegistrationIds: [],
    invalidTokens: [],
  });

  const resent = await resendMessage(resendCtx(user, tenant, branch, msg._id));
  assert.equal(resent.status, "QUEUED");
  assert.equal(resent.resendOutcome, "RETRY_SCHEDULED");
  const pending = await listDeliveriesToSend(msg._id, tenant._id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].deviceRegistrationId, reg._id);

  await processMessage({ data: { messageId: msg._id }, moveToDelayed: async () => {}, token: "t1" });
  const delivery = await PushDeviceDelivery.findOne({
    tenantId: tenant._id,
    messageId: msg._id,
    deviceRegistrationId: reg._id,
  }).lean();
  assert.equal(delivery.status, PushDeviceDeliveryStatus.SUCCEEDED);
  assert.equal(await Message.countDocuments({ tenantId: tenant._id, reminderDedupeKey: inboxEventKey }), 1);
});

test("logical resend does not re-send SUCCEEDED device", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const regOk = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_ok",
    platform: "android",
    fcmToken: "token-ok",
  });
  const regFail = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_fail",
    platform: "android",
    fcmToken: "token-fail",
  });
  const msg = await seedLogicalPushMessage({
    tenant,
    branch,
    customer,
    inboxEventKey: "digital_metal.test:partial",
  });
  await ensurePushDeliveries({
    tenantId: tenant._id,
    messageId: msg._id,
    devices: [
      { deviceRegistrationId: regOk._id, tokenHash: "h1" },
      { deviceRegistrationId: regFail._id, tokenHash: "h2" },
    ],
  });
  await PushDeviceDelivery.updateOne(
    { tenantId: tenant._id, messageId: msg._id, deviceRegistrationId: regOk._id },
    { $set: { status: PushDeviceDeliveryStatus.SUCCEEDED, succeededAt: new Date() } },
  );
  await PushDeviceDelivery.updateOne(
    { tenantId: tenant._id, messageId: msg._id, deviceRegistrationId: regFail._id },
    { $set: { status: PushDeviceDeliveryStatus.DEAD_LETTER, attemptCount: 3 } },
  );

  let sendCount = 0;
  pushProviderTestHooks.sendOverride = async ({ devices }) => {
    sendCount += devices.length;
    return {
      outcomes: devices.map((d) => ({
        deviceRegistrationId: d.deviceRegistrationId,
        kind: PushOutcomeKind.SUCCESS,
      })),
      successCount: devices.length,
      failureCount: 0,
      invalidRegistrationIds: [],
      invalidTokens: [],
    };
  };

  await resendMessage(resendCtx(user, tenant, branch, msg._id));
  await processMessage({ data: { messageId: msg._id }, moveToDelayed: async () => {}, token: "t2" });
  assert.equal(sendCount, 1);
});

test("PERMANENT_FAILED device stays excluded after resend", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_perm",
    platform: "android",
    fcmToken: "token-perm",
  });
  const msg = await seedLogicalPushMessage({
    tenant,
    branch,
    customer,
    inboxEventKey: "digital_metal.test:perm",
  });
  await PushDeviceDelivery.create({
    _id: createId("pdd"),
    tenantId: tenant._id,
    messageId: msg._id,
    deviceRegistrationId: reg._id,
    status: PushDeviceDeliveryStatus.PERMANENT_FAILED,
    attemptCount: 1,
  });
  const resent = await resendMessage(resendCtx(user, tenant, branch, msg._id));
  assert.equal(resent.resendOutcome, "NO_RETRY_TARGETS");
  assert.equal(resent.status, "FAILED");
  assert.equal(await listDeliveriesToSend(msg._id, tenant._id).then((r) => r.length), 0);
});

test("active device claim is preserved on resend", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_claim",
    platform: "android",
    fcmToken: "token-claim",
  });
  const msg = await seedLogicalPushMessage({
    tenant,
    branch,
    customer,
    inboxEventKey: "digital_metal.test:claim",
  });
  await PushDeviceDelivery.create({
    _id: createId("pdd"),
    tenantId: tenant._id,
    messageId: msg._id,
    deviceRegistrationId: reg._id,
    status: PushDeviceDeliveryStatus.PROCESSING,
    attemptCount: 1,
    claimToken: "active_claim",
    claimExpiresAt: new Date(Date.now() + 120_000),
  });
  const before = await Message.findById(msg._id).lean();
  const resent = await resendMessage(resendCtx(user, tenant, branch, msg._id));
  assert.equal(resent.resendOutcome, "ACTIVE_CLAIMS_ONLY");
  const row = await PushDeviceDelivery.findOne({ messageId: msg._id, deviceRegistrationId: reg._id }).lean();
  assert.equal(row.status, PushDeviceDeliveryStatus.PROCESSING);
  assert.equal(row.claimToken, "active_claim");
  assert.equal(before.status, resent.status);
});

test("consecutive resends do not duplicate Message rows", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_dup",
    platform: "android",
    fcmToken: "token-dup",
  });
  const inboxEventKey = "digital_metal.test:dup-resend";
  const msg = await seedLogicalPushMessage({ tenant, branch, customer, inboxEventKey });
  await ensurePushDeliveries({
    tenantId: tenant._id,
    messageId: msg._id,
    devices: [{ deviceRegistrationId: reg._id, tokenHash: "hd" }],
  });
  await PushDeviceDelivery.updateOne(
    { tenantId: tenant._id, messageId: msg._id },
    { $set: { status: PushDeviceDeliveryStatus.DEAD_LETTER, attemptCount: 3 } },
  );
  const ctx = resendCtx(user, tenant, branch, msg._id);
  await resendMessage(ctx);
  await resendMessage(ctx);
  assert.equal(await Message.countDocuments({ tenantId: tenant._id, reminderDedupeKey: inboxEventKey }), 1);
  const updated = await Message.findById(msg._id).lean();
  assert.equal(updated.logicalResendCount, 2);
});

test("retired device delivery is finalized and message does not stay QUEUED after processMessage", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_retired",
    platform: "android",
    fcmToken: "token-retired",
  });
  const msg = await seedLogicalPushMessage({
    tenant,
    branch,
    customer,
    inboxEventKey: "digital_metal.test:retired-dev",
  });
  await ensurePushDeliveries({
    tenantId: tenant._id,
    messageId: msg._id,
    devices: [{ deviceRegistrationId: reg._id, tokenHash: "h-ret" }],
  });
  await PushDeviceDelivery.updateOne(
    { tenantId: tenant._id, messageId: msg._id },
    { $set: { status: PushDeviceDeliveryStatus.DEAD_LETTER, attemptCount: 4 } },
  );
  const { invalidateDeviceRegistrations } = await import("../src/services/device-registration.service.js");
  const { DeviceRegistration } = await import("../src/models/index.js");
  const regDoc = await DeviceRegistration.findById(reg._id).lean();
  await invalidateDeviceRegistrations(
    tenant._id,
    [{ id: reg._id, expectedTokenHash: regDoc.tokenHash, registrationVersion: regDoc.version }],
    "TEST_RETIRE",
  );
  const resent = await resendMessage(resendCtx(user, tenant, branch, msg._id));
  assert.equal(resent.resendOutcome, "NO_RETRY_TARGETS");
  assert.equal(resent.status, "FAILED");
  await processMessage({ data: { messageId: msg._id } });
  const after = await Message.findById(msg._id).lean();
  assert.notEqual(after.status, "QUEUED");
  const row = await PushDeviceDelivery.findOne({ messageId: msg._id, deviceRegistrationId: reg._id }).lean();
  assert.equal(row.status, PushDeviceDeliveryStatus.PERMANENT_FAILED);
});

test("reconcile skips ineligible delivery with unexpired PROCESSING claim", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_inel_claim",
    platform: "android",
    fcmToken: "token-inel-claim",
  });
  const msg = await seedLogicalPushMessage({
    tenant,
    branch,
    customer,
    inboxEventKey: "digital_metal.test:inel-claim",
  });
  await PushDeviceDelivery.create({
    _id: createId("pdd"),
    tenantId: tenant._id,
    messageId: msg._id,
    deviceRegistrationId: reg._id,
    status: PushDeviceDeliveryStatus.PROCESSING,
    attemptCount: 1,
    claimToken: "worker_live",
    claimExpiresAt: new Date(Date.now() + 120_000),
  });
  const { invalidateDeviceRegistrations } = await import("../src/services/device-registration.service.js");
  const { DeviceRegistration } = await import("../src/models/index.js");
  const regDoc = await DeviceRegistration.findById(reg._id).lean();
  await invalidateDeviceRegistrations(
    tenant._id,
    [{ id: reg._id, expectedTokenHash: regDoc.tokenHash, registrationVersion: regDoc.version }],
    "TEST_RETIRE",
  );
  const resent = await resendMessage(resendCtx(user, tenant, branch, msg._id));
  assert.equal(resent.resendOutcome, "ACTIVE_CLAIMS_ONLY");
  const row = await PushDeviceDelivery.findOne({ messageId: msg._id, deviceRegistrationId: reg._id }).lean();
  assert.equal(row.status, PushDeviceDeliveryStatus.PROCESSING);
  assert.equal(row.claimToken, "worker_live");
});

test("resend with no device deliveries marks message FAILED not stuck QUEUED", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const msg = await seedLogicalPushMessage({
    tenant,
    branch,
    customer,
    inboxEventKey: "digital_metal.test:no-dev",
  });
  const resent = await resendMessage(resendCtx(user, tenant, branch, msg._id));
  assert.equal(resent.status, "FAILED");
  assert.equal(resent.resendOutcome, "NO_DEVICES");
});

test("transaction rollback leaves message and delivery rows unchanged", async () => {
  const { withTransientTransactionRetry } = await import("../src/lib/transaction.js");
  const { prepareDeliveriesForLogicalResend } = await import("../src/services/push-delivery.service.js");
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_rb",
    platform: "android",
    fcmToken: "token-rb",
  });
  const msg = await seedLogicalPushMessage({
    tenant,
    branch,
    customer,
    inboxEventKey: "digital_metal.test:rollback",
  });
  await ensurePushDeliveries({
    tenantId: tenant._id,
    messageId: msg._id,
    devices: [{ deviceRegistrationId: reg._id, tokenHash: "hrb" }],
  });
  await PushDeviceDelivery.updateOne(
    { tenantId: tenant._id, messageId: msg._id },
    { $set: { status: PushDeviceDeliveryStatus.DEAD_LETTER, attemptCount: 3 } },
  );
  const beforeMsg = await Message.findById(msg._id).lean();
  const beforeDel = await PushDeviceDelivery.findOne({ messageId: msg._id }).lean();
  await assert.rejects(
    () =>
      withTransientTransactionRetry(async (session) => {
        await prepareDeliveriesForLogicalResend(
          { tenantId: tenant._id, messageId: msg._id, customerId: customer._id },
          session,
        );
        throw new Error("ROLLBACK_TEST");
      }),
    /ROLLBACK_TEST/,
  );
  const afterMsg = await Message.findById(msg._id).lean();
  const afterDel = await PushDeviceDelivery.findOne({ messageId: msg._id }).lean();
  assert.equal(afterMsg.status, beforeMsg.status);
  assert.equal(afterDel.status, beforeDel.status);
  assert.equal(afterDel.attemptCount, beforeDel.attemptCount);
});

test("expired PROCESSING claim on ineligible device is finalized on resend", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_exp_claim",
    platform: "android",
    fcmToken: "token-exp-claim",
  });
  const msg = await seedLogicalPushMessage({
    tenant,
    branch,
    customer,
    inboxEventKey: "digital_metal.test:exp-claim",
  });
  await PushDeviceDelivery.create({
    _id: createId("pdd"),
    tenantId: tenant._id,
    messageId: msg._id,
    deviceRegistrationId: reg._id,
    status: PushDeviceDeliveryStatus.PROCESSING,
    attemptCount: 1,
    claimToken: "stale_worker",
    claimExpiresAt: new Date(Date.now() - 60_000),
  });
  const { invalidateDeviceRegistrations } = await import("../src/services/device-registration.service.js");
  const { DeviceRegistration } = await import("../src/models/index.js");
  const regDoc = await DeviceRegistration.findById(reg._id).lean();
  await invalidateDeviceRegistrations(
    tenant._id,
    [{ id: reg._id, expectedTokenHash: regDoc.tokenHash, registrationVersion: regDoc.version }],
    "TEST_RETIRE",
  );
  const resent = await resendMessage(resendCtx(user, tenant, branch, msg._id));
  assert.equal(resent.resendOutcome, "NO_RETRY_TARGETS");
  const row = await PushDeviceDelivery.findOne({ messageId: msg._id, deviceRegistrationId: reg._id }).lean();
  assert.equal(row.status, PushDeviceDeliveryStatus.PERMANENT_FAILED);
  assert.equal(row.lastErrorCode, "DEVICE_INELIGIBLE");
});

test("newly registered device gets delivery row on logical resend", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const regOld = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_old_only",
    platform: "android",
    fcmToken: "token-old",
  });
  const msg = await seedLogicalPushMessage({
    tenant,
    branch,
    customer,
    inboxEventKey: "digital_metal.test:new-device",
  });
  await ensurePushDeliveries({
    tenantId: tenant._id,
    messageId: msg._id,
    devices: [{ deviceRegistrationId: regOld._id, tokenHash: "ho" }],
  });
  await PushDeviceDelivery.updateOne(
    { tenantId: tenant._id, messageId: msg._id, deviceRegistrationId: regOld._id },
    { $set: { status: PushDeviceDeliveryStatus.PERMANENT_FAILED } },
  );
  const regNew = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_new_eligible",
    platform: "android",
    fcmToken: "token-new",
  });
  const resent = await resendMessage(resendCtx(user, tenant, branch, msg._id));
  assert.equal(resent.resendOutcome, "RETRY_SCHEDULED");
  const newRow = await PushDeviceDelivery.findOne({
    messageId: msg._id,
    deviceRegistrationId: regNew._id,
  }).lean();
  assert.ok(newRow);
  assert.equal(newRow.status, PushDeviceDeliveryStatus.QUEUED);
});

test("concurrent resend requests serialize without duplicate Message rows", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const reg = await registerFcmDevice({
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customer._id,
    deviceId: "dev_conc",
    platform: "android",
    fcmToken: "token-conc",
  });
  const inboxEventKey = "digital_metal.test:conc-resend";
  const msg = await seedLogicalPushMessage({ tenant, branch, customer, inboxEventKey });
  await ensurePushDeliveries({
    tenantId: tenant._id,
    messageId: msg._id,
    devices: [{ deviceRegistrationId: reg._id, tokenHash: "hc" }],
  });
  await PushDeviceDelivery.updateOne(
    { tenantId: tenant._id, messageId: msg._id },
    { $set: { status: PushDeviceDeliveryStatus.DEAD_LETTER, attemptCount: 3 } },
  );
  const ctx = resendCtx(user, tenant, branch, msg._id);
  await Promise.all([resendMessage(ctx), resendMessage(ctx)]);
  assert.equal(await Message.countDocuments({ tenantId: tenant._id, reminderDedupeKey: inboxEventKey }), 1);
  const updated = await Message.findById(msg._id).lean();
  assert.ok((updated.logicalResendCount ?? 0) >= 1);
});
