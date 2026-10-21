#!/usr/bin/env node
/**
 * Fail-closed check: path denylist + full bounded credential content scan (no secret values logged).
 */
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const zipPath = process.argv[2];
if (!zipPath) {
  console.error("Usage: node scripts/verify-source-export-manifest.mjs <path-to.zip>");
  process.exit(2);
}

const MAX_SCAN_BYTES = 512 * 1024;
const CHUNK_BYTES = 16 * 1024;
const CHUNK_OVERLAP = 256;

const raw = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
const entries = raw.split("\n").map((line) => line.trim()).filter(Boolean);

function normalize(entry) {
  return entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function stripRepoPrefix(entry) {
  const n = normalize(entry);
  const parts = n.split("/");
  if (parts.length > 1 && /^(swarnagrow-backend|SwarnaGrow-Tenant-Admin|swarnagrow-tenant-admin)$/i.test(parts[0])) {
    return parts.slice(1).join("/");
  }
  return n;
}

function isDeniedPath(entry) {
  const n = stripRepoPrefix(entry);
  if (!n) return false;
  const base = path.posix.basename(n);

  if (base === ".env") return { reason: "env file" };
  if (base.startsWith(".env.") && base !== ".env.example") return { reason: "env file" };

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
  if (blockedPrefixes.some((p) => n === p.replace(/\/$/, "") || n.startsWith(p))) {
    return { reason: "blocked prefix" };
  }

  if (/\/kyc_document\//i.test(n)) return { reason: "kyc path" };
  if (/\.(log|sqlite|db)$/i.test(n) && !n.startsWith("docs/")) return { reason: "database/log artifact" };

  const credName =
    /service[-_]?account/i.test(base)
    || /credentials/i.test(base)
    || /\.(pem|p12|pfx|key)$/i.test(base)
    || /^id_rsa/i.test(base);
  if (credName && base !== ".env.example") {
    if (n === "docs/QA_DEMO_CREDENTIALS.md" || n === "docs/DEMO_CREDENTIALS.md") {
      return null;
    }
    return { reason: "credential filename" };
  }

  return null;
}

const CONTENT_SCAN_EXT = new Set([".json", ".pem", ".env", ".p12", ".pfx", ".key", ".js", ".mjs", ".ts", ".tsx"]);
/** Service-account / private-key material only — not bare public Firebase client API keys. */
const CONTENT_PATTERNS = [
  { id: "private_key_field", re: /"private_key"\s*:\s*"-----BEGIN/i },
  { id: "service_account_type", re: /"type"\s*:\s*"service_account"/i },
  { id: "pem_block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
];

function readZipEntryBuffer(entry) {
  const result = spawnSync("unzip", ["-p", zipPath, entry], {
    encoding: "buffer",
    // Read fully so oversize entries fail as unverified, not as spawn maxBuffer overflow.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { ok: false, reason: "content:file_too_large_unverified" };
    }
    return { ok: false, reason: "content:read_error" };
  }
  if (result.status !== 0) {
    return { ok: false, reason: "content:unzip_failed" };
  }
  if (!result.stdout?.length) {
    return { ok: true, buf: Buffer.alloc(0) };
  }
  if (result.stdout.length > MAX_SCAN_BYTES) {
    return { ok: false, reason: "content:file_too_large_unverified" };
  }
  return { ok: true, buf: result.stdout };
}

function isSyntheticCredentialFixturePath(entryPath) {
  const n = stripRepoPrefix(entryPath);
  return /^tests\/.*\.test\.(js|mjs|ts|tsx)$/.test(n);
}

/** Regression tests embed synthetic credential markers; still scan all other paths fail-closed. */
function skipCredentialPatternForTestSource(entryPath, patternId) {
  const n = stripRepoPrefix(entryPath);
  if (n === "tests/export-source-manifest.test.js") return true;
  if (isSyntheticCredentialFixturePath(entryPath) && patternId === "pem_block") return true;
  return false;
}

function scanBufferForCredentials(buf, { entryPath = "" } = {}) {
  if (!buf.length) return null;
  let carry = "";
  for (let offset = 0; offset < buf.length; offset += CHUNK_BYTES) {
    const slice = buf.subarray(offset, Math.min(buf.length, offset + CHUNK_BYTES));
    const window = carry + slice.toString("utf8");
    for (const pattern of CONTENT_PATTERNS) {
      if (skipCredentialPatternForTestSource(entryPath, pattern.id)) continue;
      if (pattern.re.test(window)) return { reason: `content:${pattern.id}` };
    }
    carry = window.slice(-CHUNK_OVERLAP);
  }
  return null;
}

function scanContent(entry) {
  const n = stripRepoPrefix(entry);
  const ext = path.posix.extname(n).toLowerCase();
  if (!CONTENT_SCAN_EXT.has(ext) && !n.includes(".env")) return null;
  if (n.endsWith(".env.example")) return null;
  const read = readZipEntryBuffer(entry);
  if (!read.ok) return { reason: read.reason };
  return scanBufferForCredentials(read.buf, { entryPath: entry });
}

const pathDenied = [];
for (const entry of entries) {
  const hit = isDeniedPath(entry);
  if (hit) pathDenied.push({ entry: normalize(entry), ...hit });
}

const contentDenied = [];
for (const entry of entries) {
  const hit = scanContent(entry);
  if (hit) contentDenied.push({ entry: normalize(entry), ...hit });
}

console.log(`ZIP: ${zipPath}`);
console.log(`entries: ${entries.length}`);
console.log(`denied_paths: ${pathDenied.length}`);
console.log(`denied_content: ${contentDenied.length}`);

const allDenied = [...pathDenied, ...contentDenied];
if (allDenied.length) {
  for (const d of allDenied.slice(0, 40)) {
    console.log(`  FORBIDDEN (${d.reason}): ${d.entry}`);
  }
  if (allDenied.length > 40) console.log(`  ... and ${allDenied.length - 40} more`);
  process.exit(1);
}
console.log("manifest: OK");
process.exit(0);
