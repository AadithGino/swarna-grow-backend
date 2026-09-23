/**
 * Phase 10 consolidated targeted regression (excludes 15k scheduler scan).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "tests/maturity-eligibility.test.js",
  "tests/phase-f-scheduler.test.js",
  "tests/gold-redemption-phase4.test.js",
  "tests/redemption-phase5-corrective.test.js",
  "tests/redemption-phase5-edge-matrix.test.js",
  "tests/phase9-redemption-mode-matrix.integration.test.js",
  "tests/redemption-transaction-rollback.test.js",
  "tests/gateway-refund-initiation-http.test.js",
  "tests/gateway-refund-reservation-recovery-phase7.test.js",
  "tests/gateway-refund-concurrency.test.js",
  "tests/gateway-refund-accounting.test.js",
  "tests/gateway-partial-refund-integration.test.js",
  "tests/gold-accrual-report-phase6.test.js",
  "tests/admin-reports.test.js",
  "tests/customer-app-contract.test.js",
  "tests/customer-kyc-profile-phase6.test.js",
  "tests/financial-percent.test.js",
  "tests/production-hardening-phase9.test.js",
  "tests/gateway-settlement-resolution-http.test.js",
];

const started = Date.now();
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-reporter=spec", ...files.map((f) => path.join(root, f))],
  {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", PHASE_EF_SKIP_15K_REMINDER: "1" },
    stdio: "inherit",
  },
);
const durationSec = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nV1 targeted gate finished in ${durationSec}s (exit ${result.status ?? 1})`);
process.exitCode = result.status ?? 1;
