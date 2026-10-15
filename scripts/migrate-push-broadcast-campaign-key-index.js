#!/usr/bin/env node
/**
 * Idempotent upgrade for PushBroadcast (tenantId, campaignBusinessKey) partial unique index
 * when sourceKind filter expands to include GOLD_RATE_NOTIFICATION.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-push-broadcast-campaign-key-index.js --dry-run
 *   node --env-file=.env scripts/migrate-push-broadcast-campaign-key-index.js --apply
 *
 * Do not run during active broadcast writes without coordination.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { PushBroadcast } from "../src/models/index.js";

const LEGACY_INDEX = "tenantId_1_campaignBusinessKey_1";
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || !args.has("--apply");

await connectDatabase();
try {
  const collection = PushBroadcast.collection;
  const indexes = await collection.indexes();
  const legacy = indexes.find((idx) => idx.name === LEGACY_INDEX);
  const duplicates = await collection
    .aggregate([
      {
        $match: {
          campaignBusinessKey: { $type: "string" },
          sourceKind: { $in: ["ECOMMERCE_PROMOTION", "GOLD_RATE_NOTIFICATION"] },
        },
      },
      {
        $group: {
          _id: { tenantId: "$tenantId", campaignBusinessKey: "$campaignBusinessKey" },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  console.log(JSON.stringify({ dryRun, legacyIndex: legacy ?? null, duplicateGroups: duplicates.length }, null, 2));
  if (duplicates.length) {
    console.error("Conflicting duplicate (tenantId, campaignBusinessKey) groups exist. Resolve manually before apply.");
    process.exit(1);
  }

  if (dryRun) {
    console.log("Dry run complete. Pass --apply to drop legacy index (if present) and createIndexes on PushBroadcast.");
    process.exit(0);
  }

  if (legacy?.partialFilterExpression?.sourceKind === "ECOMMERCE_PROMOTION") {
    await collection.dropIndex(LEGACY_INDEX);
    console.log(`Dropped legacy index ${LEGACY_INDEX}`);
  }

  await PushBroadcast.createIndexes();
  console.log("PushBroadcast indexes synced.");
} finally {
  await disconnectDatabase();
}
