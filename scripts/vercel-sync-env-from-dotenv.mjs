#!/usr/bin/env node
/**
 * Push non-empty .env entries to the linked Vercel project (production + preview + development).
 * Does not print secret values. Skips comments and multiline values.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const raw = readFileSync(envPath, "utf8");
const entries = [];
for (const line of raw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (value.includes("\n")) continue;
  if (!key) continue;
  entries.push({ key, value });
}

const targets = ["production", "preview", "development"];
let ok = 0;
let fail = 0;
for (const { key, value } of entries) {
  for (const target of targets) {
    const r = spawnSync(
      "vercel",
      ["env", "add", key, target, "--force"],
      { input: value, cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (r.status === 0) ok += 1;
    else fail += 1;
  }
}
console.log(JSON.stringify({ keys: entries.length, envWritesOk: ok, envWritesFailed: fail }));
