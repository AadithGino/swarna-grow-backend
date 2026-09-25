/**
 * Recompute each KAIRALI admin report for 1–22 Sep 2026.
 * A summary figure matches when it equals the sum of one numeric column on the rows.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Tenant } from "../src/models/index.js";
import { report } from "../src/services/reporting.service.js";

const KEYS = [
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

function leaves(value, path = "") {
  if (typeof value === "number" && Number.isFinite(value)) return [[path, value]];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key));
}

function at(row, path) {
  return path.split(".").reduce((current, key) => current?.[key], row);
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
    const numbers = rows.map((row) => at(row, path)).filter((value) => typeof value === "number");
    if (numbers.length !== rows.length) continue;
    const sum = numbers.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - expected) <= 0.5) return path;
  }
  return null;
}

await connectDatabase();
const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
const req = {
  auth: { tenantId: tenant._id, type: "TENANT_USER", role: "TENANT_OWNER" },
  scope: { tenantId: tenant._id },
  query: { period: "CUSTOM", from: "2026-09-01", to: "2026-09-22" },
};

const lines = [];
for (const key of KEYS) {
  const built = await report(req, key);
  const rows = built.rows ?? [];
  const notes = [];
  if (built.totalsRow) {
    const problems = [];
    for (const [path, expected] of leaves(built.totalsRow)) {
      const column = matchingColumn(rows, expected);
      if (!column && rows.length) problems.push(`${path}=${expected}`);
    }
    notes.push(problems.length ? `totals row mismatch ${problems.join(", ")}` : `totals row matches ${rows.length} rows`);
  }
  for (const item of built.summary ?? []) {
    const amount = item.value?.amountPaise;
    const expected = typeof amount === "number" ? amount : typeof item.value === "number" ? item.value : null;
    if (expected == null) continue;
    const column = matchingColumn(rows, expected);
    if (column) notes.push(`${item.label} matches sum of ${column}`);
    else if (expected === rows.length) notes.push(`${item.label} matches row count ${rows.length}`);
    else notes.push(`${item.label} is ${expected} and is not the sum of a row column (${rows.length} rows)`);
  }
  lines.push({ key, rows: rows.length, notes });
}
console.log(JSON.stringify(lines, null, 2));
await disconnectDatabase();
