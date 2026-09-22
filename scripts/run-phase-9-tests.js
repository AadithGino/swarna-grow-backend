import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Phase 9 verification: one subprocess per file, sequential, no nested phase runners or repeat loops.
 * Order preserves former Phase 8.1 → 8.2 → 8.3 → Phase 9 coverage; each path appears once.
 */
const phase9Files = [
  // Phase 8.1
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
  // Phase 8.2
  "tests/gateway-refund-concurrency.test.js",
  "tests/gateway-refund-initiation-http.test.js",
  "tests/gateway-poll-status-http.test.js",
  "tests/inbound-messaging-http.test.js",
  "tests/platform-mutation-matrix.test.js",
  "tests/gateway-settlement-resolution-http.test.js",
  "tests/gateway-settlement-ingestion-hardening.test.js",
  "tests/csv-formula-escape.test.js",
  // Phase 8.3
  "tests/gateway-refund-accounting-recovery.test.js",
  "tests/gateway-refund-reserved-lifecycle.test.js",
  "tests/platform-mutation-valid-acceptance.test.js",
  // Phase 9
  "tests/flexible-plan-duration.test.js",
  "tests/phase9-flexible-lifecycle.integration.test.js",
  "tests/phase9-flexible-12-11.integration.test.js",
  "tests/fixed-maturity-duration.test.js",
  "tests/flexible-same-month-payments.test.js",
  "tests/flex-cap-audit-parity-phase3.test.js",
  "tests/phase9-notification-dedupe.integration.test.js",
  "tests/phase9-notification-dedupe-matrix.test.js",
  "tests/customer-notification-dto.test.js",
  "tests/phase9-redemption-mode-matrix.integration.test.js",
  "tests/gold-redemption-phase4.test.js",
  "tests/phase9-portfolio-parity.integration.test.js",
  "tests/customer-app-contract.test.js",
];

function runTestFile(relativePath) {
  const abs = path.join(root, relativePath);
  process.stdout.write(`\n=== ${relativePath} ===\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", abs], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(`\n[Phase 9 runner] FAILED: ${relativePath}\n`);
    process.exit(result.status ?? 1);
  }
}

for (const file of phase9Files) {
  runTestFile(file);
}

process.stdout.write("\nPhase 9 runner completed.\n");
