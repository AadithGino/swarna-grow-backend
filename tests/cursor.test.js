import test from "node:test";
import assert from "node:assert/strict";
import { createCursor, filterHash, parseCursor } from "../src/lib/cursor.js";

test("cursor filter hash is stable for nested objects", () => {
  assert.equal(filterHash({ b: { y: 2, x: 1 }, a: 1 }), filterHash({ a: 1, b: { x: 1, y: 2 } }));
});

test("cursor cannot be reused with different filters", () => {
  const cursor = createCursor({ lastValue: "2026-09-14", lastId: "one", sort: "createdAt:desc", filters: { status: "ACTIVE" } });
  assert.throws(() => parseCursor(cursor, { sort: "createdAt:desc", filters: { status: "BLOCKED" } }), (error) => error.code === "CURSOR_FILTER_MISMATCH");
});

