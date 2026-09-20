/**
 * Idempotent migration: embedded Customer/User fcmTokens → DeviceRegistration.
 * Logs counts only (never token values).
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  DevicePrincipalType,
  DeviceRegistrationStatus,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { sha256 } from "../src/lib/crypto.js";
import { Customer, DeviceRegistration, User } from "../src/models/index.js";

async function migrateCollection(Model, principalType) {
  let scanned = 0;
  let upserted = 0;
  let skipped = 0;
  const cursor = Model.find({ "fcmTokens.0": { $exists: true } })
    .select("_id tenantId fcmTokens")
    .cursor();
  for await (const doc of cursor) {
    scanned += 1;
    for (const row of doc.fcmTokens ?? []) {
      if (!row?.tokenSealed || !row.deviceId) {
        skipped += 1;
        continue;
      }
      const tokenHash = row.tokenHash ?? sha256(row.tokenSealed);
      const result = await DeviceRegistration.updateOne(
        {
          tenantId: doc.tenantId,
          principalType,
          principalId: doc._id,
          deviceId: row.deviceId,
        },
        {
          $setOnInsert: {
            _id: createId("dvr"),
            tenantId: doc.tenantId,
            principalType,
            principalId: doc._id,
            deviceId: row.deviceId,
          },
          $set: {
            tokenHash,
            tokenSealed: row.tokenSealed,
            platform: row.platform,
            status: DeviceRegistrationStatus.ACTIVE,
            lastRegisteredAt: row.updatedAt ?? new Date(),
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount) upserted += 1;
    }
  }
  return { scanned, upserted, skipped };
}

await connectDatabase();

const customerStats = await migrateCollection(Customer, DevicePrincipalType.CUSTOMER);
const userStats = await migrateCollection(User, DevicePrincipalType.USER);

console.log(
  JSON.stringify(
    {
      customers: customerStats,
      users: userStats,
      note: "Embedded fcmTokens retained for rollout compatibility; remove in a later cleanup phase.",
    },
    null,
    2,
  ),
);

await disconnectDatabase();
