import test from "node:test";
import assert from "node:assert/strict";
import {
  PushOutcomeKind,
  classifyFcmHttpFailure,
  retryDelayMs,
} from "../src/lib/fcm-outcomes.js";

test("UNREGISTERED detail classifies as permanent invalid token", () => {
  const kind = classifyFcmHttpFailure(404, {
    error: {
      status: "NOT_FOUND",
      details: [{ errorCode: "UNREGISTERED" }],
    },
  });
  assert.equal(kind, PushOutcomeKind.PERMANENT_INVALID_TOKEN);
});

test("INVALID_ARGUMENT is payload error not token invalidation", () => {
  const kind = classifyFcmHttpFailure(400, {
    error: { status: "INVALID_ARGUMENT", details: [{ errorCode: "INVALID_ARGUMENT" }] },
  });
  assert.equal(kind, PushOutcomeKind.PERMANENT_PAYLOAD_ERROR);
});

test("429 and 503 classify as transient", () => {
  assert.equal(classifyFcmHttpFailure(429, {}), PushOutcomeKind.TRANSIENT);
  assert.equal(classifyFcmHttpFailure(503, {}), PushOutcomeKind.TRANSIENT);
});

test("retryDelayMs respects retry-after override", () => {
  assert.equal(retryDelayMs(1, 500, 2000), 2000);
});
