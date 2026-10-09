import { AppError } from "./app-error.js";

/** Maximum representable money in paise (fits safe JSON integers). */
export const ECOMMERCE_MAX_PAISE = 9_007_199_254_740_991;

function assertNonNegativeSafeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > ECOMMERCE_MAX_PAISE) {
    throw new AppError(
      "ECOMMERCE_MONEY_BOUNDS",
      `${name} must be a non-negative integer within supported money bounds.`,
      422,
      { field: name, value },
    );
  }
}

/** Half-up division for non-negative integers: round((a × b) / divisor). */
export function mulDivHalfUpPaise(a, b, divisor) {
  assertNonNegativeSafeInteger("amount", a);
  assertNonNegativeSafeInteger("multiplier", b);
  if (!Number.isInteger(divisor) || divisor <= 0) {
    throw new AppError("ECOMMERCE_MONEY_BOUNDS", "Invalid divisor for money calculation.", 422);
  }
  const num = BigInt(a) * BigInt(b);
  const den = BigInt(divisor);
  const rounded = (num + den / 2n) / den;
  const asNumber = Number(rounded);
  if (!Number.isSafeInteger(asNumber) || asNumber > ECOMMERCE_MAX_PAISE) {
    throw new AppError(
      "ECOMMERCE_MONEY_OVERFLOW",
      "Money calculation exceeded supported bounds.",
      422,
    );
  }
  return asNumber;
}

export function addPaise(...parts) {
  let sum = 0n;
  for (const part of parts) {
    assertNonNegativeSafeInteger("amount", part);
    sum += BigInt(part);
  }
  if (sum > BigInt(ECOMMERCE_MAX_PAISE)) {
    throw new AppError(
      "ECOMMERCE_MONEY_OVERFLOW",
      "Money calculation exceeded supported bounds.",
      422,
    );
  }
  return Number(sum);
}
