#!/usr/bin/env node
/**
 * Smoke-test every Reports page key against a running API.
 * Usage: node scripts/audit-reports-smoke.js [--base http://localhost:4000/api/v1] [--mobile 9847012345] [--password 2026]
 */
import assert from "node:assert/strict";

const UI_REPORT_KEYS = [
  "COLLECTION",
  "ENROLMENT",
  "OUTSTANDING",
  "MATURITY_REDEMPTION",
  "GOLD_ACCRUAL",
  "CUSTOMER_PERFORMANCE",
  "STAFF_PERFORMANCE",
  "CASH_HANDOVER",
  "REMINDER_DELIVERY",
  "WHATSAPP_USAGE",
  "SCHEME_REGISTER",
  "DEFAULTER",
  "BRANCH_PERFORMANCE",
  "SCHEME_PERFORMANCE",
];

function parseArgs(argv) {
  const args = { base: "http://localhost:4000/api/v1", mobile: "9847012345", password: "2026" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--base") args.base = argv[++i];
    else if (argv[i] === "--mobile") args.mobile = argv[++i];
    else if (argv[i] === "--password") args.password = argv[++i];
  }
  return args;
}

async function login(base, mobile, password) {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mobile, password, deviceId: "audit-reports-smoke" }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Login failed (${res.status}): ${JSON.stringify(body)}`);
  const token = body?.data?.accessToken ?? body?.accessToken;
  if (!token) throw new Error("Login response missing accessToken");
  return token;
}

function reportParams(reportKey, extras = {}) {
  const from = "2026-02-01";
  const to = new Date().toISOString().slice(0, 10);
  const params = new URLSearchParams({
    reportKey,
    period: "CUSTOM",
    from,
    to,
    limit: "8",
    ...extras,
  });
  return params;
}

function validateEnvelope(reportKey, payload) {
  assert.equal(payload.reportKey, reportKey, `${reportKey}: reportKey mismatch`);
  assert.ok(Array.isArray(payload.summary), `${reportKey}: summary missing`);
  assert.ok(payload.charts && typeof payload.charts === "object", `${reportKey}: charts missing`);
  assert.ok(Array.isArray(payload.columns), `${reportKey}: columns missing`);
  assert.ok(Array.isArray(payload.rows), `${reportKey}: rows missing`);
  for (const chart of Object.values(payload.charts)) {
    if (!chart?.series) continue;
    for (const series of chart.series) {
      assert.ok(Array.isArray(series.data), `${reportKey}: chart ${series.key} data not array`);
    }
  }
}

async function fetchReport(base, token, reportKey, extras = {}) {
  const params = reportParams(reportKey, extras);
  const res = await fetch(`${base}/admin/reports/${reportKey}?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${reportKey} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  const payload = body?.data ?? body;
  validateEnvelope(reportKey, payload);
  return payload;
}

async function main() {
  const { base, mobile, password } = parseArgs(process.argv);
  console.log(`Auditing reports at ${base} as ${mobile}`);

  const token = await login(base, mobile, password);
  const results = [];

  for (const reportKey of UI_REPORT_KEYS) {
    const extras =
      reportKey === "BRANCH_PERFORMANCE" || reportKey === "SCHEME_PERFORMANCE"
        ? { branchId: "ALL", planId: "ALL" }
        : {};
    const payload = await fetchReport(base, token, reportKey, extras);
    results.push({
      reportKey,
      title: payload.title,
      summaryKeys: payload.summary.map((row) => row.key),
      rowCount: payload.rows.length,
      chartCount: Object.keys(payload.charts).length,
    });
    console.log(`✓ ${reportKey} — ${payload.rows.length} rows, ${Object.keys(payload.charts).length} charts`);
  }

  // Branch performance comparison vs detail
  const branchComparison = await fetchReport(base, token, "BRANCH_PERFORMANCE", { branchId: "ALL" });
  assert.ok(branchComparison.rows.length >= 1, "branch comparison should list branches");
  if (branchComparison.rows[0]?.key) {
    const branchDetail = await fetchReport(base, token, "BRANCH_PERFORMANCE", {
      branchId: branchComparison.rows[0].key,
    });
    assert.match(branchDetail.title, /.+/);
    console.log(`✓ BRANCH_PERFORMANCE detail — ${branchDetail.title}`);
  }

  // Scheme performance comparison vs detail
  const schemeComparison = await fetchReport(base, token, "SCHEME_PERFORMANCE", { planId: "ALL" });
  assert.ok(schemeComparison.rows.length >= 1, "scheme comparison should list plans");
  if (schemeComparison.rows[0]?.key) {
    const schemeDetail = await fetchReport(base, token, "SCHEME_PERFORMANCE", {
      planId: schemeComparison.rows[0].key,
    });
    console.log(`✓ SCHEME_PERFORMANCE detail — ${schemeDetail.title}`);
  }

  console.log("\nAll report smoke checks passed.");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
