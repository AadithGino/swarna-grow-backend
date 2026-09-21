/**
 * Phase 6 disposable-database verification: seed, indexes, smoke flow.
 *
 * Usage:
 *   MONGODB_URI=mongodb://127.0.0.1:27017/swarnagrow_phase6_verify_20260921 \
 *   NODE_ENV=development \
 *   node --env-file=.env scripts/phase6-disposable-verify.js
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { assertPhase6DisposableEnvironment } from "./lib/phase6-disposable-guards.js";
import { runPhase6SmokeFlow } from "./phase6-smoke-flow.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function scanSeedSources() {
  for (const rel of ["scripts/seed-demo.js", "scripts/seed-demo-matrix.js"]) {
    const text = readFileSync(join(root, rel), "utf8");
    for (const token of ["PRORATE", "TRANSFER_TO_SCHEME", "CHEQUE"]) {
      if (text.includes(token)) throw new Error(`${rel} contains forbidden token ${token}`);
    }
  }
  console.log("Seed source scan: no PRORATE / TRANSFER_TO_SCHEME / CHEQUE.");
}

function runNodeScript(args, label) {
  console.log(`\n--- ${label} ---`);
  const result = spawnSync("node", args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    console.error(`${label} failed with exit ${result.status ?? 1}`);
    process.exit(result.status ?? 1);
  }
}

const disposable = assertPhase6DisposableEnvironment({ mongodbUri: env.MONGODB_URI, nodeEnv: process.env.NODE_ENV });
scanSeedSources();

await connectDatabase();
try {
  console.log(`\n--- Reset disposable database ${disposable.dbName} ---`);
  await mongoose.connection.dropDatabase();
} finally {
  await disconnectDatabase();
}

runNodeScript(["--env-file=.env", "scripts/seed-demo.js"], "Demo seed");

runNodeScript(["--env-file=.env", "scripts/sync-indexes.js", "--dry-run"], "Index sync dry-run");
runNodeScript(["--env-file=.env", "scripts/sync-indexes.js", "--apply"], "Index sync apply");

console.log("\n--- Phase 6 smoke flow (run 1) ---");
await runPhase6SmokeFlow();

console.log("\n--- Phase 6 smoke flow (run 2 — repeatability) ---");
await runPhase6SmokeFlow();

console.log("\nphase6-disposable-verify: OK (seed once, smoke twice)");
