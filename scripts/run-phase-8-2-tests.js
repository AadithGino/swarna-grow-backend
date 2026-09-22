import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "scripts/run-phase-8-1-tests.js",
  "tests/gateway-refund-initiation-http.test.js",
  "tests/gateway-poll-status-http.test.js",
  "tests/inbound-messaging-http.test.js",
  "tests/platform-mutation-matrix.test.js",
  "tests/gateway-settlement-resolution-http.test.js",
  "tests/gateway-settlement-ingestion-hardening.test.js",
  "tests/csv-formula-escape.test.js",
];

for (const file of files) {
  const abs = path.join(root, file);
  const args = file.endsWith("run-phase-8-1-tests.js")
    ? [abs]
    : ["--test", "--test-concurrency=1", abs];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
