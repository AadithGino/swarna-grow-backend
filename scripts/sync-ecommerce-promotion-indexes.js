#!/usr/bin/env node
/**
 * Preview or apply MongoDB indexes for ecommerce promotion fanout + dispatch reconciliation.
 *
 * Preview (no DB mutations — uses diffIndexes only):
 *   node --env-file=.env scripts/sync-ecommerce-promotion-indexes.js
 *   node --env-file=.env scripts/sync-ecommerce-promotion-indexes.js --dry-run
 *
 * Apply (mutates indexes via syncIndexes):
 *   node --env-file=.env scripts/sync-ecommerce-promotion-indexes.js --apply
 *
 * Run migrate-push-broadcast-campaign-key-index.js first when upgrading gold-rate uniqueness.
 */
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import {
  applyEcommercePromotionIndexes,
  parseEcommercePromotionIndexArgv,
  previewEcommercePromotionIndexes,
} from "../src/lib/ecommerce-promotion-index-sync.js";
import { EcommercePromotionCampaign, PushBroadcast } from "../src/models/index.js";

const cli = parseEcommercePromotionIndexArgv();
if (cli.error === "CONTRADICTORY_FLAGS") {
  console.error("Pass either --dry-run (preview) or --apply, not both.");
  process.exit(1);
}

const models = [
  { name: "EcommercePromotionCampaign", model: EcommercePromotionCampaign },
  { name: "PushBroadcast", model: PushBroadcast },
];

await mongoose.connect(env.MONGODB_URI, {
  maxPoolSize: 5,
  serverSelectionTimeoutMS: 10_000,
  autoIndex: false,
  autoCreate: false,
});

try {
  if (cli.preview) {
    const report = await previewEcommercePromotionIndexes(models);
    console.log(JSON.stringify({ mode: "preview", models: report }, null, 2));
    console.log("Preview only — re-run with --apply to sync indexes.");
  }
  if (cli.apply) {
    const applied = await applyEcommercePromotionIndexes(models);
    console.log(JSON.stringify({ mode: "apply", models: applied }, null, 2));
  }
} finally {
  await mongoose.disconnect();
}
