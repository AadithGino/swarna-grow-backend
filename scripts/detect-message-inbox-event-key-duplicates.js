#!/usr/bin/env node
/**
 * Preview duplicate logical inbox keys before applying Message partial unique indexes.
 *
 * Usage:
 *   node --env-file=.env scripts/detect-message-inbox-event-key-duplicates.js --dry-run
 *
 * Apply indexes separately via: npm run db:sync-indexes:dry-run && npm run db:sync-indexes
 * Do not run during active dispatch without coordination.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Message } from "../src/models/index.js";

const dryRun = !process.argv.includes("--apply");

await connectDatabase();
try {
  const byReminder = await Message.collection
    .aggregate([
      { $match: { reminderDedupeKey: { $type: "string" } } },
      { $group: { _id: { tenantId: "$tenantId", key: "$reminderDedupeKey" }, count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 50 },
    ])
    .toArray();

  const byTemplate = await Message.collection
    .aggregate([
      { $match: { "templateParams.inboxEventKey": { $type: "string" } } },
      {
        $group: {
          _id: { tenantId: "$tenantId", key: "$templateParams.inboxEventKey" },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 50 },
    ])
    .toArray();

  console.log(
    JSON.stringify(
      {
        dryRun,
        duplicateReminderDedupeKeyGroups: byReminder.length,
        duplicateInboxEventKeyGroups: byTemplate.length,
        samples: {
          reminderDedupeKey: byReminder.slice(0, 5),
          inboxEventKey: byTemplate.slice(0, 5),
        },
        applyInstructions: [
          "Resolve any duplicate groups manually.",
          "Run: npm run db:sync-indexes:dry-run",
          "Then: npm run db:sync-indexes (creates partial uniques; no auto-drop).",
        ],
      },
      null,
      2,
    ),
  );

  if (byReminder.length || byTemplate.length) {
    process.exit(1);
  }
} finally {
  await disconnectDatabase();
}
