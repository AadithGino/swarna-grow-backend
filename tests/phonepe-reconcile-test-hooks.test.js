import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("reconcile test hooks throw when armed outside NODE_ENV=test", () => {
  const script = `
    import assert from "node:assert/strict";
    import {
      armPauseBeforeExhaustionTransition,
      armPauseBeforeReconcileCore,
      armPauseBeforeTerminalFailure,
      armPauseDuringReconcileProgress,
    } from "./src/lib/phonepe-reconcile-test-hooks.js";
    assert.throws(() => armPauseBeforeTerminalFailure(), /NODE_ENV=test/);
    assert.throws(() => armPauseDuringReconcileProgress(), /NODE_ENV=test/);
    assert.throws(() => armPauseBeforeExhaustionTransition(), /NODE_ENV=test/);
    assert.throws(() => armPauseBeforeReconcileCore(), /NODE_ENV=test/);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
