import { randomInt } from "node:crypto";

/** One-time credential — 4-digit PIN used across customer, staff, and platform accounts. */
export function generateTemporaryPassword() {
  return String(randomInt(0, 10_000)).padStart(4, "0");
}
