#!/usr/bin/env node
/**
 * Re-queue ecommerce outbox rows that were dead-lettered before handlers existed.
 *
 * Usage:
 *   node --env-file=.env scripts/reconcile-ecommerce-outbox-dead-letter.js --dry-run
 *   node --env-file=.env scripts/reconcile-ecommerce-outbox-dead-letter.js --apply --tenant-id tnt_xxx
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { JobStatus } from "../src/constants/enums.js";
import { OutboxEvent } from "../src/models/index.js";
import { isEcommerceOutboxTopic } from "../src/lib/ecommerce-outbox-processor.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || !args.has("--apply");
const tenantId = process.argv.includes("--tenant-id")
  ? process.argv[process.argv.indexOf("--tenant-id") + 1]
  : null;

await connectDatabase();
try {
  const filter = {
    status: JobStatus.DEAD_LETTER,
    topic: { $regex: /^ecommerce\./ },
    error: { $regex: /^Unhandled outbox topic: ecommerce\./ },
  };
  if (tenantId) filter.tenantId = tenantId;
  const rows = await OutboxEvent.find(filter).lean();
  const valid = rows.filter((row) => isEcommerceOutboxTopic(row.topic));
  console.log(`Found ${valid.length} ecommerce dead-letter row(s) eligible for replay.`);
  for (const row of valid) {
    console.log(`${dryRun ? "[dry-run]" : "[apply]"} ${row._id} ${row.topic} key=${row.key}`);
    if (!dryRun) {
      await OutboxEvent.updateOne(
        { _id: row._id, status: JobStatus.DEAD_LETTER },
        {
          $set: {
            status: JobStatus.QUEUED,
            availableAt: new Date(),
            error: "ECOMMERCE_OUTBOX_REPLAY",
          },
        },
      );
    }
  }
} finally {
  await disconnectDatabase();
}
