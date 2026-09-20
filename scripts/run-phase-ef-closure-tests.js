import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "tests/phase-e-dispatch.test.js",
  "tests/phase-e-dispatch-fairness.test.js",
  "tests/phase-e-dispatch-crash.test.js",
  "tests/phase-e-legacy-outbox.test.js",
  "tests/phase-f-scheduler.test.js",
  "tests/phase-f-timezone.test.js",
  "tests/phase-f-index-explain.test.js",
  "tests/phase-f-queue-readiness.test.js",
  "tests/reminder-scheduler.test.js",
  "tests/reminder-config.test.js",
];

const started = Date.now();
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-reporter=spec", ...files.map((f) => path.join(root, f))],
  {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "inherit",
  },
);
const durationSec = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nPhase E/F closure bundle finished in ${durationSec}s (exit ${result.status ?? 1})`);
process.exitCode = result.status ?? 1;
