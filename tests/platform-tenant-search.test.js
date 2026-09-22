import test from "node:test";
import assert from "node:assert/strict";
import { containsSearchRegex, boundedSearchQuery } from "../src/lib/query-filters.js";

test("boundedSearchQuery caps length and trims", () => {
  const long = "a".repeat(150);
  assert.equal(boundedSearchQuery(long).length, 100);
  assert.equal(boundedSearchQuery("  foo  "), "foo");
});

test("containsSearchRegex escapes metacharacters and matches literally", () => {
  const re = containsSearchRegex("(a+.*");
  assert.ok(re);
  assert.match("Tenant (a+.* branch", re);
  assert.doesNotMatch("Tenant aaa branch", re);
});

test("containsSearchRegex does not throw on hostile input", () => {
  for (const sample of ["[", "(", ".*", "a+a+", "\\\\", "x".repeat(500)]) {
    assert.doesNotThrow(() => containsSearchRegex(sample));
  }
});
