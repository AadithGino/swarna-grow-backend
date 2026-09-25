/**
 * Builds per-report KPI contract notes (API summary vs table row sums).
 * Same rules as check-report-totals.js — portfolio KPIs may differ from paginated rows by design.
 */
import fs from "node:fs";
import path from "node:path";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Tenant } from "../src/models/index.js";
import { report } from "../src/services/reporting.service.js";
import { REPORT_KEYS } from "./lib/parity-display.js";

function leaves(value, p = "") {
  if (typeof value === "number" && Number.isFinite(value)) return [[p, value]];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, p ? `${p}.${key}` : key),
  );
}

function at(row, p) {
  return p.split(".").reduce((cur, key) => cur?.[key], row);
}

function rowPaths(rows) {
  const paths = new Set();
  for (const row of rows.slice(0, 5)) {
    for (const [path] of leaves(row)) paths.add(path);
  }
  return [...paths];
}

function matchingColumn(rows, expected) {
  for (const path of rowPaths(rows)) {
    const numbers = rows
      .map((row) => at(row, path))
      .filter((value) => typeof value === "number");
    if (numbers.length !== rows.length) continue;
    const sum = numbers.reduce((t, v) => t + v, 0);
    if (Math.abs(sum - expected) <= 0.5) return path;
  }
  return null;
}

function summaryFields(summary) {
  const out = [];
  for (const item of summary ?? []) {
    const amount = item.value?.amountPaise;
    const expected =
      typeof amount === "number"
        ? amount
        : typeof item.value === "number"
          ? item.value
          : null;
    if (expected == null) continue;
    out.push({
      label: item.label,
      value: expected,
      valueType: item.valueType ?? (amount != null ? "paise" : "number"),
    });
  }
  return out;
}

const OUT = path.resolve("docs/tenant-report-kpi-contract.json");

await connectDatabase();
const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
const req = {
  auth: { tenantId: tenant._id, type: "TENANT_USER", role: "TENANT_OWNER" },
  scope: { tenantId: tenant._id },
  query: { period: "CUSTOM", from: "2026-09-01", to: "2026-09-22" },
};

const payload = [];
for (const key of REPORT_KEYS) {
  const built = await report(req, key);
  const rows = built.rows ?? [];
  const fields = summaryFields(built.summary);
  const fieldNotes = fields.map((field) => {
    const column = matchingColumn(rows, field.value);
    if (column) return { ...field, rowSumColumn: column, contract: "ROW_SUM" };
    if (field.value === rows.length) {
      return { ...field, rowSumColumn: null, contract: "ROW_COUNT" };
    }
    return { ...field, rowSumColumn: null, contract: "PORTFOLIO_KPI" };
  });
  let totalsRowOk = null;
  if (built.totalsRow) {
    const problems = [];
    for (const [path, expected] of leaves(built.totalsRow)) {
      if (!matchingColumn(rows, expected) && rows.length) {
        problems.push(`${path}=${expected}`);
      }
    }
    totalsRowOk = problems.length === 0;
  }
  payload.push({
    key,
    rowCount: rows.length,
    hasTotalsRow: Boolean(built.totalsRow),
    totalsRowMatchesRows: totalsRowOk,
    summaryFields: fieldNotes,
  });
}

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(`Wrote ${OUT} (${payload.length} reports)`);
await disconnectDatabase();
