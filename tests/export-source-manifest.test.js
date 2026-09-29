import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(root, "scripts/verify-source-export-manifest.mjs");

test("export manifest rejects forbidden paths", () => {
  const zipPath = path.join(root, ".tmp-export-manifest-test.zip");
  fs.writeFileSync(path.join(root, ".tmp-forbidden.txt"), "x");
  try {
    execFileSync("zip", ["-q", zipPath, ".tmp-forbidden.txt", ".env"], { cwd: root });
    assert.throws(
      () => execFileSync(process.execPath, [verifier, zipPath], { encoding: "utf8" }),
      (err) => err.status === 1,
    );
  } finally {
    fs.unlinkSync(path.join(root, ".tmp-forbidden.txt"));
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  }
});
