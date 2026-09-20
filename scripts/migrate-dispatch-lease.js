/**
 * Restartable backfill: legacy enqueuedAt → dispatch lease fields (Phase E).
 * Safe to run multiple times; does not drop indexes.
 *
 * Rollout: run after deploying schema/index sync, before enabling new dispatch workers.
 */
import mongoose from "mongoose";
import { DispatchState, JobStatus, MessageStatus } from "../src/constants/enums.js";
import { env } from "../src/config/env.js";
import { Message, OutboxEvent, WebhookEvent } from "../src/models/index.js";

const BATCH = 500;

async function migrateCollection(model, statusFilter) {
  let total = 0;
  for (;;) {
    const rows = await model
      .find({
        ...statusFilter,
        enqueuedAt: { $exists: true, $ne: null },
        dispatchState: { $exists: false },
      })
      .limit(BATCH)
      .select("_id enqueuedAt")
      .lean();
    if (!rows.length) break;
    const ops = rows.map((row) => ({
      updateOne: {
        filter: { _id: row._id, dispatchState: { $exists: false } },
        update: {
          $set: {
            dispatchState: DispatchState.DISPATCHED,
            dispatchedAt: row.enqueuedAt,
          },
          $unset: { enqueuedAt: "" },
        },
      },
    }));
    const result = await model.bulkWrite(ops, { ordered: false });
    total += result.modifiedCount ?? 0;
    process.stdout.write(`  ${model.modelName}: ${total} migrated\r`);
  }
  return total;
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const counts = {
    messages: await migrateCollection(Message, { status: MessageStatus.QUEUED }),
    outbox: await migrateCollection(OutboxEvent, { status: JobStatus.QUEUED }),
    webhooks: await migrateCollection(WebhookEvent, { status: JobStatus.QUEUED }),
  };
  console.log("\nDispatch lease migration complete:", counts);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
