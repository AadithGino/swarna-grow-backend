/**
 * Production-hardening focused test gate (fast CI-friendly subset).
 * Full suite: npm test
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "tests/env-production-secrets.test.js",
  "tests/production-boot-checks.test.js",
  "tests/readiness-config.test.js",
  "tests/health-readiness.test.js",
  "tests/fcm-outcomes.test.js",
  "tests/fcm-config-isolation.test.js",
  "tests/push-provider.test.js",
  "tests/broadcast-fanout.test.js",
  "tests/reminder-config.test.js",
  "tests/reminder-scheduler.test.js",
  "tests/phonepe-provider.test.js",
  "tests/phonepe-order-status.test.js",
  "tests/phonepe-reconcile.test.js",
  "tests/phonepe-gateway-state.test.js",
  "tests/phonepe-failure-injection.test.js",
  "tests/phase-ab-regression.test.js",
  "tests/phonepe-reconcile-lease.test.js",
  "tests/phonepe-reconcile-test-hooks.test.js",
  "tests/phonepe-timeout.test.js",
  "tests/sync-indexes-safety.test.js",
  "tests/webhook-processors-sdk.test.js",
  "tests/webhook-event.test.js",
  "tests/report-limits.test.js",
  "tests/ops-metrics.test.js",
  "tests/phase-d-fcm-redis.test.js",
  "tests/phase-d-delivery-claims.test.js",
  "tests/phase-d-fcm-mongo.test.js",
  "tests/phase-d-processor-concurrency.test.js",
  "tests/phase-d-broadcast-recovery.test.js",
  "tests/phase-d-staging-runner.test.js",
];

const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", ...files.map((f) => path.join(root, f))],
  {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
