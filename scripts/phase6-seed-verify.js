/**
 * Phase 6 clean-database seed verification (disposable DB only).
 *
 * Usage: node --env-file=.env scripts/phase6-seed-verify.js [--apply-seed]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { assertPhase6DisposableEnvironment } from "./lib/phase6-disposable-guards.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const applySeed = process.argv.includes("--apply-seed");

function scanSeedSources() {
  const paths = ["scripts/seed-demo.js", "scripts/seed-demo-matrix.js"];
  const forbidden = ["PRORATE", "TRANSFER_TO_SCHEME", "CHEQUE"];
  for (const rel of paths) {
    const text = readFileSync(join(root, rel), "utf8");
    for (const token of forbidden) {
      if (text.includes(token)) {
        throw new Error(`${rel} contains forbidden token ${token}`);
      }
    }
  }
  console.log("Seed source scan: no PRORATE / TRANSFER_TO_SCHEME / CHEQUE literals.");
}

async function verifyDatabaseState() {
  const schemes = await mongoose.connection.db.collection("schemes").countDocuments({});
  console.log(`Schemes in database after seed: ${schemes}`);
  const badRates = await mongoose.connection.db.collection("goldrates").countDocuments({
    purity: { $ne: "22K" },
  });
  if (badRates > 0) {
    throw new Error(`Found ${badRates} non-22K gold rate rows after seed.`);
  }
  console.log("Gold rates: 22K only.");
}

assertPhase6DisposableEnvironment({ mongodbUri: env.MONGODB_URI, nodeEnv: process.env.NODE_ENV });
scanSeedSources();

if (applySeed) {
  const { spawnSync } = await import("node:child_process");
  const seed = spawnSync("node", ["--env-file=.env", "scripts/seed-demo.js"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (seed.status !== 0) process.exit(seed.status ?? 1);
  await connectDatabase();
  try {
    const { spawnSync: spawnSyncIndexes } = await import("node:child_process");
    const idx = spawnSyncIndexes("node", ["--env-file=.env", "scripts/sync-indexes.js", "--apply"], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    if (idx.status !== 0) process.exit(idx.status ?? 1);
    await verifyDatabaseState();
  } finally {
    await disconnectDatabase();
  }
} else {
  console.log("Dry run only (pass --apply-seed to seed + sync indexes + verify).");
}

console.log("phase6-seed-verify: OK");
