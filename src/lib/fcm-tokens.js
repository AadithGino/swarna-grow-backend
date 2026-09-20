import { seal, sha256, unseal } from "./crypto.js";

export function fcmTokenRecordFromPlain({ fcmToken, deviceId, platform }) {
  return {
    tokenHash: sha256(fcmToken),
    tokenSealed: seal(fcmToken),
    deviceId,
    platform,
    updatedAt: new Date(),
  };
}

export function decryptFcmTokens(fcmTokens = []) {
  const out = [];
  for (const row of fcmTokens) {
    if (!row?.tokenSealed) continue;
    try {
      const token = unseal(row.tokenSealed);
      if (token) out.push({ ...row, token });
    } catch {
      // skip corrupt token rows
    }
  }
  return out;
}
