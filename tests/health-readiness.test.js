import test from "node:test";
import assert from "node:assert/strict";
import { computeReadiness } from "../src/lib/readiness.js";

test("readiness is lenient without redis in non-production", () => {
  const state = computeReadiness({ dbOk: true, redisOk: false, nodeEnv: "development", redisRequired: false });
  assert.equal(state.ready, true);
});

test("readiness returns not-ready without redis in production", () => {
  const state = computeReadiness({ dbOk: true, redisOk: false, nodeEnv: "production", redisRequired: true });
  assert.equal(state.ready, false);
  assert.equal(state.data.queue, "unavailable");
});

test("readiness returns not-ready when production workers are unavailable", () => {
  const state = computeReadiness({ dbOk: true, redisOk: true, workersOk: false, nodeEnv: "production", redisRequired: true });
  assert.equal(state.ready, false);
  assert.equal(state.data.workers, "unavailable");
});
