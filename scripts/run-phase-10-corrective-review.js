#!/usr/bin/env node
/**
 * Phase 10 gate: run corrective-pass targeted suites (Phases 1–9) once before full npm test.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = [
  "tests/branch-mutation-isolation.test.js",
  "tests/maturity-eligibility.test.js",
  "tests/payment-net-reporting.test.js",
  "tests/customer-financial-totals.test.js",
  "tests/export-branch-scope.test.js",
  "tests/customer-kyc-profile-phase6.test.js",
  "tests/gateway-refund-reservation-recovery-phase7.test.js",
  "tests/admin-mutation-dto-phase8.test.js",
  "tests/production-hardening-phase9.test.js",
  "tests/financial-percent.test.js",
  "tests/phase-10-corrective-gate.test.js",
];

let passed = 0;
for (const file of files) {
  const abs = path.join(root, file);
  process.stdout.write(`\n=== ${file} ===\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", abs], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(`\n[Phase 10 review] FAILED: ${file}\n`);
    process.exit(result.status ?? 1);
  }
  passed += 1;
}

process.stdout.write(`\n[Phase 10 review] ${passed}/${files.length} suites passed.\n`);
