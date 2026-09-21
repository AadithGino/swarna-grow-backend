import test from "node:test";
import assert from "node:assert/strict";
import {
  armPauseBeforeFixedSchemeCommit,
  clearFixedPaymentTestHooks,
  fixedPaymentTestHookBeforeFixedSchemeCommit,
} from "../src/lib/fixed-payment-test-hooks.js";

test.afterEach(() => {
  clearFixedPaymentTestHooks();
});

test("arming fixed payment hooks throws outside NODE_ENV=test", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      () => armPauseBeforeFixedSchemeCommit(),
      /NODE_ENV=test/,
    );
  } finally {
    process.env.NODE_ENV = previous;
    clearFixedPaymentTestHooks();
  }
});

test("clearFixedPaymentTestHooks releases an armed barrier", async () => {
  const pause = armPauseBeforeFixedSchemeCommit();
  const entered = pause.waitUntilPaused();
  const waiting = fixedPaymentTestHookBeforeFixedSchemeCommit();
  await entered;
  clearFixedPaymentTestHooks();
  await waiting;
});
