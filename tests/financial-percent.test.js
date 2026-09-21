import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/lib/app-error.js";
import { percentOfPaiseFloor } from "../src/lib/money.js";

test("percentOfPaiseFloor: ₹1 principal with fractional result rounds down", () => {
  assert.equal(percentOfPaiseFloor(1, 33), 0);
  assert.equal(percentOfPaiseFloor(1, 100), 1);
});

test("percentOfPaiseFloor: 0% and 100% boundaries", () => {
  assert.equal(percentOfPaiseFloor(999_999, 0), 0);
  assert.equal(percentOfPaiseFloor(999_999, 100), 999_999);
});

test("percentOfPaiseFloor: non-integer percentage result uses floor", () => {
  assert.equal(percentOfPaiseFloor(10_001, 10), 1000);
  assert.equal(percentOfPaiseFloor(10_001, 10), Math.floor(10_001 * 10 / 100));
});

test("percentOfPaiseFloor: maximum supported principal at 100%", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(percentOfPaiseFloor(max, 100), max);
});

test("percentOfPaiseFloor: rejects out-of-range percent", () => {
  assert.throws(
    () => percentOfPaiseFloor(100, -1),
    (error) => error instanceof AppError && error.code === "INVALID_PERCENT",
  );
  assert.throws(
    () => percentOfPaiseFloor(100, 101),
    (error) => error instanceof AppError && error.code === "INVALID_PERCENT",
  );
});

test("percentOfPaiseFloor: rejects malformed percent", () => {
  assert.throws(
    () => percentOfPaiseFloor(100, NaN),
    (error) => error instanceof AppError && error.code === "INVALID_PERCENT",
  );
});

test("percentOfPaiseFloor: rejects non-safe-integer base", () => {
  assert.throws(() => percentOfPaiseFloor(1.5, 10), TypeError);
});
