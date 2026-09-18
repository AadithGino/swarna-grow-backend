#!/usr/bin/env node
/**
 * Full frontend-facing API matrix audit — periods, branch filters, status filters,
 * reports, roles, platform — cross-checked against MongoDB where applicable.
 *
 * Usage: node --env-file=.env scripts/audit-frontend-full.js
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import {
  Branch,
  Customer,
  Payment,
  Scheme,
  SchemePlan,
  CashHandover,
  Redemption,
  Grievance,
  Tenant,
} from "../src/models/index.js";
import { dateMatch, resolveQueryDateRange } from "../src/lib/query-filters.js";
import { paymentListScope } from "../src/lib/payment-scope.js";

const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const PASSWORD = "2026";
const TENANT_CODE = "KAIRALI";
const CUSTOM_FROM = "2026-01-01";
const CUSTOM_TO = "2026-09-17";

const PERIODS = ["TODAY", "THIS_WEEK", "THIS_MONTH", "LAST_MONTH", "LAST_3_MONTHS"];
const REPORT_KEYS = [
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
const BRANCH_FILTER_REPORTS = new Set([
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
let tenantId = null;

function pass(msg) {
  passes.push(msg);
  console.log(`✓ ${msg}`);
}
function fail(area, msg, ctx) {
  const line = ctx ? `${area}: ${msg} (${ctx})` : `${area}: ${msg}`;
  issues.push(line);
  console.error(`✗ ${line}`);
}

function dataOf(res) {
  return res.body?.data ?? res.body;
}
function listTotal(res) {
  const d = dataOf(res);
  if (Array.isArray(d)) return d.length;
  return d?.meta?.total ?? d?.total ?? (d?.rows?.length ?? 0);
}
function summaryKey(payload, key) {
  const item = (payload?.summary ?? []).find((s) => s.key === key);
  return item?.value ?? null;
}

async function api(token, method, path, queryOrOpts = {}) {
  const opts =
    queryOrOpts.body !== undefined || queryOrOpts.query !== undefined
      ? queryOrOpts
      : { query: queryOrOpts };
  const { query = {}, body } = opts;
  const params = new URLSearchParams(query);
  const qs = params.toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed, url };
}

async function tenantLogin(mobile) {
  const res = await api(null, "POST", "/auth/login", {
    body: { tenantCode: TENANT_CODE, mobile, password: PASSWORD, deviceId: "audit-frontend-full" },
  });
  const data = dataOf(res);
  if (!res.ok) throw new Error(`Login ${mobile}: ${JSON.stringify(res.body)}`);
  tenantId = data.user?.tenantId ?? tenantId;
  return { token: data.accessToken, user: data.user };
}

async function platformLogin() {
  const res = await api(null, "POST", "/platform/auth/login", {
    body: {
      email: env.SEED_PLATFORM_EMAIL ?? "ops@platform.com",
      password: env.SEED_PLATFORM_PASSWORD ?? "1234",
      deviceId: "audit-frontend-full",
    },
  });
  const data = dataOf(res);
  if (!res.ok) throw new Error(`Platform login: ${JSON.stringify(res.body)}`);
  return data.accessToken;
}

function scopeFor(user) {
  return user?.branchId ? { tenantId, branchId: user.branchId } : { tenantId };
}

/** Mimic collection-summary match for a token + query (branch/period). */
async function collectionMatchFromApi(token, query) {
  const meRes = await api(token, "GET", "/auth/me");
  const auth = dataOf(meRes)?.user ?? dataOf(meRes);
  const req = {
    auth,
    scope: { tenantId: auth.tenantId, branchId: auth.branchId ?? null },
    query,
  };
  const range = resolveQueryDateRange(query);
  return {
    ...(await paymentListScope(req)),
    status: "SUCCESS",
    ...dateMatch("paidAt", range),
  };
}

function chartHasNaN(charts) {
  for (const chart of Object.values(charts ?? {})) {
    for (const series of chart?.series ?? []) {
      for (const point of series.data ?? []) {
        if (point.y != null && Number.isNaN(Number(point.y))) return true;
        if (String(point.yDisplay ?? "").includes("NaN")) return true;
      }
    }
  }
  return false;
}

async function auditPeriodMatrix(token, label, user = null) {
  console.log(`\n--- Period matrix (${label}) ---`);
  const dbScope = scopeFor(user);
  for (const period of PERIODS) {
    const coll = await api(token, "GET", "/admin/collections/summary", { period });
    if (coll.ok) {
      const c = dataOf(coll);
      const match = await collectionMatchFromApi(token, { period });
      const dbColl = await Payment.aggregate([
        {
          $match: match,
        },
        { $group: { _id: null, count: { $sum: 1 }, amountPaise: { $sum: "$amountPaise" } } },
      ]);
      const dbCount = dbColl[0]?.count ?? 0;
      const dbAmount = dbColl[0]?.amountPaise ?? 0;
      if (c?.count !== dbCount || c?.amountPaise !== dbAmount) {
        fail("Collections", `period=${period} count=${c?.count}/${dbCount} amount=${c?.amountPaise}/${dbAmount}`, label);
      } else {
        pass(`${label} collections/${period} = ${dbCount} payments`);
      }
    } else {
      fail("Collections", `period=${period} HTTP ${coll.status}`, label);
    }

    const trend = await api(token, "GET", "/admin/dashboard/charts/collection-trend", { period });
    if (trend.ok && chartHasNaN(dataOf(trend)?.charts)) {
      fail("Collection trend", `NaN in chart period=${period}`, label);
    } else if (trend.ok) {
      pass(`${label} collection-trend/${period}`);
    }

    const cashReport = await api(token, "GET", "/admin/cash/report", { period });
    if (cashReport.ok) pass(`${label} cash-report/${period}`);
    else fail("Cash report", `period=${period} HTTP ${cashReport.status}`, label);
  }

  // CUSTOM range spanning seed window
  const customColl = await api(token, "GET", "/admin/collections/summary", {
    from: CUSTOM_FROM,
    to: CUSTOM_TO,
  });
  if (customColl.ok) {
    const c = dataOf(customColl);
    const match = await collectionMatchFromApi(token, { from: CUSTOM_FROM, to: CUSTOM_TO });
    const dbColl = await Payment.aggregate([
      {
        $match: match,
      },
      { $group: { _id: null, count: { $sum: 1 }, amountPaise: { $sum: "$amountPaise" } } },
    ]);
    const dbCount = dbColl[0]?.count ?? 0;
    if (c?.count !== dbCount) {
      fail("Collections CUSTOM", `count API=${c?.count} DB=${dbCount}`, label);
    } else {
      pass(`${label} collections CUSTOM ${CUSTOM_FROM}→${CUSTOM_TO} = ${dbCount}`);
    }
  }

  // Analytics snapshot cross-check (THIS_MONTH)
  const custAnalytics = await api(token, "GET", "/admin/customers/analytics", { period: "THIS_MONTH" });
  if (custAnalytics.ok) {
    const payload = dataOf(custAnalytics);
    const dbTotal = await Customer.countDocuments(dbScope);
    const dbActive = await Customer.countDocuments({ ...dbScope, status: "ACTIVE" });
    const apiTotal = summaryKey(payload, "TOTAL_CUSTOMERS");
    const apiActive = summaryKey(payload, "ACTIVE_CUSTOMERS");
    if (apiTotal !== dbTotal) fail("Customer analytics", `TOTAL API=${apiTotal} DB=${dbTotal}`, label);
    else pass(`${label} customer analytics TOTAL=${dbTotal}`);
    if (apiActive !== dbActive) fail("Customer analytics", `ACTIVE API=${apiActive} DB=${dbActive}`, label);
    else pass(`${label} customer analytics ACTIVE=${dbActive}`);
    if (chartHasNaN(payload?.charts)) fail("Customer analytics", "NaN in charts", label);
  }

  const schemeAnalytics = await api(token, "GET", "/admin/schemes/analytics", { period: "THIS_MONTH" });
  if (schemeAnalytics.ok) {
    const payload = dataOf(schemeAnalytics);
    const dbTotal = await Scheme.countDocuments(dbScope);
    const apiTotal = summaryKey(payload, "TOTAL_ENROLLMENTS");
    if (apiTotal !== dbTotal) fail("Scheme analytics", `TOTAL API=${apiTotal} DB=${dbTotal}`, label);
    else pass(`${label} scheme analytics TOTAL=${dbTotal}`);
    if (chartHasNaN(payload?.charts)) fail("Scheme analytics", "NaN in charts", label);
  }
}

async function auditBranchMatrix(token, label, branches, user = null) {
  console.log(`\n--- Branch filter matrix (${label}) ---`);
  const branchIds = branches.map((b) => String(b._id ?? b.id));
  const lockedBranch = user?.branchId ? String(user.branchId) : null;
  const branchOptions = lockedBranch ? [lockedBranch] : ["ALL", ...branchIds.slice(0, 3)];

  for (const branchId of branchOptions) {
    const scope = branchId === "ALL" ? { tenantId } : { tenantId, branchId };

    for (const [name, path, Model] of [
      ["Customers", "/admin/customers", Customer],
      ["Schemes", "/admin/schemes", Scheme],
      ["Payments", "/admin/payments", Payment],
    ]) {
      const res = await api(token, "GET", path, { branchId, limit: "1" });
      if (!res.ok) {
        fail(name, `branchId=${branchId} HTTP ${res.status}`, label);
        continue;
      }
      const metaTotal = dataOf(res)?.meta?.total;
      if (metaTotal != null) {
        const dbCount = await Model.countDocuments(scope);
        if (metaTotal !== dbCount) {
          fail(name, `branchId=${branchId} meta.total=${metaTotal} DB=${dbCount}`, label);
        } else {
          pass(`${label} ${name} branchId=${branchId} total=${dbCount}`);
        }
      }
    }

    const coll = await api(token, "GET", "/admin/collections/summary", {
      period: "THIS_MONTH",
      branchId,
    });
    if (coll.ok) {
      const match = await collectionMatchFromApi(token, { period: "THIS_MONTH", branchId });
      const dbColl = await Payment.aggregate([
        { $match: match },
        { $group: { _id: null, count: { $sum: 1 }, amountPaise: { $sum: "$amountPaise" } } },
      ]);
      const c = dataOf(coll);
      const dbCount = dbColl[0]?.count ?? 0;
      const dbAmount = dbColl[0]?.amountPaise ?? 0;
      if (c?.count !== dbCount || c?.amountPaise !== dbAmount) {
        fail("Collections branch", `branchId=${branchId} API=${c?.count}/${c?.amountPaise} DB=${dbCount}/${dbAmount}`, label);
      } else {
        pass(`${label} collections branchId=${branchId} THIS_MONTH = ${dbCount}`);
      }
    }
  }
}

async function auditStatusFilters(token, label) {
  console.log(`\n--- Status filters (${label}) ---`);
  const checks = [
    ["Customers ACTIVE", "/admin/customers", Customer, { status: "ACTIVE" }, { tenantId, status: "ACTIVE" }],
    ["Schemes ACTIVE", "/admin/schemes", Scheme, { status: "ACTIVE" }, { tenantId, status: "ACTIVE" }],
    ["Schemes MATURED", "/admin/schemes", Scheme, { status: "MATURED" }, { tenantId, status: "MATURED" }],
    ["Payments SUCCESS", "/admin/payments", Payment, { status: "SUCCESS" }, { tenantId, status: "SUCCESS" }],
    ["Handovers PENDING", "/admin/cash/handovers", CashHandover, { status: "PENDING" }, { tenantId, status: "PENDING" }],
    ["Redemptions OPEN", "/admin/redemptions", Redemption, { status: "REQUESTED" }, { tenantId, status: "REQUESTED" }],
    ["Grievances OPEN", "/admin/grievances", Grievance, { status: "OPEN" }, { tenantId, status: "OPEN" }],
  ];
  for (const [name, path, Model, query, dbFilter] of checks) {
    const res = await api(token, "GET", path, { ...query, limit: "1" });
    if (!res.ok) {
      fail(name, `HTTP ${res.status}`, label);
      continue;
    }
    const metaTotal = dataOf(res)?.meta?.total;
    if (metaTotal != null) {
      const dbCount = await Model.countDocuments(dbFilter);
      if (metaTotal !== dbCount) {
        fail(name, `meta.total=${metaTotal} DB=${dbCount}`, label);
      } else {
        pass(`${label} ${name} = ${dbCount}`);
      }
    } else {
      pass(`${label} ${name} responds`);
    }
  }

  const kycRes = await api(token, "GET", "/admin/customers", { kycStatus: "VERIFIED", limit: "1" });
  if (kycRes.ok) {
    const metaTotal = dataOf(kycRes)?.meta?.total;
    const dbCount = await Customer.countDocuments({ tenantId, "kyc.status": "VERIFIED" });
    if (metaTotal != null && metaTotal !== dbCount) {
      fail("Customers KYC VERIFIED", `meta.total=${metaTotal} DB=${dbCount}`, label);
    } else {
      pass(`${label} customers kycStatus=VERIFIED = ${dbCount}`);
    }
  }
}

async function auditReportsMatrix(token, label, branches, plans) {
  console.log(`\n--- Reports matrix (${label}) ---`);
  const branchId = branches[0]?._id ?? branches[0]?.id;
  const planId = plans[0]?._id ?? plans[0]?.id;

  for (const period of ["THIS_MONTH", "LAST_MONTH", "LAST_3_MONTHS"]) {
    for (const reportKey of REPORT_KEYS) {
      const query = { reportKey, period, limit: "50" };
      if (reportKey === "BRANCH_PERFORMANCE") query.branchId = "ALL";
      if (reportKey === "SCHEME_PERFORMANCE") query.planId = "ALL";

      const res = await api(token, "GET", `/admin/reports/${reportKey}`, query);
      if (!res.ok) {
        fail("Report", `${reportKey}/${period} HTTP ${res.status}`, label);
        continue;
      }
      const payload = dataOf(res);
      if (payload.reportKey !== reportKey) {
        fail("Report", `${reportKey} wrong reportKey in response`, label);
        continue;
      }
      if (chartHasNaN(payload?.charts)) {
        fail("Report", `${reportKey}/${period} NaN in charts`, label);
      } else {
        pass(`${label} ${reportKey}/${period} rows=${payload.rows?.length ?? 0}`);
      }
    }
  }

  // CUSTOM date range
  for (const reportKey of REPORT_KEYS) {
    const query = {
      reportKey,
      period: "CUSTOM",
      from: CUSTOM_FROM,
      to: CUSTOM_TO,
      limit: "50",
    };
    if (reportKey === "BRANCH_PERFORMANCE") query.branchId = "ALL";
    if (reportKey === "SCHEME_PERFORMANCE") query.planId = "ALL";
    const res = await api(token, "GET", `/admin/reports/${reportKey}`, query);
    if (res.ok) pass(`${label} ${reportKey}/CUSTOM`);
    else fail("Report CUSTOM", `${reportKey} HTTP ${res.status}`, label);
  }

  // Branch + plan filters on COLLECTION
  if (branchId) {
    for (const reportKey of BRANCH_FILTER_REPORTS) {
      const allRes = await api(token, "GET", `/admin/reports/${reportKey}`, {
        reportKey,
        period: "THIS_MONTH",
        branchId: "ALL",
        limit: "50",
      });
      const oneRes = await api(token, "GET", `/admin/reports/${reportKey}`, {
        reportKey,
        period: "THIS_MONTH",
        branchId: String(branchId),
        limit: "50",
      });
      if (allRes.ok && oneRes.ok) {
        pass(`${label} ${reportKey} branch ALL=${dataOf(allRes).rows?.length} vs ${dataOf(oneRes).rows?.length}`);
      }
    }

    const collAll = dataOf(
      await api(token, "GET", "/admin/reports/COLLECTION", {
        reportKey: "COLLECTION",
        period: "THIS_MONTH",
        branchId: "ALL",
        limit: "50",
      }),
    );
    const collOne = dataOf(
      await api(token, "GET", "/admin/reports/COLLECTION", {
        reportKey: "COLLECTION",
        period: "THIS_MONTH",
        branchId: String(branchId),
        limit: "50",
      }),
    );
    const totalAll = summaryKey(collAll, "TOTAL_COLLECTED");
    const totalOne = summaryKey(collOne, "TOTAL_COLLECTED");
    const allPaise =
      typeof totalAll === "object" ? totalAll?.amountPaise : null;
    const onePaise =
      typeof totalOne === "object" ? totalOne?.amountPaise : null;
    if (allPaise != null && onePaise != null && allPaise < onePaise) {
      fail("COLLECTION branch", `ALL ${allPaise} < single ${onePaise}`, label);
    }
  }

  if (planId) {
    const withPlan = await api(token, "GET", "/admin/reports/COLLECTION", {
      reportKey: "COLLECTION",
      period: "THIS_MONTH",
      branchId: "ALL",
      planId: String(planId),
      limit: "50",
    });
    if (withPlan.ok) pass(`${label} COLLECTION planId filter`);
  }

  for (const groupBy of ["BRANCH", "DAY"]) {
    const res = await api(token, "GET", "/admin/reports/COLLECTION", {
      reportKey: "COLLECTION",
      period: "THIS_MONTH",
      branchId: "ALL",
      groupBy,
      limit: "50",
    });
    if (res.ok && !chartHasNaN(dataOf(res)?.charts)) {
      pass(`${label} COLLECTION groupBy=${groupBy}`);
    } else {
      fail("COLLECTION groupBy", groupBy, label);
    }
  }
}

async function auditRoleScoping() {
  console.log("\n--- Role scoping ---");
  const owner = await tenantLogin("9847012345");
  const tenantAdmin = await tenantLogin("9847012347");
  const branchMgr = await tenantLogin("9847012346");
  const staff = await tenantLogin("9847012350");

  const ownerBranches = listTotal(await api(owner.token, "GET", "/admin/branches", { limit: "50" }));
  const mgrBranches = listTotal(await api(branchMgr.token, "GET", "/admin/branches", { limit: "50" }));
  if (mgrBranches > ownerBranches) {
    fail("Branch mgr", `sees ${mgrBranches} branches vs owner ${ownerBranches}`);
  } else {
    pass(`Branch mgr branches ${mgrBranches} ≤ owner ${ownerBranches}`);
  }

  const ownerCustomers = listTotal(await api(owner.token, "GET", "/admin/customers", { limit: "1" }));
  const mgrCustomers = listTotal(await api(branchMgr.token, "GET", "/admin/customers", { limit: "1" }));
  if (mgrCustomers > ownerCustomers) {
    fail("Branch mgr", `customers ${mgrCustomers} > owner ${ownerCustomers}`);
  } else {
    pass(`Branch mgr customers ${mgrCustomers} ≤ owner ${ownerCustomers}`);
  }

  const adminCustomers = listTotal(await api(tenantAdmin.token, "GET", "/admin/customers", { limit: "1" }));
  if (adminCustomers !== ownerCustomers) {
    fail("Tenant admin", `customers ${adminCustomers} vs owner ${ownerCustomers}`);
  } else {
    pass(`Tenant admin sees all ${adminCustomers} customers`);
  }

  const staffCustomers = listTotal(await api(staff.token, "GET", "/admin/customers", { limit: "1" }));
  pass(`Staff MGR customers visible: ${staffCustomers}`);

  const mgrReport = dataOf(
    await api(branchMgr.token, "GET", "/admin/reports/BRANCH_PERFORMANCE", {
      reportKey: "BRANCH_PERFORMANCE",
      period: "THIS_MONTH",
      branchId: "ALL",
      limit: "20",
    }),
  );
  if ((mgrReport?.rows?.length ?? 0) > 1) {
    fail("Branch mgr report", `BRANCH_PERFORMANCE rows=${mgrReport.rows.length}`);
  } else {
    pass(`Branch mgr BRANCH_PERFORMANCE rows=${mgrReport?.rows?.length ?? 0}`);
  }

  return owner;
}

async function auditDetailEndpoints(token, label) {
  console.log(`\n--- Detail endpoints (${label}) ---`);
  const activeScheme = await Scheme.findOne({ tenantId, status: "ACTIVE" }).select("_id").lean();
  const maturedScheme = await Scheme.findOne({ tenantId, status: "MATURED" }).select("_id").lean();
  const customer = await Customer.findOne({ tenantId }).select("_id").lean();
  const plan = await SchemePlan.findOne({ tenantId }).select("_id").lean();

  if (customer) {
    const id = String(customer._id);
    for (const sub of ["", "/schemes", "/payments", "/messages"]) {
      const res = await api(token, "GET", `/admin/customers/${id}${sub}`, { limit: "5" });
      if (res.ok) pass(`${label} GET /admin/customers/${id}${sub}`);
      else fail("Customer detail", sub || "root", label);
    }
  }

  if (activeScheme) {
    const id = String(activeScheme._id);
    for (const sub of ["ledger", "passbook", "maturity-projection", "payable-range"]) {
      const res = await api(token, "GET", `/admin/schemes/${id}/${sub}`);
      if (res.ok) pass(`${label} scheme/${sub} (ACTIVE)`);
      else fail("Scheme detail", `${sub} HTTP ${res.status}`, label);
    }
  }

  if (maturedScheme) {
    const id = String(maturedScheme._id);
    const settle = await api(token, "GET", `/admin/schemes/${id}/settlement-preview`);
    if (settle.ok) pass(`${label} scheme/settlement-preview (MATURED)`);
    else fail("Settlement preview", `HTTP ${settle.status}`, label);
  }

  if (plan) {
    const id = String(plan._id);
    const detail = await api(token, "GET", `/admin/scheme-plans/${id}`);
    const stats = await api(token, "GET", `/admin/scheme-plans/${id}/stats`);
    if (detail.ok) pass(`${label} plan detail`);
    if (stats.ok) pass(`${label} plan stats`);
  }

  const search = await api(token, "GET", "/admin/search", { q: "98", limit: "5" });
  if (search.ok) pass(`${label} global search`);
}

async function auditPlatform() {
  console.log("\n--- Platform API ---");
  const token = await platformLogin();
  const endpoints = [
    ["/platform/dashboard/summary", {}],
    ["/platform/tenants", { limit: "10" }],
    ["/platform/subscription-plans", {}],
  ];
  for (const [path, query] of endpoints) {
    const res = await api(token, "GET", path, query);
    if (res.ok) pass(`Platform ${path}`);
    else fail("Platform", `${path} HTTP ${res.status}`);
  }

  const tenant = await Tenant.findOne({ code: TENANT_CODE }).select("_id").lean();
  if (tenant) {
    const detail = await api(token, "GET", `/platform/tenants/${tenant._id}`);
    if (detail.ok) pass(`Platform tenant detail ${TENANT_CODE}`);
    else fail("Platform", `tenant detail HTTP ${detail.status}`);
  }
}

async function main() {
  console.log(`Frontend full audit @ ${BASE}\n`);
  await connectDatabase();
  try {
    const tenant = await Tenant.findOne({ code: TENANT_CODE }).select("_id").lean();
    if (!tenant) throw new Error(`Tenant ${TENANT_CODE} not found — run npm run seed:demo`);
    tenantId = tenant._id;

    const ownerSession = await auditRoleScoping();
    const { token, user } = ownerSession;
    const label = "Owner";

    const branches = await Branch.find({ tenantId }).select("_id name code").lean();
    const plans = await SchemePlan.find({ tenantId }).select("_id name code").lean();
    pass(`Seed data: ${branches.length} branches, ${plans.length} plans`);

    await auditPeriodMatrix(token, label, user);
    await auditBranchMatrix(token, label, branches, user);
    await auditStatusFilters(token, label);
    await auditReportsMatrix(token, label, branches, plans);
    await auditDetailEndpoints(token, label);
    await auditPlatform();

    // Branch manager subset
    const mgr = await tenantLogin("9847012346");
    await auditPeriodMatrix(mgr.token, "BranchMgr", mgr.user);
    await auditBranchMatrix(mgr.token, "BranchMgr", branches.filter((b) => String(b._id) === String(mgr.user.branchId)), mgr.user);

    console.log(`\n========== SUMMARY: ${passes.length} passed, ${issues.length} failed ==========`);
    if (issues.length) {
      console.error("\nFailures:");
      for (const issue of issues) console.error(`  • ${issue}`);
      process.exitCode = 1;
    } else {
      console.log("\nAll frontend matrix checks passed.");
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
