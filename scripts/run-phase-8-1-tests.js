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
];

const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", ...files.map((f) => path.join(root, f))],
  { cwd: root, env: { ...process.env, NODE_ENV: "test" }, stdio: "inherit" },
);
process.exit(result.status ?? 1);
