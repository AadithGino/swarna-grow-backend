import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = [
  "tests/alert-type-registry.test.js",
  "tests/phonepe-unsupported-callback.test.js",
  "tests/platform-tenant-search.test.js",
  "tests/platform-route-validation.test.js",
  "tests/gateway-refund-accounting.test.js",
  "tests/gateway-partial-refund-integration.test.js",
  "tests/gateway-settlement-control.test.js",
  "tests/customer-portfolio-valuation.test.js",
  "tests/phonepe-gateway-state.test.js",
  "tests/phonepe-failure-injection.test.js",
  "tests/webhook-processors-sdk.test.js",
  "tests/gateway-refund-concurrency.test.js",
  "tests/gateway-refund-initiation-http.test.js",
  "tests/gateway-poll-status-http.test.js",
  "tests/inbound-messaging-http.test.js",
  "tests/platform-mutation-matrix.test.js",
  "tests/gateway-settlement-resolution-http.test.js",
  "tests/gateway-settlement-ingestion-hardening.test.js",
  "tests/csv-formula-escape.test.js",
  "tests/gateway-refund-accounting-recovery.test.js",
  "tests/gateway-refund-reserved-lifecycle.test.js",
  "tests/platform-mutation-valid-acceptance.test.js",
];

for (const file of files) {
  const abs = path.join(root, file);
  process.stdout.write(`\n=== ${file} ===\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", abs], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(`\n[Phase 8.3 runner] FAILED: ${file}\n`);
    process.exit(result.status ?? 1);
  }
}
