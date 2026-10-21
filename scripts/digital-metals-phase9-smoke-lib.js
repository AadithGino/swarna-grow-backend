import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function smokeResultsPath(runId) {
  return path.join(repoRoot, "docs", `phase9-browser-smoke-results-${runId}.json`);
}

export function initRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function recordFinding(resultsPath, findings, area, ok, detail) {
  findings.push({ area, ok, detail, at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify(findings, null, 2));
  console.log(`${ok ? "PASS" : "FAIL"} ${area}: ${detail}`);
}

export function dispatchOutboxOnceMock() {
  execFileSync("node", ["--env-file=.env", "scripts/digital-metals-outbox-dispatch-once.js"], {
    cwd: repoRoot,
    stdio: "pipe",
    env: { ...process.env, PROVIDER_MODE: "mock" },
  });
}

export async function pollArtifactViaApi(request, apiBase, bearer, artifactId, { maxMs = 90_000, pollMs = 3000 } = {}) {
  const deadline = Date.now() + maxMs;
  let last = null;
  while (Date.now() < deadline) {
    dispatchOutboxOnceMock();
    const res = await request.get(`${apiBase}/app/digital-metals/documents/${artifactId}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    last = await res.json().catch(() => ({}));
    if (!res.ok()) {
      return {
        ok: false,
        status: `HTTP_${res.status()}`,
        error: JSON.stringify(last).slice(0, 400),
        body: last,
      };
    }
    const status = last?.data?.status ?? last?.data?.artifact?.status;
    if (status === "READY") {
      const dl = await request.get(`${apiBase}/app/digital-metals/documents/${artifactId}/download-url`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      if (!dl.ok()) {
        return { ok: false, status: "DOWNLOAD_URL_HTTP", error: `download-url ${dl.status()}` };
      }
      const dlJson = await dl.json().catch(() => ({}));
      const downloadUrl = dlJson?.data?.downloadUrl;
      if (!downloadUrl) {
        return { ok: false, status: "DOWNLOAD_URL_MISSING", error: "empty downloadUrl" };
      }
      const pdfEvidence = await verifyPdfDownloadUrl(request, downloadUrl, { storageKind: "mock-local" });
      if (!pdfEvidence.ok) {
        return { ok: false, status: "PDF_BYTES_INVALID", error: pdfEvidence.error, body: last };
      }
      const refresh = await request.get(`${apiBase}/app/digital-metals/documents/${artifactId}/download-url`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      const refreshUrl = (await refresh.json().catch(() => ({})))?.data?.downloadUrl;
      if (!refresh.ok() || !refreshUrl) {
        return { ok: false, status: "DOWNLOAD_URL_REFRESH", error: "could not refresh authorized download-url" };
      }
      return {
        ok: true,
        status,
        body: last,
        pdfBytes: pdfEvidence.byteLength,
        storageKind: pdfEvidence.storageKind,
        downloadUrlReplaced: refreshUrl !== downloadUrl,
      };
    }
    if (status === "FAILED") {
      return {
        ok: false,
        status,
        error: last?.data?.lastError ?? last?.data?.artifact?.lastError ?? "FAILED",
        body: last,
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return {
    ok: false,
    status: "TIMEOUT",
    error: `No READY/FAILED within ${maxMs}ms; last=${JSON.stringify(last?.data ?? last).slice(0, 400)}`,
    body: last,
  };
}

/** Fetch presigned/mock URL and assert PDF magic bytes (not merely a nonempty URL). */
export async function verifyPdfDownloadUrl(request, downloadUrl, { storageKind = "unknown" } = {}) {
  const isMockLocal =
    storageKind === "mock-local"
    || downloadUrl.includes(".mock-storage")
    || downloadUrl.startsWith("file://");
  const res = await request.get(downloadUrl);
  if (!res.ok()) {
    return { ok: false, error: `GET ${res.status()}`, storageKind: isMockLocal ? "mock-local" : "remote" };
  }
  const buf = await res.body();
  const head = buf.slice(0, 5).toString("utf8");
  if (head !== "%PDF-") {
    return {
      ok: false,
      error: `expected %PDF- magic, got ${JSON.stringify(head)}`,
      storageKind: isMockLocal ? "mock-local" : "remote",
    };
  }
  return {
    ok: true,
    byteLength: buf.length,
    storageKind: isMockLocal ? "mock-local" : "remote",
  };
}

export async function safeGoto(page, url, label) {
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (response && !response.ok() && response.status() !== 304) {
      throw new Error(`${label}: HTTP ${response.status()} for ${url}`);
    }
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (msg.includes("ERR_ABORTED") || msg.includes("detached")) {
      throw new Error(`${label}: navigation aborted (${msg}). Avoid concurrent navigation on this page.`, {
        cause: err,
      });
    }
    throw err;
  }
}

export const PHASE9_SMOKE_CUSTOMER_MOBILE = "9847099901";
