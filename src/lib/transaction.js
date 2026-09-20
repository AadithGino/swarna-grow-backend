import mongoose from "mongoose";
import { AppError } from "./app-error.js";

let transactionSessionStartsForTests = 0;

export function resetTransactionTestMetrics() {
  transactionSessionStartsForTests = 0;
}

export function getTransactionSessionStartsForTests() {
  return transactionSessionStartsForTests;
}

const TRANSIENT_TX_LABELS = new Set([
  "TransientTransactionError",
  "UnknownTransactionCommitResult",
]);

/** @internal Exported for unit tests. */
export function isTransientTransactionError(error) {
  if (!error) return false;
  if (error instanceof AppError) return false;
  if (error?.name === "ValidationError") return false;
  if (error.hasErrorLabel?.("TransientTransactionError")) return true;
  if (error.errorLabels?.some?.((label) => TRANSIENT_TX_LABELS.has(label))) return true;
  if (error.codeName === "WriteConflict" || error.code === 112) return true;
  return false;
}

/**
 * Standard MongoDB transaction. Relies on the driver's internal transient retry for commit.
 * Do not perform non-idempotent external I/O inside the callback.
 */
export async function withTransaction(work, options = {}) {
  const session = await mongoose.startSession();
  transactionSessionStartsForTests += 1;
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
      ...options,
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Enrolment-only wrapper: retries the whole transaction on transient write conflicts.
 * Not used globally — avoids duplicating side effects across unrelated services.
 */
export async function withTransientTransactionRetry(work, options = {}) {
  const maxAttempts = options.maxAttempts ?? 5;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTransaction(work, options);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientTransactionError(error)) throw error;
    }
  }
  throw lastError;
}
