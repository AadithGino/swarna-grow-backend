import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = [
  "scripts/run-phase-8-3-tests.js",
  "tests/flexible-plan-duration.test.js",
  "tests/phase9-flexible-lifecycle.integration.test.js",
  "tests/fixed-maturity-duration.test.js",
  "tests/flexible-same-month-payments.test.js",
  "tests/flex-cap-audit-parity-phase3.test.js",
  "tests/phase9-notification-dedupe.integration.test.js",
  "tests/customer-notification-dto.test.js",
  "tests/gold-redemption-phase4.test.js",
  "tests/customer-portfolio-valuation.test.js",
  "tests/customer-app-contract.test.js",
];

for (const file of files) {
  const abs = path.join(root, file);
  const args = file.endsWith("run-phase-8-3-tests.js")
    ? [abs]
    : ["--test", "--test-concurrency=1", abs];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (let i = 0; i < 10; i += 1) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/run-phase-8-3-tests.js")], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "pipe",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? result.stdout);
    console.error(`Phase 8.3 settlement regression failed on iteration ${i + 1}`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`Phase 8.3 regression pass ${i + 1}/10\n`);
}
