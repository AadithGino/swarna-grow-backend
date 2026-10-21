import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(root, "scripts/verify-source-export-manifest.mjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "export-manifest-"));
}

function zipAt(dir, zipName, members) {
  const zipPath = path.join(dir, zipName);
  const cwd = dir;
  const args = ["-q", zipPath];
  for (const [rel, content] of members) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    args.push(rel);
  }
  execFileSync("zip", args, { cwd });
  return zipPath;
}

function runVerifier(zipPath) {
  try {
    execFileSync(process.execPath, [verifier, zipPath], { encoding: "utf8" });
    return { exit: 0, out: "" };
  } catch (e) {
    return { exit: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

test("export manifest rejects .env at archive root", () => {
  const dir = tmpDir();
  try {
    const zip = zipAt(dir, "t.zip", [[".env", "SECRET=x\n"]]);
    assert.equal(runVerifier(zip).exit, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export manifest rejects service-account JSON in nested repo folder", () => {
  const dir = tmpDir();
  try {
    const cred = JSON.stringify({
      type: "service_account",
      private_key: "-----BEGIN PRIVATE KEY-----\nline\n-----END PRIVATE KEY-----\n",
    });
    const zip = zipAt(dir, "t.zip", [["swarnagrow-backend/config/app-secrets.json", cred]]);
    const r = runVerifier(zip);
    assert.equal(r.exit, 1);
    assert.match(r.out, /content:service_account_type|content:private_key_field/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export manifest detects credential marker beyond 8KB via chunked scan", () => {
  const dir = tmpDir();
  try {
    const pad = "x".repeat(9000);
    const cred = `${pad}\n"type": "service_account"\n`;
    const zip = zipAt(dir, "t.zip", [["notes.json", cred]]);
    assert.equal(runVerifier(zip).exit, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export manifest rejects file larger than scan limit", () => {
  const dir = tmpDir();
  try {
    const big = "a".repeat(600 * 1024);
    const zip = zipAt(dir, "t.zip", [["large-config.json", big]]);
    const r = runVerifier(zip);
    assert.equal(r.exit, 1);
    assert.match(r.out, /file_too_large_unverified/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export manifest allows .env.example", () => {
  const dir = tmpDir();
  try {
    const zip = zipAt(dir, "t.zip", [[".env.example", "PORT=3000\n"]]);
    assert.equal(runVerifier(zip).exit, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export manifest rejects synthetic app-config service account in tests/fixtures path", () => {
  const dir = tmpDir();
  try {
    const fixture = JSON.stringify(
      {
        type: "service_account",
        project_id: "synthetic-export-test",
        private_key_id: "0000000000000000000000000000000000000000",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0\n-----END PRIVATE KEY-----\n",
        client_email: "synthetic@example.iam.gserviceaccount.com",
      },
      null,
      2,
    );
    const zip = zipAt(dir, "t.zip", [["tests/fixtures/app-config.json", fixture]]);
    const r = runVerifier(zip);
    assert.equal(r.exit, 1);
    assert.match(r.out, /content:service_account_type|content:private_key_field/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh backend source zip passes manifest verifier", () => {
  const out = execFileSync(process.execPath, [path.join(root, "scripts/package-source-export.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  const wrote = out.split("\n").find((line) => line.startsWith("Wrote "));
  assert.ok(wrote, "package export missing Wrote line");
  const zipPath = wrote.replace(/^Wrote\s+(.+?)\s+\(\d+ files\)\s*$/, "$1").trim();
  assert.ok(fs.existsSync(zipPath), zipPath);
  assert.equal(runVerifier(zipPath).exit, 0);
});

test("export manifest does not flag public firebase client apiKey-only snippet", () => {
  const dir = tmpDir();
  try {
    const client = JSON.stringify({
      apiKey: "AIzaSyD-public-client-key-not-service-account",
      authDomain: "demo.firebaseapp.com",
    });
    const zip = zipAt(dir, "t.zip", [["firebase-client.json", client]]);
    assert.equal(runVerifier(zip).exit, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
