import { createHash, randomInt } from "node:crypto";

export const PICKUP_CODE_TTL_MS = 48 * 60 * 60 * 1000;

export function generatePickupCode() {
  return String(randomInt(100_000, 1_000_000));
}

export function hashPickupCode(code) {
  return createHash("sha256").update(String(code).trim()).digest("hex");
}

export function pickupCodeMatches(storedHash, code) {
  if (!storedHash || !code) return false;
  return hashPickupCode(code) === storedHash;
}
