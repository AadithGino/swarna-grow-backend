import test from "node:test";
import assert from "node:assert/strict";
import { mockStorageRouteEnabled } from "../src/routes/mock-storage.routes.js";

test("mock storage route is disabled in production even when provider mode is mock", () => {
  assert.equal(mockStorageRouteEnabled({ providerMode: "mock", nodeEnv: "production" }), false);
});

test("mock storage route stays enabled for local mock mode", () => {
  assert.equal(mockStorageRouteEnabled({ providerMode: "mock", nodeEnv: "development" }), true);
});
