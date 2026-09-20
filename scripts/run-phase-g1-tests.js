import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "tests/phase-g1-convergence.test.js",
  "tests/phase-g1-lease-concurrency.test.js",
  "tests/phase-g1-scheduler-registration.test.js",
  "tests/phase-g1-retry-policy.test.js",
  "tests/phase-g1-env.test.js",
  "tests/scheme-lifecycle.test.js",
  "tests/webhook-event.test.js",
  "tests/phase-f-bounded-closure.test.js",
  "tests/env-production-secrets.test.js",
];

const started = Date.now();
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-reporter=spec", ...files.map((f) => path.join(root, f))],
  { cwd: root, env: { ...process.env, NODE_ENV: "test" }, stdio: "inherit" },
);
const durationSec = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nPhase G1 focused tests finished in ${durationSec}s (exit ${result.status ?? 1})`);
process.exitCode = result.status ?? 1;
