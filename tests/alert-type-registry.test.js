import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AlertType } from "../src/constants/enums.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawAlertPattern = /type: "([A-Z0-9_]+)"/;

test("every operational Alert upsert type is declared in AlertType", () => {
  const output = execSync(
    "rg -o 'type: AlertType\\.[A-Z0-9_]+|type: \"GATEWAY_[A-Z0-9_]+\"|type: \"WEBHOOK_FAILURE\"|type: \"PAYMENT_REVIEW\"|type: \"FLEX_SETTLEMENT_REQUIRED\"|type: \"FCM_DELIVERY_EXHAUSTED\"|type: \"SYSTEM_ERROR\"|type: \"MISSING_GOLD_RATE\"' src --no-heading",
    { cwd: root, encoding: "utf8" },
  ).trim();
  const lines = output ? output.split("\n") : [];
  const rawStrings = lines
    .filter((line) => line.includes('type: "'))
    .map((line) => line.match(rawAlertPattern)?.[1])
    .filter(Boolean);
  assert.equal(rawStrings.length, 0, `raw alert type strings remain: ${rawStrings.join(", ")}`);
  const used = new Set(
    lines
      .map((line) => line.match(/AlertType\.([A-Z0-9_]+)/)?.[1])
      .filter(Boolean),
  );
  for (const key of used) {
    assert.ok(AlertType[key], `AlertType missing enum member for ${key}`);
  }
});

test("AlertType includes Phase 6.2 gateway alert members", () => {
  const required = [
    "GATEWAY_UNSUPPORTED_CALLBACK",
    "GATEWAY_SETTLEMENT_MISMATCH",
    "GATEWAY_SETTLEMENT_MISSING",
    "GATEWAY_REFUND_PARTIAL",
    "GATEWAY_RECONCILE_EXHAUSTED",
  ];
  for (const key of required) assert.ok(AlertType[key]);
});
