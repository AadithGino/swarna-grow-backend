#!/usr/bin/env node
/**
 * Content manifest for remediation source pair (tracked + relevant untracked, no secrets).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repos = [
  {
    name: "swarnagrow-backend",
    root: path.resolve(here, ".."),
  },
  {
    name: "SwarnaGrow-Tenant-Admin",
    root: path.resolve(here, "../../SwarnaGrow-Tenant-Admin"),
  },
];

const DENY = [
  /^\.env$/,
  /^\.env\.(?!example$)/,
  /^node_modules\//,
  /^graphify-out\//,
  /^evidence\/remediation\/logs\//,
  /^evidence\/remediation\/releases\//,
  /^uploads\//,
  /^dist\//,
  /^\.next\//,
  /^\.wrangler\//,
];

function listFiles(repoRoot) {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((rel) => !DENY.some((re) => re.test(rel)));
}

function sha256File(abs) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(abs));
  return hash.digest("hex");
}

const phaseArg = process.argv[2]?.trim();
const manifest = {
  recordedAt: new Date().toISOString(),
  phase: phaseArg || "review-a",
  repositories: {},
};

for (const repo of repos) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.root, encoding: "utf8" }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: repo.root, encoding: "utf8" }).trim();
  const files = listFiles(repo.root).sort();
  const entries = files.map((rel) => {
    const abs = path.join(repo.root, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return null;
    return { path: rel, sha256: sha256File(abs), bytes: fs.statSync(abs).size };
  }).filter(Boolean);
  const aggregate = createHash("sha256");
  for (const entry of entries) aggregate.update(`${entry.path}\0${entry.sha256}\n`);
  manifest.repositories[repo.name] = {
    head,
    branch,
    fileCount: entries.length,
    contentHash: aggregate.digest("hex"),
    files: entries,
  };
}

const outPath = path.join(repos[0].root, "evidence/remediation/source-content-manifest.json");
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${outPath}\n${JSON.stringify(manifest.repositories, null, 2)}\n`);
