#!/usr/bin/env node
/**
 * Build a source-only release ZIP from an allowlisted tree (tracked + allowed untracked).
 * Excludes local secrets, mock storage, exports, and build artifacts by construction.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const ROOT_ALLOW_FILES = new Set([
  "package.json",
  "package-lock.json",
  "eslint.config.js",
  ".gitignore",
  ".env.example",
  "README.md",
  "Dockerfile",
  "docker-compose.yml",
]);

const ROOT_ALLOW_PREFIXES = ["src/", "scripts/", "tests/", "docs/"];

function gitLines(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function allowedRelative(rel) {
  const n = rel.replace(/\\/g, "/");
  if (ROOT_ALLOW_FILES.has(n)) return true;
  return ROOT_ALLOW_PREFIXES.some((p) => n.startsWith(p));
}

function collectFiles() {
  const tracked = gitLines(["ls-files"]);
  const untracked = gitLines(["ls-files", "-o", "--exclude-standard"]);
  const all = new Set([...tracked, ...untracked]);
  return [...all].filter(allowedRelative).sort();
}

const outArg = process.argv.find((a) => a.startsWith("--out="));
const defaultName = `swarnagrow-backend-source-${new Date().toISOString().slice(0, 10)}.zip`;
const outZip = outArg
  ? path.resolve(outArg.slice("--out=".length))
  : path.join(repoRoot, "..", defaultName);

const files = collectFiles();
if (!files.length) {
  console.error("No files matched export allowlist.");
  process.exit(1);
}

if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

const listFile = path.join(repoRoot, ".export-filelist.txt");
fs.writeFileSync(listFile, `${files.join("\n")}\n`);
try {
  execFileSync("zip", ["-q", "-X", outZip, "-@"], {
    cwd: repoRoot,
    input: fs.readFileSync(listFile),
    stdio: ["pipe", "inherit", "inherit"],
  });
} finally {
  fs.unlinkSync(listFile);
}

console.log(`Wrote ${outZip} (${files.length} files)`);
execFileSync(process.execPath, [path.join(__dirname, "verify-source-export-manifest.mjs"), outZip], {
  stdio: "inherit",
});
