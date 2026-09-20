import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "tests/phase-f-bounded-closure.test.js",
  "tests/phase-f-timezone.test.js",
  "tests/phase-f-index-explain.test.js",
  "tests/reminder-scheduler.test.js",
  "tests/webhook-event.test.js",
];

const started = Date.now();
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-reporter=spec", ...files.map((f) => path.join(root, f))],
  { cwd: root, env: { ...process.env, NODE_ENV: "test" }, stdio: "inherit" },
);
const durationSec = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nPhase F corrective tests finished in ${durationSec}s (exit ${result.status ?? 1})`);
process.exitCode = result.status ?? 1;
