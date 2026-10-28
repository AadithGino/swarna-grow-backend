/**
 * Sidekick agent tools: Gemini function declarations + executors.
 *
 * Every executor is read-only and runs under the caller's tenant/branch scope.
 * Results are stored per turn under a resultId; the model sees a compact view and
 * the UI renders the full result, so numbers on screen always come from the server.
 */
import { AppError } from "../../../lib/app-error.js";
import { escaped } from "../../../lib/query-filters.js";
import { buildAdminReport } from "../../report-builders/index.js";
import { assertReportRange } from "../../report-builders/report-envelope.js";
import { bundleFromReport } from "../response-bundle.js";
import {
  bundlePayloadFromCollectionDaily,
  runCollectionDailyAssistant,
} from "../collection-daily-assistant.service.js";
import { REPORT_KEYS } from "../schema-registry.js";
import {
  Branch,
  Customer,
  DigitalMetalWallet,
  EcommerceOrder,
  Payment,
  Scheme,
} from "../../../models/index.js";
import { PaymentMode, SchemeStatus } from "../../../constants/enums.js";
import { NET_COLLECTION_PAYMENT_STATUSES } from "../../../lib/payment-net-aggregation.js";
import { ENTITY_NAMES } from "./semantic-layer.js";
import { MODEL_ROW_CAP, QuerySpecError, runDataQuery } from "./query-data.js";
import {
  gramsFromMgDisplay,
  gramsFromUgDisplay,
  humanizeEnum,
  istDateDisplay,
  istDateTimeDisplay,
  maskMobile,
  presentValue,
  rupeesDisplay,
} from "./format.js";
import { searchHelp } from "./help-articles.js";

const FILTER_OPS = ["eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "between", "contains", "startsWith", "exists"];

const REPORT_GUIDE =
  "COLLECTION (period collections, net of refunds, by branch and mode), OUTSTANDING (dues & ageing), DEFAULTER (overdue customers & recovery), ENROLMENT (new enrolments), STAFF_PERFORMANCE, BRANCH_PERFORMANCE, SCHEME_PERFORMANCE (by plan), CUSTOMER_PERFORMANCE, MATURITY_REDEMPTION, GOLD_ACCRUAL (gold liability), CASH_HANDOVER, SCHEME_REGISTER, REMINDER_DELIVERY, ECOMMERCE_SALES, ECOMMERCE_ORDERS_FULFILMENT, ECOMMERCE_PRODUCTS, CUSTOMER_LEDGER (needs customerId)";

const purposeProp = {
  type: "string",
  description: "Short status line shown to the owner while this runs, in their language, e.g. 'Finding the latest UPI payment'.",
};

export const TOOL_DECLARATIONS = [
  {
    name: "query_data",
    description:
      "Query the shop's live data (entities and fields listed under DATA). List mode (no groupBy/timeBucket/metrics) returns matching rows. Aggregate mode (groupBy and/or timeBucket and/or metrics) returns grouped totals plus grand totals. Money in filters is rupees, weights are grams, dates are YYYY-MM-DD in IST.",
    parameters: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ENTITY_NAMES },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "field or related field, e.g. mode, amount, customer.name" },
              op: { type: "string", enum: FILTER_OPS },
              value: { type: "string" },
              values: { type: "array", items: { type: "string" }, description: "for in / nin" },
              valueTo: { type: "string", description: "upper bound for between" },
            },
            required: ["field", "op"],
          },
        },
        dateFrom: { type: "string", description: "YYYY-MM-DD inclusive; omit for all time" },
        dateTo: { type: "string", description: "YYYY-MM-DD inclusive" },
        dateField: { type: "string", description: "which date field the range applies to (defaults to the entity's date field)" },
        groupBy: { type: "array", items: { type: "string" }, description: "up to 2, e.g. ['mode'], ['customer'], ['branch'], ['scheme.planName']" },
        timeBucket: { type: "string", enum: ["day", "week", "month", "year"] },
        metrics: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fn: { type: "string", enum: ["count", "sum", "avg", "min", "max", "countDistinct"] },
              field: { type: "string" },
            },
            required: ["fn"],
          },
        },
        select: { type: "array", items: { type: "string" }, description: "list mode columns (defaults are sensible)" },
        sort: {
          type: "object",
          properties: { by: { type: "string", description: "field, metric alias (sum_amount, count…) or period" }, dir: { type: "string", enum: ["asc", "desc"] } },
          required: ["by"],
        },
        limit: { type: "integer", description: "rows or groups to return (list default 20)" },
        compareToPrevious: { type: "boolean", description: "also return totals for the previous comparable period with % change" },
        purpose: purposeProp,
      },
      required: ["entity", "purpose"],
    },
  },
  {
    name: "run_report",
    description: `Run a standard Swarna Grow report (same numbers as the Reports screen). Reports: ${REPORT_GUIDE}.`,
    parameters: {
      type: "object",
      properties: {
        reportKey: { type: "string", enum: [...REPORT_KEYS] },
        dateFrom: { type: "string", description: "YYYY-MM-DD" },
        dateTo: { type: "string", description: "YYYY-MM-DD" },
        branchId: { type: "string" },
        planId: { type: "string" },
        customerId: { type: "string", description: "only for CUSTOMER_LEDGER" },
        purpose: purposeProp,
      },
      required: ["reportKey", "purpose"],
    },
  },
  {
    name: "collection_trend",
    description:
      "Day-by-day scheme collections for a date range, net of refunds and corrections (matches Reports). Pass modes (2+) to compare payment modes side by side, e.g. ['CASH','UPI'].",
    parameters: {
      type: "object",
      properties: {
        dateFrom: { type: "string", description: "YYYY-MM-DD" },
        dateTo: { type: "string", description: "YYYY-MM-DD" },
        modes: { type: "array", items: { type: "string", enum: Object.values(PaymentMode) } },
        metric: { type: "string", enum: ["net_collected", "gross_receipts"] },
        branchId: { type: "string" },
        planId: { type: "string" },
        purpose: purposeProp,
      },
      required: ["dateFrom", "dateTo", "purpose"],
    },
  },
  {
    name: "find_customer",
    description: "Find customers by name, mobile number (full or last digits), customer number or passbook number. Use before customer_overview or customer-specific filters.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        purpose: purposeProp,
      },
      required: ["query", "purpose"],
    },
  },
  {
    name: "customer_overview",
    description: "Everything about one customer: profile, every scheme enrolment with paid/overdue instalments and amount paid, recent payments, Digi Gold holdings and store orders.",
    parameters: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        purpose: purposeProp,
      },
      required: ["customerId", "purpose"],
    },
  },
  {
    name: "help_articles",
    description: "How-to help for using Swarna Grow (where to add customers, record payments, create plans, set gold rate, redemptions, reminders, Digi Gold, store, staff, reports).",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, purpose: purposeProp },
      required: ["query"],
    },
  },
  {
    name: "final_answer",
    description: "Send the answer to the owner. Call this alone, after any data tools have returned.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "≤ 7 words naming what the answer covers" },
        answer: { type: "string", description: "1–4 short sentences in the owner's language; **bold** and '- ' bullets allowed" },
        blocks: {
          type: "array",
          description: "visuals built from tool results",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["stats", "chart", "table"] },
              resultId: { type: "string" },
              chartType: { type: "string", enum: ["bar", "line", "donut"] },
              title: { type: "string" },
            },
            required: ["type", "resultId"],
          },
        },
        followUps: { type: "array", items: { type: "string" }, description: "2–3 short next questions in the owner's language" },
        needsClarification: { type: "boolean", description: "true when you are asking the owner to choose/clarify" },
      },
      required: ["answer"],
    },
  },
];

export const DATA_TOOL_NAMES = new Set(["query_data", "run_report", "collection_trend", "find_customer", "customer_overview"]);

/* ----------------------------------------------------------------------------- */

function truncateRows(rows, cap = MODEL_ROW_CAP) {
  return rows.length > cap ? rows.slice(0, cap) : rows;
}

function cellToModel(val) {
  if (val == null) return null;
  if (typeof val === "object") {
    if (val.cell === "customer") return val.mobile ? `${val.name} (${maskMobile(val.mobile)})` : val.name;
    if (val.cell === "staff") return val.name;
    if (val.display != null) return val.display;
    if (val.amountDisplay != null) return val.amountDisplay;
    if (val.amountPaise != null) return rupeesDisplay(val.amountPaise);
    if (val.name != null) return val.name;
    if (val.label != null) return val.label;
    return null;
  }
  return val;
}

function tableRowsForModel(table, cap = 15) {
  if (!table?.columns?.length) return [];
  const cols = table.columns.filter((c) => c.key !== "drilldownPath");
  return (table.rows ?? []).slice(0, cap).map((row) => {
    const out = {};
    for (const c of cols) {
      const v = cellToModel(row[c.key]);
      if (v !== null && v !== undefined && v !== "") out[c.label ?? c.key] = v;
    }
    return out;
  });
}

function statCardsForModel(cards = []) {
  return cards.map((c) => {
    let display;
    if (c.valueType === "currency") display = rupeesDisplay(c.value);
    else if (c.valueType === "weight") display = gramsFromMgDisplay(c.value);
    else if (c.valueType === "percent") display = `${c.value}%`;
    else display = Number(c.value ?? 0).toLocaleString("en-IN");
    return { label: c.label, value: display, ...(c.delta != null ? { changePct: c.delta } : {}) };
  });
}

function highlightRows(result) {
  if (result.mode !== "aggregate" || result.uiRows.length < 3) return null;
  const metricCol = result.columns.find((c) => c.type === "currency" || c.type === "count" || c.type === "weight");
  if (!metricCol) return null;
  const numeric = (v) => (typeof v === "object" && v != null ? Number(v.value ?? 0) : Number(v ?? 0));
  let maxIdx = 0;
  let minIdx = 0;
  result.uiRows.forEach((row, i) => {
    if (numeric(row[metricCol.key]) > numeric(result.uiRows[maxIdx][metricCol.key])) maxIdx = i;
    if (numeric(row[metricCol.key]) < numeric(result.uiRows[minIdx][metricCol.key])) minIdx = i;
  });
  return { by: metricCol.key, highest: result.modelRows[maxIdx], lowest: result.modelRows[minIdx] };
}

/* ---------------------------------- query_data -------------------------------- */

async function execQueryData(args, ctx) {
  const { purpose, ...spec } = args ?? {};
  const result = await runDataQuery(spec, ctx.scope);
  const id = ctx.nextId();
  const title = [result.meta.entityLabel, result.meta.dateRangeLabel].filter(Boolean).join(" · ");
  const modelRowCap = result.mode === "aggregate" && result.meta.timeBucket ? 40 : MODEL_ROW_CAP;
  const forModel = {
    resultId: id,
    entity: result.meta.entity,
    mode: result.mode,
    dateRange: result.meta.dateRangeLabel ?? "all time",
    filters: result.meta.filterSummary || "none",
    ...(result.mode === "list"
      ? { totalMatching: result.totalMatching, returned: result.uiRows.length }
      : {
          groups: result.groupCount,
          totals: Object.fromEntries(result.totals.map((t) => [t.key, t.display])),
        }),
    ...(result.previous
      ? {
          previousPeriod: {
            range: result.previous.rangeLabel,
            totals: Object.fromEntries(
              result.previous.totals.map((t) => [t.key, { value: t.display, changePct: t.changePct }]),
            ),
          },
        }
      : {}),
    rows: truncateRows(result.modelRows, modelRowCap),
    ...(result.modelRows.length > modelRowCap ? { rowsNote: `showing ${modelRowCap} of ${result.modelRows.length} rows` } : {}),
    ...(highlightRows(result) ? { highlights: highlightRows(result) } : {}),
    ...(result.truncated ? { truncated: true } : {}),
  };
  ctx.results.set(id, {
    id,
    tool: "query_data",
    kind: "data",
    title,
    purpose,
    data: result,
    exportAction: { kind: "dataQuery", spec: result.spec },
  });
  const count = result.mode === "list" ? result.totalMatching : result.groupCount;
  return {
    resultId: id,
    forModel,
    detail:
      result.mode === "list"
        ? `${count.toLocaleString("en-IN")} ${count === 1 ? "record" : "records"} found`
        : `${count} ${count === 1 ? "group" : "groups"}`,
  };
}

/* ---------------------------------- run_report -------------------------------- */

function reportRequest(req, args) {
  const query = { ...(req.query ?? {}) };
  delete query.cursor;
  if (args.dateFrom) query.from = args.dateFrom;
  if (args.dateTo) query.to = args.dateTo;
  if (args.dateFrom || args.dateTo) query.period = "CUSTOM";
  else query.period = "THIS_MONTH";
  if (args.branchId) query.branchId = String(args.branchId);
  if (args.planId) query.planId = String(args.planId);
  if (args.customerId) query.customerId = String(args.customerId);
  assertReportRange(query);
  return { ...req, query };
}

async function execRunReport(args, ctx) {
  const reportKey = String(args?.reportKey ?? "").toUpperCase();
  if (!REPORT_KEYS.includes(reportKey)) {
    throw new QuerySpecError(`Unknown report ${args?.reportKey}.`, `Reports: ${REPORT_KEYS.join(", ")}`);
  }
  if (reportKey === "CUSTOMER_LEDGER" && !args.customerId) {
    throw new QuerySpecError("CUSTOMER_LEDGER needs customerId.", "Call find_customer first, or use customer_overview.");
  }
  const rreq = reportRequest(ctx.req, args);
  const report = await buildAdminReport(rreq, reportKey);
  if (!report) throw new QuerySpecError(`Report ${reportKey} is not available.`);
  const action = {
    kind: "report",
    reportKey,
    filters: {
      period: rreq.query.period,
      ...(rreq.query.from ? { from: rreq.query.from } : {}),
      ...(rreq.query.to ? { to: rreq.query.to } : {}),
      ...(args.branchId ? { branchId: String(args.branchId) } : {}),
      ...(args.planId ? { planId: String(args.planId) } : {}),
    },
  };
  const bundle = bundleFromReport(report, action);
  const id = ctx.nextId();
  const title = bundle.summaryText;
  ctx.results.set(id, {
    id,
    tool: "run_report",
    kind: "report",
    title,
    purpose: args.purpose,
    bundle,
    exportAction: action,
  });
  const rows = bundle.table?.rows ?? [];
  return {
    resultId: id,
    forModel: {
      resultId: id,
      report: reportKey,
      title,
      period: report?.period?.label ?? null,
      summary: statCardsForModel(report?.summary?.map((s) => ({
        label: s.label,
        value: typeof s.value === "object" ? (s.value?.amountPaise ?? s.value?.weightMg ?? 0) : s.value,
        valueType: s.valueType,
        delta: s.change?.percent,
      })) ?? []),
      columns: (bundle.table?.columns ?? []).map((c) => c.label),
      rows: tableRowsForModel(bundle.table, 15),
      rowCount: rows.length,
      ...(report?.page?.hasMore ? { moreRowsAvailable: true } : {}),
    },
    detail: report?.period?.label ? `${report.title ?? reportKey} · ${report.period.label}` : report?.title ?? reportKey,
  };
}

/* ------------------------------- collection_trend ----------------------------- */

async function execCollectionTrend(args, ctx) {
  const modes = [...new Set((args?.modes ?? []).map((m) => String(m).toUpperCase()))].filter((m) =>
    Object.values(PaymentMode).includes(m),
  );
  if (modes.length === 1) {
    // One mode isn't a comparison — a per-day query on that mode answers it exactly.
    return execQueryData(
      {
        entity: "payments",
        filters: [{ field: "mode", op: "eq", value: modes[0] }],
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        timeBucket: "day",
        metrics: [{ fn: "sum", field: "amount" }, { fn: "count" }],
        purpose: args.purpose,
      },
      ctx,
    );
  }
  const action = {
    kind: "collectionDaily",
    filters: {
      from: args.dateFrom,
      to: args.dateTo,
      ...(args.branchId ? { branchId: String(args.branchId) } : {}),
      ...(args.planId ? { planId: String(args.planId) } : {}),
    },
    analytics: {
      operation: modes.length >= 2 ? "comparison" : "trend",
      metric: args.metric === "gross_receipts" ? "gross_receipts" : "net_collected",
      timeGrain: "day",
      dimensions: modes.length >= 2 ? ["day", "mode"] : ["day"],
      compareModes: modes.length >= 2 ? modes : null,
      sort: "chronological",
    },
  };
  const result = await runCollectionDailyAssistant(ctx.req, action);
  const bundle = { narrative: null, ...bundlePayloadFromCollectionDaily(result, action) };
  const id = ctx.nextId();
  ctx.results.set(id, {
    id,
    tool: "collection_trend",
    kind: "collection",
    title: bundle.summaryText,
    purpose: args.purpose,
    bundle,
    exportAction: action,
  });
  const nonZeroDays = (bundle.table?.rows ?? []).filter((row) =>
    Object.values(row).some((v) => v && typeof v === "object" && Number(v.amountPaise ?? 0) > 0),
  );
  return {
    resultId: id,
    forModel: {
      resultId: id,
      period: result.periodLabel,
      totals: statCardsForModel(bundle.statCards),
      days: (bundle.table?.rows ?? []).length,
      daysWithCollections: nonZeroDays.length,
      rows: tableRowsForModel(bundle.table, 62),
    },
    detail: result.periodLabel ?? `${args.dateFrom} – ${args.dateTo}`,
  };
}

/* --------------------------------- customers ---------------------------------- */

function customerScope(scope) {
  return { tenantId: scope.tenantId, ...(scope.branchId ? { branchId: scope.branchId } : {}) };
}

async function execFindCustomer(args, ctx) {
  const q = String(args?.query ?? "").trim().slice(0, 80);
  if (q.length < 2) throw new QuerySpecError("Give at least 2 characters to search for.");
  const digits = q.replace(/\D/g, "");
  const or = [
    { name: { $regex: escaped(q), $options: "i" } },
    { customerNumber: { $regex: `^${escaped(q)}`, $options: "i" } },
    { passbookNumber: { $regex: `^${escaped(q)}`, $options: "i" } },
  ];
  if (digits.length >= 4) or.push({ mobile: { $regex: `${escaped(digits)}$` } });
  const customers = await Customer.find(
    { ...customerScope(ctx.scope), $or: or },
    { name: 1, mobile: 1, customerNumber: 1, status: 1, branchId: 1, createdAt: 1 },
  )
    .sort({ createdAt: -1 })
    .limit(8)
    .lean()
    .maxTimeMS(10_000);
  const ids = customers.map((c) => c._id);
  const branchIds = [...new Set(customers.map((c) => c.branchId).filter(Boolean))];
  const [schemeCounts, branches] = await Promise.all([
    ids.length
      ? Scheme.aggregate([
          { $match: { tenantId: ctx.scope.tenantId, customerId: { $in: ids } } },
          { $group: { _id: "$customerId", total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ["$status", SchemeStatus.ACTIVE] }, 1, 0] } } } },
        ])
      : [],
    branchIds.length ? Branch.find({ tenantId: ctx.scope.tenantId, _id: { $in: branchIds } }, { name: 1 }).lean() : [],
  ]);
  const countBy = new Map(schemeCounts.map((s) => [s._id, s]));
  const branchBy = new Map(branches.map((b) => [b._id, b.name]));
  const id = ctx.nextId();
  const columns = [
    { key: "customerNumber", label: "Customer no.", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "mobile", label: "Mobile", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "branch", label: "Branch", type: "text" },
    { key: "activeSchemes", label: "Active schemes", type: "count" },
  ];
  const uiRows = customers.map((c) => ({
    id: c._id,
    customerNumber: c.customerNumber,
    name: c.name,
    mobile: c.mobile,
    status: humanizeEnum(c.status),
    branch: branchBy.get(c.branchId) ?? "—",
    activeSchemes: countBy.get(c._id)?.active ?? 0,
  }));
  ctx.results.set(id, {
    id,
    tool: "find_customer",
    kind: "table",
    title: `Customers matching “${q}”`,
    purpose: args.purpose,
    table: { columns, rows: uiRows },
  });
  return {
    resultId: id,
    forModel: {
      resultId: id,
      matches: customers.length,
      customers: customers.map((c) => ({
        customerId: c._id,
        name: c.name,
        customerNumber: c.customerNumber,
        mobile: maskMobile(c.mobile),
        status: c.status,
        branch: branchBy.get(c.branchId) ?? null,
        activeSchemes: countBy.get(c._id)?.active ?? 0,
        totalSchemes: countBy.get(c._id)?.total ?? 0,
        joined: istDateDisplay(c.createdAt),
      })),
    },
    detail: `${customers.length} ${customers.length === 1 ? "match" : "matches"}`,
  };
}

async function execCustomerOverview(args, ctx) {
  const customerId = String(args?.customerId ?? "").trim();
  if (!customerId) throw new QuerySpecError("customerId is required.", "Call find_customer first.");
  const customer = await Customer.findOne(
    { ...customerScope(ctx.scope), _id: customerId },
    { name: 1, mobile: 1, customerNumber: 1, passbookNumber: 1, status: 1, branchId: 1, createdAt: 1, "kyc.status": 1, passwordSetAt: 1 },
  ).lean();
  if (!customer) {
    throw new QuerySpecError(`No customer ${customerId} in your access.`, "Use find_customer to get a valid customerId.");
  }
  const tenantId = ctx.scope.tenantId;
  const [schemes, payTotals, recentPayments, wallets, orders, branch] = await Promise.all([
    Scheme.find(
      { tenantId, customerId },
      { enrollmentNumber: 1, "planSnapshot.name": 1, status: 1, startDate: 1, maturityDate: 1, installments: 1, installmentAmountPaise: 1, paymentPattern: 1, valueBasis: 1 },
    )
      .sort({ createdAt: -1 })
      .limit(12)
      .lean(),
    Payment.aggregate([
      { $match: { tenantId, customerId, status: { $in: NET_COLLECTION_PAYMENT_STATUSES } } },
      { $group: { _id: "$schemeId", paid: { $sum: "$amountPaise" }, gold: { $sum: { $ifNull: ["$weightMg", 0] } }, count: { $sum: 1 }, last: { $max: "$paidAt" } } },
    ]),
    Payment.find(
      { tenantId, customerId, status: { $in: NET_COLLECTION_PAYMENT_STATUSES } },
      { receiptNumber: 1, amountPaise: 1, mode: 1, paidAt: 1, schemeId: 1 },
    )
      .sort({ paidAt: -1 })
      .limit(6)
      .lean(),
    DigitalMetalWallet.find({ tenantId, customerId }, { metal: 1, heldUg: 1 }).lean(),
    EcommerceOrder.aggregate([
      { $match: { tenantId, customerId } },
      { $group: { _id: "$status", count: { $sum: 1 }, total: { $sum: "$totalPaise" } } },
    ]),
    customer.branchId ? Branch.findOne({ tenantId, _id: customer.branchId }, { name: 1 }).lean() : null,
  ]);
  const paidBy = new Map(payTotals.map((p) => [p._id, p]));
  const totalPaid = payTotals.reduce((a, p) => a + p.paid, 0);
  const totalGold = payTotals.reduce((a, p) => a + p.gold, 0);
  const overdueTotal = schemes.reduce(
    (a, s) => a + (s.installments ?? []).filter((i) => i.status === "OVERDUE").length,
    0,
  );
  const activeCount = schemes.filter((s) => s.status === SchemeStatus.ACTIVE).length;
  const schemeLabel = new Map(schemes.map((s) => [s._id, s.planSnapshot?.name ?? s.enrollmentNumber]));

  const schemeRows = schemes.map((s) => {
    const inst = s.installments ?? [];
    const p = paidBy.get(s._id);
    return {
      id: s._id,
      enrollmentNumber: s.enrollmentNumber,
      plan: s.planSnapshot?.name ?? "—",
      status: humanizeEnum(s.status),
      startDate: presentValue("ymd", s.startDate).ui,
      maturityDate: presentValue("ymd", s.maturityDate).ui,
      paidInstallments: inst.filter((i) => i.status === "PAID").length,
      overdueInstallments: inst.filter((i) => i.status === "OVERDUE").length,
      amountPaid: presentValue("money", p?.paid ?? 0).ui,
    };
  });
  const paymentRows = recentPayments.map((p) => ({
    id: p._id,
    paidAt: presentValue("datetime", p.paidAt).ui,
    receiptNumber: p.receiptNumber,
    amount: presentValue("money", p.amountPaise).ui,
    mode: humanizeEnum(p.mode),
    plan: schemeLabel.get(p.schemeId) ?? "—",
  }));
  const goldHeld = wallets.filter((w) => w.metal === "GOLD").reduce((a, w) => a + (w.heldUg ?? 0), 0);
  const silverHeld = wallets.filter((w) => w.metal === "SILVER").reduce((a, w) => a + (w.heldUg ?? 0), 0);

  const id = ctx.nextId();
  const statCards = [
    { label: "Total paid", value: totalPaid, valueType: "currency" },
    { label: "Active enrolments", value: activeCount, valueType: "count" },
    { label: "Overdue instalments", value: overdueTotal, valueType: "count" },
    ...(totalGold ? [{ label: "Gold accrued", value: totalGold, valueType: "weight" }] : []),
    ...(goldHeld ? [{ label: "Digi Gold held", value: goldHeld / 1000, valueType: "weight" }] : []),
  ].slice(0, 4);
  ctx.results.set(id, {
    id,
    tool: "customer_overview",
    kind: "customer",
    title: `${customer.name} · ${customer.customerNumber}`,
    purpose: args.purpose,
    statCards,
    tables: [
      {
        title: "Enrolments",
        table: {
          columns: [
            { key: "enrollmentNumber", label: "Enrolment", type: "text" },
            { key: "plan", label: "Plan", type: "text" },
            { key: "status", label: "Status", type: "text" },
            { key: "paidInstallments", label: "Paid", type: "count" },
            { key: "overdueInstallments", label: "Overdue", type: "count" },
            { key: "amountPaid", label: "Amount paid", type: "currency" },
            { key: "maturityDate", label: "Matures", type: "date" },
          ],
          rows: schemeRows,
        },
      },
      {
        title: "Recent payments",
        table: {
          columns: [
            { key: "paidAt", label: "Paid at", type: "datetime" },
            { key: "receiptNumber", label: "Receipt", type: "text" },
            { key: "amount", label: "Amount", type: "currency" },
            { key: "mode", label: "Mode", type: "text" },
            { key: "plan", label: "Plan", type: "text" },
          ],
          rows: paymentRows,
        },
      },
    ],
  });
  const ordersSold = orders.filter((o) => ["PAID", "PROCESSING", "READY_FOR_PICKUP", "SHIPPED", "DELIVERED"].includes(o._id));
  return {
    resultId: id,
    forModel: {
      resultId: id,
      customer: {
        customerId: customer._id,
        name: customer.name,
        customerNumber: customer.customerNumber,
        mobile: maskMobile(customer.mobile),
        status: customer.status,
        kyc: customer.kyc?.status ?? null,
        appActivated: Boolean(customer.passwordSetAt),
        branch: branch?.name ?? null,
        joined: istDateDisplay(customer.createdAt),
      },
      totals: {
        totalPaid: rupeesDisplay(totalPaid),
        activeEnrolments: activeCount,
        overdueInstalments: overdueTotal,
        ...(totalGold ? { goldAccrued: gramsFromMgDisplay(totalGold) } : {}),
      },
      enrolments: schemes.map((s) => {
        const inst = s.installments ?? [];
        const p = paidBy.get(s._id);
        return {
          schemeId: s._id,
          enrollmentNumber: s.enrollmentNumber,
          plan: s.planSnapshot?.name ?? null,
          status: s.status,
          pattern: s.paymentPattern,
          start: istDateDisplay(s.startDate),
          maturity: istDateDisplay(s.maturityDate),
          instalment: s.installmentAmountPaise ? rupeesDisplay(s.installmentAmountPaise) : null,
          paidInstalments: inst.filter((i) => i.status === "PAID").length,
          totalInstalments: inst.length,
          overdueInstalments: inst.filter((i) => i.status === "OVERDUE").length,
          amountPaid: rupeesDisplay(p?.paid ?? 0),
          payments: p?.count ?? 0,
          lastPayment: p?.last ? istDateTimeDisplay(p.last) : null,
        };
      }),
      recentPayments: recentPayments.map((p) => ({
        paidAt: istDateTimeDisplay(p.paidAt),
        receipt: p.receiptNumber,
        amount: rupeesDisplay(p.amountPaise),
        mode: p.mode,
        plan: schemeLabel.get(p.schemeId) ?? null,
      })),
      digiGold: wallets.length
        ? { gold: gramsFromUgDisplay(goldHeld), silver: gramsFromUgDisplay(silverHeld) }
        : null,
      storeOrders: orders.length
        ? {
            orders: orders.reduce((a, o) => a + o.count, 0),
            soldOrders: ordersSold.reduce((a, o) => a + o.count, 0),
            soldValue: rupeesDisplay(ordersSold.reduce((a, o) => a + o.total, 0)),
          }
        : null,
    },
    detail: `${customer.name} · ${schemes.length} ${schemes.length === 1 ? "enrolment" : "enrolments"}`,
  };
}

/* ------------------------------------ help ------------------------------------ */

async function execHelp(args, ctx) {
  const articles = searchHelp(args?.query);
  const id = ctx.nextId();
  ctx.results.set(id, { id, tool: "help_articles", kind: "help", title: "Help", purpose: args?.purpose, articles });
  return {
    resultId: id,
    forModel: { resultId: id, articles: articles.map((a) => ({ title: a.title, howTo: a.body })) },
    detail: articles.length ? articles.map((a) => a.title).join(", ") : "no matching article",
  };
}

const EXECUTORS = {
  query_data: execQueryData,
  run_report: execRunReport,
  collection_trend: execCollectionTrend,
  find_customer: execFindCustomer,
  customer_overview: execCustomerOverview,
  help_articles: execHelp,
};

export const DEFAULT_STEP_LABELS = {
  query_data: "Querying your data",
  run_report: "Running the report",
  collection_trend: "Building the collection trend",
  find_customer: "Looking up the customer",
  customer_overview: "Pulling the customer's full picture",
  help_articles: "Checking the help guide",
};

/**
 * Execute one tool call. Never throws for model mistakes — returns { error } so the model can retry.
 * Scope violations and infrastructure errors are surfaced as tool errors too (with safe messages).
 */
export async function executeTool(name, args, ctx) {
  const exec = EXECUTORS[name];
  if (!exec) {
    return { error: { message: `Unknown tool ${name}.` } };
  }
  try {
    return await exec(args ?? {}, ctx);
  } catch (err) {
    if (err instanceof QuerySpecError) {
      return { error: { message: err.message, ...(err.hint ? { hint: err.hint } : {}) } };
    }
    if (err instanceof AppError) {
      if (err.code === "ASSISTANT_SCOPE") return { error: { message: err.message, scope: true } };
      if (err.statusCode && err.statusCode < 500) return { error: { message: err.message } };
    }
    if (err?.codeName === "MaxTimeMSExpired" || /exceeded time limit/i.test(String(err?.message))) {
      return { error: { message: "That query took too long.", hint: "Narrow the date range or add filters." } };
    }
    ctx.log?.warn?.({ err, tool: name }, "assistant tool failed");
    return { error: { message: "That lookup failed on the server.", hint: "Try a simpler query or a different tool." } };
  }
}
