import { env } from "../config/env.js";
import {
  DevicePrincipalType,
  DeviceRegistrationStatus,
} from "../constants/enums.js";
import { fcmTokenRecordFromPlain } from "../lib/fcm-tokens.js";
import { sha256, unseal } from "../lib/crypto.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import { Customer, DeviceRegistration, User } from "../models/index.js";

function legacyModel(principalType) {
  return principalType === DevicePrincipalType.CUSTOMER ? Customer : User;
}

async function syncLegacyEmbedded({
  tenantId,
  principalType,
  principalId,
  deviceId,
  fcmToken,
  platform,
  session,
}) {
  const Model = legacyModel(principalType);
  const record = fcmTokenRecordFromPlain({ fcmToken, deviceId, platform });
  await Model.updateOne(
    { _id: principalId, tenantId },
    { $pull: { fcmTokens: { deviceId } } },
    { session },
  );
  await Model.updateOne(
    { _id: principalId, tenantId },
    { $push: { fcmTokens: record } },
    { session },
  );
}

async function enforceDeviceLimit({
  tenantId,
  principalType,
  principalId,
  session,
}) {
  const max = env.FCM_MAX_DEVICES_PER_PRINCIPAL ?? 10;
  const active = await DeviceRegistration.find({
    tenantId,
    principalType,
    principalId,
    status: DeviceRegistrationStatus.ACTIVE,
  })
    .sort({ lastRegisteredAt: 1 })
    .select("_id deviceId")
    .session(session)
    .lean();
  if (active.length <= max) return;
  const excess = active.slice(0, active.length - max);
  await DeviceRegistration.updateMany(
    { _id: { $in: excess.map((row) => row._id) } },
    {
      $set: {
        status: DeviceRegistrationStatus.REVOKED,
        invalidatedAt: new Date(),
        invalidReason: "DEVICE_LIMIT",
      },
    },
    { session },
  );
  const Model = legacyModel(principalType);
  await Model.updateOne(
    { _id: principalId, tenantId },
    { $pull: { fcmTokens: { deviceId: { $in: excess.map((row) => row.deviceId) } } } },
    { session },
  );
}

export async function registerFcmDevice({
  tenantId,
  principalType,
  principalId,
  deviceId,
  platform,
  fcmToken,
}) {
  const tokenHash = sha256(fcmToken);
  const tokenSealed = fcmTokenRecordFromPlain({ fcmToken, deviceId, platform }).tokenSealed;
  const now = new Date();

  return withTransaction(async (session) => {
    const displaced = await DeviceRegistration.find({
      tenantId,
      tokenHash,
      status: DeviceRegistrationStatus.ACTIVE,
      $or: [
        { principalId: { $ne: principalId } },
        { principalType: { $ne: principalType } },
      ],
    })
      .select("principalType principalId")
      .session(session)
      .lean();

    await DeviceRegistration.updateMany(
      {
        tenantId,
        tokenHash,
        status: DeviceRegistrationStatus.ACTIVE,
        $or: [
          { principalId: { $ne: principalId } },
          { principalType: { $ne: principalType } },
        ],
      },
      {
        $set: {
          status: DeviceRegistrationStatus.INVALIDATED,
          invalidatedAt: now,
          invalidReason: "TOKEN_REASSIGNED",
        },
      },
      { session },
    );

    for (const row of displaced) {
      const Model = legacyModel(row.principalType);
      await Model.updateOne(
        { _id: row.principalId, tenantId },
        { $pull: { fcmTokens: { tokenHash } } },
        { session },
      );
    }

    const registration = await DeviceRegistration.findOneAndUpdate(
      { tenantId, principalType, principalId, deviceId },
      {
        $set: {
          tokenHash,
          tokenSealed,
          platform,
          status: DeviceRegistrationStatus.ACTIVE,
          lastRegisteredAt: now,
          invalidatedAt: null,
          invalidReason: null,
        },
        $inc: { version: 1 },
        $setOnInsert: {
          _id: createId("dvr"),
          tenantId,
          principalType,
          principalId,
          deviceId,
        },
      },
      { upsert: true, new: true, session },
    );

    await enforceDeviceLimit({ tenantId, principalType, principalId, session });
    await syncLegacyEmbedded({
      tenantId,
      principalType,
      principalId,
      deviceId,
      fcmToken,
      platform,
      session,
    });

    return registration;
  });
}

export async function revokeFcmDevice({
  tenantId,
  principalType,
  principalId,
  deviceId,
}) {
  const now = new Date();
  await DeviceRegistration.updateOne(
    {
      tenantId,
      principalType,
      principalId,
      deviceId,
      status: DeviceRegistrationStatus.ACTIVE,
    },
    {
      $set: {
        status: DeviceRegistrationStatus.REVOKED,
        invalidatedAt: now,
        invalidReason: "USER_REVOKED",
      },
    },
  );
  const Model = legacyModel(principalType);
  await Model.updateOne(
    { _id: principalId, tenantId },
    { $pull: { fcmTokens: { deviceId } } },
  );
}

export async function listActiveDevicesForPrincipal({
  tenantId,
  principalType,
  principalId,
}) {
  const rows = await DeviceRegistration.find({
    tenantId,
    principalType,
    principalId,
    status: DeviceRegistrationStatus.ACTIVE,
  })
    .select("+tokenSealed deviceId platform tokenHash version")
    .lean();
  const devices = [];
  for (const row of rows) {
    try {
      const token = unseal(row.tokenSealed);
      if (token) {
        devices.push({
          deviceRegistrationId: row._id,
          deviceId: row.deviceId,
          platform: row.platform,
          tokenHash: row.tokenHash,
          registrationVersion: row.version ?? 0,
          token,
        });
      }
    } catch {
      // skip corrupt rows
    }
  }
  return devices;
}

/** Compatibility: embedded fcmTokens when no DeviceRegistration rows exist yet. */
export async function resolvePushDevicesForCustomer({ tenantId, customerId, legacyFcmTokens }) {
  const registered = await listActiveDevicesForPrincipal({
    tenantId,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customerId,
  });
  if (registered.length) return registered;
  const hasRegistryRow = await DeviceRegistration.exists({
    tenantId,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customerId,
  });
  if (hasRegistryRow) return [];
  const { decryptFcmTokens } = await import("../lib/fcm-tokens.js");
  return decryptFcmTokens(legacyFcmTokens ?? []).map((row) => ({
    deviceRegistrationId: null,
    deviceId: row.deviceId,
    platform: row.platform,
    tokenHash: row.tokenHash,
    token: row.token,
  }));
}

export async function invalidateDeviceRegistrations(tenantId, entries, reason) {
  if (!tenantId) throw new Error("tenantId is required for invalidateDeviceRegistrations");
  if (!entries?.length) return;
  const now = new Date();
  for (const row of entries) {
    if (!row?.id || !row.expectedTokenHash || row.registrationVersion == null) continue;
    await DeviceRegistration.updateOne(
      {
        _id: row.id,
        tenantId,
        status: DeviceRegistrationStatus.ACTIVE,
        tokenHash: row.expectedTokenHash,
        version: row.registrationVersion,
      },
      {
        $set: {
          status: DeviceRegistrationStatus.INVALIDATED,
          invalidatedAt: now,
          invalidReason: reason ?? "FCM_INVALID_TOKEN",
        },
      },
    );
  }
}

export async function markDeviceSuccess(tenantId, deviceRegistrationIds) {
  if (!tenantId) throw new Error("tenantId is required for markDeviceSuccess");
  if (!deviceRegistrationIds?.length) return;
  await DeviceRegistration.updateMany(
    { tenantId, _id: { $in: deviceRegistrationIds } },
    { $set: { lastSuccessAt: new Date() } },
  );
}

export async function markDeviceFailure(tenantId, deviceRegistrationIds) {
  if (!tenantId) throw new Error("tenantId is required for markDeviceFailure");
  if (!deviceRegistrationIds?.length) return;
  await DeviceRegistration.updateMany(
    { tenantId, _id: { $in: deviceRegistrationIds } },
    { $set: { lastFailureAt: new Date() } },
  );
}
