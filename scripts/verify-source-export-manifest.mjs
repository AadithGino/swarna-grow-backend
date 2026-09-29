#!/usr/bin/env node
/**
 * Fail-closed check: list ZIP entries and exit 1 if any forbidden path is present.
 * Does not read file contents (secrets/KYC safe).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const zipPath = process.argv[2];
if (!zipPath) {
  console.error("Usage: node scripts/verify-source-export-manifest.mjs <path-to.zip>");
  process.exit(2);
}

const raw = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
const entries = raw.split("\n").map((line) => line.trim()).filter(Boolean);

function normalize(entry) {
  return entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isDenied(entry) {
  const n = normalize(entry);
  if (!n) return false;
  const base = path.posix.basename(n);

  if (base === ".env") return true;
  if (base.startsWith(".env.") && base !== ".env.example") return true;

  const blockedPrefixes = [
    ".git/",
    "node_modules/",
    ".mock-storage/",
    "exports/",
    "runtime-exports/",
    "coverage/",
    "test-results/",
    ".wrangler/",
    ".sites-runtime/",
    ".next/",
    "dist/",
    "uploads/",
  ];
  if (blockedPrefixes.some((p) => n === p.replace(/\/$/, "") || n.startsWith(p))) return true;

  if (/\/kyc_document\//i.test(n)) return true;
  if (/\.(log|sqlite|db)$/i.test(n) && !n.startsWith("docs/")) return true;

  return false;
}

const denied = entries.filter(isDenied);
console.log(`ZIP: ${zipPath}`);
console.log(`entries: ${entries.length}`);
console.log(`denied: ${denied.length}`);
if (denied.length) {
  for (const d of denied.slice(0, 40)) console.log(`  FORBIDDEN: ${d}`);
  if (denied.length > 40) console.log(`  ... and ${denied.length - 40} more`);
  process.exit(1);
}
console.log("manifest: OK");
process.exit(0);
