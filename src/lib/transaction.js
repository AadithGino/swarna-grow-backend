import mongoose from "mongoose";

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

function isTransientTransactionError(error) {
  if (!error) return false;
  if (error.hasErrorLabel?.("TransientTransactionError")) return true;
  if (TRANSIENT_TX_LABELS.has(error.errorLabels?.[0])) return true;
  if (error.codeName === "WriteConflict" || error.code === 112) return true;
  return false;
}

export async function withTransaction(work, options = {}) {
  const maxAttempts = options.maxAttempts ?? 5;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientTransactionError(error)) throw error;
    } finally {
      await session.endSession();
    }
  }
  throw lastError;
}
