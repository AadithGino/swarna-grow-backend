import mongoose from "mongoose";

let transactionSessionStartsForTests = 0;

export function resetTransactionTestMetrics() {
  transactionSessionStartsForTests = 0;
}

export function getTransactionSessionStartsForTests() {
  return transactionSessionStartsForTests;
}

export async function withTransaction(work, options = {}) {
  const session = await mongoose.startSession();
  transactionSessionStartsForTests += 1;
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); }, {
      readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", ...options,
    });
    return result;
  } finally { await session.endSession(); }
}
