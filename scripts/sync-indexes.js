/**
 * Operator-only index rollout. Never run from API startup.
 *
 * Usage:
 *   node --env-file=.env scripts/sync-indexes.js --dry-run
 *   node --env-file=.env scripts/sync-indexes.js --apply
 *   node --env-file=.env scripts/sync-indexes.js --dry-run --apply-drops
 *   node --env-file=.env scripts/sync-indexes.js --apply-drops --operator-confirm-drops --confirm-drop INDEX_NAME ...
 *
 * Drops never run from --apply-drops alone; each index name must be listed with --confirm-drop,
 * and --operator-confirm-drops is required.
 */
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import * as models from "../src/models/index.js";
import { parseSyncIndexArgv, planIndexDrops } from "../src/lib/sync-indexes-cli.js";

const cli = parseSyncIndexArgv();

if (!cli.dryRun && !cli.apply && !cli.applyDrops) {
  console.error("Pass --dry-run and/or --apply (drops require --apply-drops).");
  process.exit(1);
}

function modelEntries() {
  return Object.values(models).filter((model) => model?.schema && model?.createIndexes);
}

await connectDatabase();
try {
  const report = {
    dryRun: cli.dryRun,
    apply: cli.apply,
    applyDrops: cli.applyDrops,
    operatorConfirmDrops: cli.operatorConfirmDrops,
    confirmDropNames: [...cli.confirmDropNames],
    models: [],
  };

  for (const model of modelEntries()) {
    const name = model.modelName ?? model.name ?? "model";
    const diff = await model.diffIndexes();
    const toCreate = diff.toCreate ?? [];
    const toDrop = diff.toDrop ?? [];
    const dropPlan = planIndexDrops({
      toDrop,
      confirmDropNames: cli.confirmDropNames,
      applyDrops: cli.applyDrops,
      operatorConfirmDrops: cli.operatorConfirmDrops,
    });
    report.models.push({
      model: name,
      toCreate,
      toDrop,
      dropPlan,
    });

    if (cli.dryRun) continue;

    if (toCreate.length && cli.apply) {
      await model.createIndexes();
      console.log(`created indexes for ${name}: ${toCreate.length} definition(s)`);
    }

    if (toDrop.length && cli.applyDrops && !cli.operatorConfirmDrops) {
      console.warn(
        `[skip drop] ${name}: ${toDrop.length} index(es) — pass --operator-confirm-drops and --confirm-drop for each name`,
      );
    }

    for (const skipped of dropPlan.skipped) {
      console.warn(`[skip drop] ${name}.${skipped.indexName}: ${skipped.reason}`);
    }

    if (dropPlan.approved.length) {
      const collection = model.collection;
      for (const indexName of dropPlan.approved) {
        await collection.dropIndex(indexName);
        console.log(`dropped index ${indexName} on ${name}`);
      }
    }
  }

  if (cli.dryRun) {
    console.log(JSON.stringify(report, null, 2));
  }
} finally {
  await disconnectDatabase();
  await mongoose.disconnect();
}
