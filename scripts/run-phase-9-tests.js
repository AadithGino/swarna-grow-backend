import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const phase9Files = [
  "scripts/run-phase-8-3-tests.js",
  "tests/gateway-settlement-resolution-http.test.js",
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
  "tests/customer-portfolio-valuation.test.js",
  "tests/customer-app-contract.test.js",
];

function runNode(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(`\n[Phase 9 runner] FAILED: ${label}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

for (let iteration = 1; iteration <= 5; iteration += 1) {
  process.stdout.write(`\n=== Phase 9 runner iteration ${iteration}/5 ===\n`);
  for (const file of phase9Files) {
    const abs = path.join(root, file);
    const label = `${iteration}:${file}`;
    if (file.endsWith("run-phase-8-3-tests.js")) {
      runNode(label, [abs]);
    } else {
      runNode(label, ["--test", "--test-concurrency=1", abs]);
    }
  }
  for (let i = 1; i <= 10; i += 1) {
    runNode(`${iteration}:phase-8-3-regression-${i}/10`, [path.join(root, "scripts/run-phase-8-3-tests.js")]);
    process.stdout.write(`Phase 8.3 regression pass ${i}/10 (iteration ${iteration})\n`);
  }
}

process.stdout.write("\nPhase 9 runner completed 5/5 iterations.\n");
