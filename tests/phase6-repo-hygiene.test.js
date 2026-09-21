import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("repository gitignore excludes fix.md from release artifacts", () => {
  const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /^fix\.md$/m);
});

test("no focused test.only / describe.only in tracked tests", () => {
  const output = execSync(
    "git grep -E '(^|[^a-zA-Z])(test|it|describe)\\.only\\(' -- 'tests' ':(exclude)fix.md' || true",
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(output, "");
});

test("fix.md is not tracked by git", () => {
  const tracked = execSync("git ls-files fix.md", { cwd: root, encoding: "utf8" }).trim();
  assert.equal(tracked, "");
});
