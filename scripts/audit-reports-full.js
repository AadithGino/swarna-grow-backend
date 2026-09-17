#!/usr/bin/env node
/**
 * Full Reports audit — all keys, roles, filters, charts, exports.
 * Usage: node scripts/audit-reports-full.js
 */
import assert from "node:assert/strict";

const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const FROM = "2026-09-01";
const TO = "2026-09-17";

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

const BRANCH_FILTER_KEYS = new Set([
  "COLLECTION",
  "ENROLMENT",
  "OUTSTANDING",
  "MATURITY_REDEMPTION",
  "GOLD_ACCRUAL",
  "STAFF_PERFORMANCE",
  "CASH_HANDOVER",
  "REMINDER_DELIVERY",
  "WHATSAPP_USAGE",
  "SCHEME_REGISTER",
  "DEFAULTER",
]);

const issues = [];
const passes = [];

function pass(msg) {
  passes.push(msg);
  console.log(`✓ ${msg}`);
}

function fail(msg, detail) {
  const line = detail ? `${msg} — ${detail}` : msg;
  issues.push(line);
  console.error(`✗ ${line}`);
}

async function login(mobile, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mobile, password, deviceId: "audit-reports-full" }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Login ${mobile} failed: ${JSON.stringify(body)}`);
  const data = body?.data ?? body;
  return {
    token: data.accessToken,
    user: data.user ?? data,
  };
}

async function getBranches(token) {
  const res = await fetch(`${BASE}/admin/branches?limit=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  const rows = body?.data?.rows ?? body?.rows ?? [];
  return rows;
}

async function getPlans(token) {
  const res = await fetch(`${BASE}/admin/schemes/plans?limit=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return body?.data?.rows ?? body?.rows ?? [];
}

async function fetchReport(token, reportKey, extras = {}) {
  const params = new URLSearchParams({
    reportKey,
    period: "CUSTOM",
    from: FROM,
    to: TO,
    limit: "20",
    ...extras,
  });
  const res = await fetch(`${BASE}/admin/reports/${reportKey}?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${reportKey} HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body?.data ?? body;
}

function parseMoneyDisplay(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "object" && value.amountPaise != null) {
    return Number(value.amountPaise) / 100;
  }
  const s = String(value);
  const digits = s.replace(/[^\d.-]/g, "");
  return digits ? Number(digits) : null;
}

function validateEnvelope(reportKey, payload) {
  assert.equal(payload.reportKey, reportKey);
  assert.ok(Array.isArray(payload.summary), "summary");
  assert.ok(payload.charts && typeof payload.charts === "object", "charts");
  assert.ok(Array.isArray(payload.columns), "columns");
  assert.ok(Array.isArray(payload.rows), "rows");
}

function validateCharts(reportKey, payload) {
  for (const [chartKey, chart] of Object.entries(payload.charts ?? {})) {
    if (!chart?.series) continue;
    for (const series of chart.series) {
      if (!Array.isArray(series.data)) {
        fail(`${reportKey}/${chartKey}`, `series ${series.key} data not array`);
        continue;
      }
      for (const point of series.data) {
        if (point.y != null && Number.isNaN(Number(point.y))) {
          fail(`${reportKey}/${chartKey}`, `NaN y in ${series.key}@${point.x}`);
        }
        if (point.yDisplay != null && String(point.yDisplay).includes("NaN")) {
          fail(`${reportKey}/${chartKey}`, `NaN yDisplay in ${series.key}@${point.x}`);
        }
      }
    }
    if (chart.chartType === "groupedBar" && chartKey === "byBranch") {
      const rows = new Map();
      for (const series of chart.series) {
        for (const point of series.data ?? []) {
          const row = rows.get(point.x) ?? {};
          row[series.key] = Number(point.y ?? 0);
          rows.set(point.x, row);
        }
      }
      for (const [branch, modes] of rows) {
        const total = Object.values(modes).reduce((s, v) => s + v, 0);
        if (total <= 0) continue;
        const pctSum = Object.values(modes).reduce(
          (s, v) => s + Math.round((v / total) * 1000) / 10,
          0,
        );
        if (Math.abs(pctSum - 100) > 0.5 && Object.values(modes).filter((v) => v > 0).length > 1) {
          fail(`${reportKey}/byBranch`, `${branch} mode % sum ${pctSum} (expected ~100)`);
        }
      }
    }
  }
}

function validateSummary(reportKey, payload) {
  for (const item of payload.summary ?? []) {
    if (item.value == null) continue;
    if (typeof item.value === "string" && item.value.includes("NaN")) {
      fail(`${reportKey} summary`, `${item.key} shows NaN`);
    }
  }
}

async function auditRole(label, mobile, password) {
  console.log(`\n=== ${label} (${mobile}) ===`);
  const { token } = await login(mobile, password);
  const branches = await getBranches(token);
  const plans = await getPlans(token);
  const branchIds = branches.map((b) => b._id ?? b.id).filter(Boolean);
  const firstBranchId = branchIds[0];
  const firstPlanId = (plans[0]?._id ?? plans[0]?.id) || null;

  pass(`${label}: login OK (${branches.length} branches, ${plans.length} plans)`);

  for (const reportKey of UI_REPORT_KEYS) {
    try {
      const extras = {};
      if (reportKey === "BRANCH_PERFORMANCE") extras.branchId = "ALL";
      if (reportKey === "SCHEME_PERFORMANCE") extras.planId = "ALL";

      const payload = await fetchReport(token, reportKey, extras);
      validateEnvelope(reportKey, payload);
      validateCharts(reportKey, payload);
      validateSummary(reportKey, payload);
      pass(
        `${label} ${reportKey}: ${payload.rows.length} rows, ${payload.summary.length} summary, ${Object.keys(payload.charts).length} charts`,
      );
    } catch (error) {
      fail(`${label} ${reportKey}`, error.message);
    }
  }

  if (firstBranchId && label.includes("Owner")) {
    for (const reportKey of BRANCH_FILTER_KEYS) {
      try {
        const allPayload = await fetchReport(token, reportKey, { branchId: "ALL" });
        const onePayload = await fetchReport(token, reportKey, { branchId: firstBranchId });
        pass(
          `${reportKey} branch filter: ALL=${allPayload.rows.length} rows, single=${onePayload.rows.length} rows`,
        );
        if (reportKey === "COLLECTION") {
          const totalAll = parseMoneyDisplay(
            allPayload.summary?.find((s) => s.key === "TOTAL_COLLECTED")?.value,
          );
          const totalOne = parseMoneyDisplay(
            onePayload.summary?.find((s) => s.key === "TOTAL_COLLECTED")?.value,
          );
          if (totalAll != null && totalOne != null && totalAll < totalOne) {
            fail("COLLECTION ALL vs branch", `ALL total ${totalAll} < single ${totalOne}`);
          } else {
            pass(`COLLECTION totals: ALL=${totalAll}, branch=${totalOne}`);
          }
        }
        if (reportKey === "CASH_HANDOVER" && allPayload.rows.length === 0 && onePayload.rows.length === 0) {
          fail("CASH_HANDOVER ALL", "both ALL and single branch returned 0 rows");
        }
      } catch (error) {
        fail(`${reportKey} branch filter`, error.message);
      }
    }

    if (firstPlanId) {
      try {
        const allPlans = await fetchReport(token, "COLLECTION", { branchId: "ALL", planId: "ALL" });
        const onePlan = await fetchReport(token, "COLLECTION", {
          branchId: "ALL",
          planId: firstPlanId,
        });
        pass(
          `COLLECTION plan filter: ALL=${allPlans.rows.length} rows, plan=${onePlan.rows.length} rows`,
        );
      } catch (error) {
        fail("COLLECTION plan filter", error.message);
      }
    }

    for (const groupBy of ["BRANCH", "DAY"]) {
      try {
        const payload = await fetchReport(token, "COLLECTION", { branchId: "ALL", groupBy });
        const trendPoints = payload.charts?.trend?.series?.[0]?.data?.length ?? 0;
        pass(`COLLECTION groupBy=${groupBy}: trend ${trendPoints} points`);
      } catch (error) {
        fail(`COLLECTION groupBy=${groupBy}`, error.message);
      }
    }

    try {
      const comparison = await fetchReport(token, "BRANCH_PERFORMANCE", { branchId: "ALL" });
      if (comparison.rows[0]?.key) {
        const detail = await fetchReport(token, "BRANCH_PERFORMANCE", {
          branchId: comparison.rows[0].key,
        });
        pass(`BRANCH_PERFORMANCE detail: ${detail.title}`);
      }
      const schemeComparison = await fetchReport(token, "SCHEME_PERFORMANCE", { planId: "ALL" });
      if (schemeComparison.rows[0]?.key) {
        const schemeDetail = await fetchReport(token, "SCHEME_PERFORMANCE", {
          planId: schemeComparison.rows[0].key,
        });
        pass(`SCHEME_PERFORMANCE detail: ${schemeDetail.title}`);
      }
      const customers = await fetchReport(token, "CUSTOMER_PERFORMANCE", {});
      if (customers.rows[0]?.key) {
        const ledger = await fetchReport(token, "CUSTOMER_PERFORMANCE", {
          customerId: customers.rows[0].key,
        });
        pass(`CUSTOMER_PERFORMANCE ledger: ${ledger.rows.length} rows`);
      }
    } catch (error) {
      fail("focus/detail reports", error.message);
    }

    try {
      const res = await fetch(`${BASE}/admin/exports`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reportKey: "COLLECTION",
          format: "CSV",
          period: "CUSTOM",
          from: FROM,
          to: TO,
          branchId: "ALL",
        }),
      });
      const body = await res.json();
      if (res.ok) {
        pass(`CSV export queued: ${body?.data?.exportId ?? body?.exportId ?? "ok"}`);
      } else {
        fail("CSV export", JSON.stringify(body));
      }
    } catch (error) {
      fail("CSV export", error.message);
    }
  }

  if (label.includes("Branch manager") && firstBranchId) {
    try {
      const collection = await fetchReport(token, "COLLECTION", { branchId: "ALL" });
      const branchNames = collection.rows.map((r) => r.label ?? r.key);
      if (branchNames.length > 1) {
        fail("Branch manager COLLECTION scope", `saw ${branchNames.length} branches: ${branchNames.join(", ")}`);
      } else {
        pass(`Branch manager scoped to: ${branchNames[0] ?? "single branch"}`);
      }
    } catch (error) {
      fail("Branch manager scope", error.message);
    }
  }
}

async function auditFrontend() {
  console.log("\n=== Frontend ===");
  try {
    const res = await fetch("http://localhost:5173/reports");
    if (res.ok) {
      pass(`Reports page HTTP ${res.status}`);
    } else {
      fail("Reports page", `HTTP ${res.status}`);
    }
  } catch (error) {
    fail("Reports page", error.message);
  }
}

async function main() {
  console.log(`Full reports audit @ ${BASE} (${FROM} → ${TO})`);
  await auditFrontend();
  await auditRole("Tenant Owner", "9847012345", "2026");
  await auditRole("Branch manager Kochi", "9847012346", "2026");

  console.log(`\n--- Summary: ${passes.length} passed, ${issues.length} failed ---`);
  if (issues.length) {
    console.error("\nFailures:");
    for (const issue of issues) console.error(`  • ${issue}`);
    process.exit(1);
  }
  console.log("\nAll reports checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
