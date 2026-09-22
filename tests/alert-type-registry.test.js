import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AlertType } from "../src/constants/enums.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every Alert.type write in src uses AlertType enum members", () => {
  const alertWrites = execSync(
    "rg -n \"type: AlertType\\.[A-Z0-9_]+|type: \\\"[A-Z0-9_]+\\\"\" src --glob \"*.js\"",
    { cwd: root, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
  const operational = alertWrites.filter(
    (line) => line.includes("AlertType.")
      || (line.includes('type: "') && line.match(/GATEWAY_|WEBHOOK_|PAYMENT_REVIEW|FLEX_|FCM_|SYSTEM_ERROR|MISSING_GOLD/)),
  );
  const raw = operational
    .filter((line) => !line.includes("AlertType."))
    .map((line) => line.match(/type: "([A-Z0-9_]+)"/)?.[1])
    .filter(Boolean);
  assert.equal(raw.length, 0, `raw operational alert strings: ${raw.join(", ")}`);
  for (const line of operational.filter((l) => l.includes("AlertType."))) {
    const key = line.match(/AlertType\.([A-Z0-9_]+)/)?.[1];
    assert.ok(key && AlertType[key], `missing AlertType member for ${key}`);
  }
});

test("operational alert upserts use runValidators", () => {
  const helper = readFileSync(join(root, "src/lib/operational-alert.js"), "utf8");
  assert.match(helper, /runValidators:\s*true/);
});

test("AlertType includes Phase 6.2 gateway alert members", () => {
  for (const key of [
    "GATEWAY_UNSUPPORTED_CALLBACK",
    "GATEWAY_SETTLEMENT_MISMATCH",
    "GATEWAY_SETTLEMENT_MISSING",
    "GATEWAY_REFUND_PARTIAL",
    "GATEWAY_RECONCILE_EXHAUSTED",
  ]) {
    assert.ok(AlertType[key]);
  }
});
