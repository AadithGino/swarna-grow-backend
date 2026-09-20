import test from "node:test";
import assert from "node:assert/strict";
import { parseSyncIndexArgv, planIndexDrops } from "../src/lib/sync-indexes-cli.js";

test("apply-drops alone cannot approve any index drops", () => {
  const cli = parseSyncIndexArgv(["--apply-drops"]);
  const plan = planIndexDrops({
    toDrop: ["legacy_idx"],
    confirmDropNames: cli.confirmDropNames,
    applyDrops: cli.applyDrops,
    operatorConfirmDrops: cli.operatorConfirmDrops,
  });
  assert.deepEqual(plan.approved, []);
  assert.equal(plan.skipped[0]?.reason, "OPERATOR_CONFIRM_DROPS_REQUIRED");
});

test("confirm-drop without operator flag skips drops", () => {
  const cli = parseSyncIndexArgv(["--apply-drops", "--confirm-drop", "legacy_idx"]);
  const plan = planIndexDrops({
    toDrop: ["legacy_idx"],
    confirmDropNames: cli.confirmDropNames,
    applyDrops: cli.applyDrops,
    operatorConfirmDrops: cli.operatorConfirmDrops,
  });
  assert.deepEqual(plan.approved, []);
});

test("only explicitly confirmed names are droppable", () => {
  const cli = parseSyncIndexArgv([
    "--apply-drops",
    "--operator-confirm-drops",
    "--confirm-drop",
    "legacy_idx",
  ]);
  const plan = planIndexDrops({
    toDrop: ["legacy_idx", "other_idx"],
    confirmDropNames: cli.confirmDropNames,
    applyDrops: cli.applyDrops,
    operatorConfirmDrops: cli.operatorConfirmDrops,
  });
  assert.deepEqual(plan.approved, ["legacy_idx"]);
  assert.equal(plan.skipped.length, 1);
});
