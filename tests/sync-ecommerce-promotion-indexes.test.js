import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEcommercePromotionIndexes,
  parseEcommercePromotionIndexArgv,
  previewEcommercePromotionIndexes,
} from "../src/lib/ecommerce-promotion-index-sync.js";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/sync-ecommerce-promotion-indexes.js",
);

test("parse rejects contradictory --dry-run and --apply", () => {
  const parsed = parseEcommercePromotionIndexArgv(["--dry-run", "--apply"]);
  assert.equal(parsed.error, "CONTRADICTORY_FLAGS");
});

test("default mode is preview", () => {
  const parsed = parseEcommercePromotionIndexArgv([]);
  assert.equal(parsed.preview, true);
  assert.equal(parsed.apply, false);
});

test("preview uses diffIndexes only", async () => {
  let syncCalled = false;
  let createCalled = false;
  const model = {
    diffIndexes: async () => ({
      toCreate: [{ key: { status: 1 } }],
      toDrop: [{ name: "old_idx" }],
    }),
    syncIndexes: async () => {
      syncCalled = true;
      return [];
    },
    createIndexes: async () => {
      createCalled = true;
    },
  };
  const report = await previewEcommercePromotionIndexes([{ name: "PushBroadcast", model }]);
  assert.equal(report[0].toCreate.length, 1);
  assert.equal(report[0].toDrop.length, 1);
  assert.equal(syncCalled, false);
  assert.equal(createCalled, false);
});

test("--apply path invokes syncIndexes", async () => {
  let syncCalled = false;
  const model = {
    syncIndexes: async () => {
      syncCalled = true;
      return ["status_1"];
    },
  };
  await applyEcommercePromotionIndexes([{ name: "PushBroadcast", model }]);
  assert.equal(syncCalled, true);
});

test("CLI contradictory flags exit before Mongo connect", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--dry-run", "--apply"], {
    encoding: "utf8",
    env: { ...process.env, MONGODB_URI: "mongodb://127.0.0.1:1/none" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not both/i);
});
