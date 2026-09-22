import test from "node:test";
import assert from "node:assert/strict";
import { escapeCsvCell } from "../src/lib/csv-formula-escape.js";

test("escapeCsvCell prefixes formula metacharacters", () => {
  assert.equal(escapeCsvCell("=1+1"), "'=1+1");
  assert.equal(escapeCsvCell("-amount"), "'-amount");
  assert.equal(escapeCsvCell("@sum"), "'@sum");
  assert.equal(escapeCsvCell("normal"), "normal");
});
