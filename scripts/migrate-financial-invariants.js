import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { inspectFinancialIndexes, applyFinancialIndexRollout } from "../src/lib/financial-index-rollout.js";
import { DigitalMetalReservation } from "../src/models/index.js";
import { reservationAccountingIsAmbiguous } from "../src/services/digital-metals-ledger.service.js";

// Connect independently: application startup intentionally rejects the pre-migration schema.
const apply = process.argv.includes("--apply");
if (apply && !process.argv.includes("--writes-paused")) {
  throw new Error("--apply requires --writes-paused after stopping API and worker writers.");
}
await mongoose.connect(env.MONGODB_URI, { autoIndex: false });
try {
  let report = await inspectFinancialIndexes();
  const ambiguousReservations = await DigitalMetalReservation.find({
    status: { $in: ["ACTIVE", "COMMITTED", "RELEASED"] },
    lotAccountingMode: null,
  }).limit(100).lean();
  const ambiguous = ambiguousReservations.filter(reservationAccountingIsAmbiguous);
  if (apply && ambiguous.length) throw new Error("Review and classify unmarked reservation accounting before financial rollout.");
  if (apply) report = await applyFinancialIndexRollout({ writesPaused: true });
  console.log(JSON.stringify({ applied: apply, report, ambiguousReservationCount: ambiguous.length, ambiguousReservationSample: ambiguous.slice(0, 10).map((r) => r._id) }, null, 2));
  if (report.some(row => row.duplicates.length)) process.exitCode = 1;
  if (ambiguous.length) process.exitCode = process.exitCode || 2;
} finally { await mongoose.disconnect(); }
