/**
 * Restartable legacy message.send outbox reconciliation (Phase E closure).
 *
 * Usage:
 *   node scripts/reconcile-legacy-message-send-outbox.js [--dry-run] [--after=<outboxId>]
 */
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { reconcileLegacyMessageSendOutboxKeyset } from "../src/lib/legacy-message-send-outbox.js";

const dryRun = process.argv.includes("--dry-run");
const afterArg = process.argv.find((a) => a.startsWith("--after="));
let afterId = afterArg ? afterArg.slice("--after=".length) : null;

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  let totals = { processed: 0, completed: 0, skippedHasMessage: 0, failed: 0, batches: 0 };
  for (;;) {
    const batch = await reconcileLegacyMessageSendOutboxKeyset({
      dryRun,
      afterId,
    });
    totals.processed += batch.processed;
    totals.completed += batch.completed;
    totals.skippedHasMessage += batch.skippedHasMessage;
    totals.failed += batch.failed;
    totals.batches += 1;
    console.log(JSON.stringify({ batch, afterId }));
    if (!batch.hasMore) break;
    afterId = batch.lastId;
  }
  console.log(JSON.stringify({ dryRun, totals }));
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
