import { Payment } from "../../models/index.js";
import { PAYMENT_MODE_LABELS, PAYMENT_MODE_ORDER } from "../../constants/enums.js";
import { moneyRef, weightRef } from "../../lib/money.js";
import { collectionSummary } from "../collection-summary.js";
import {
  baseEnvelope,
  branchNameMap,
  chartPointCurrency,
  dateMatch,
  paginateRows,
  reportDataScope,
  schemeIdsForPlan,
} from "./report-envelope.js";

const MODE_ROW_KEY = {
  CASH: "cash",
  UPI: "upi",
  CARD: "card",
  BANK_TRANSFER: "bankTransfer",
  CHEQUE: "cheque",
  ONLINE_GATEWAY: "onlineGateway",
  LEGACY_ONLINE: "onlineGateway",
};

const COLLECTION_COLUMNS = [
  { key: "label", label: "Showroom", type: "text", sortable: true, sticky: true },
  { key: "paymentCount", label: "Payments", type: "count", sortable: true, align: "right" },
  { key: "cash", label: "Cash", type: "currency", sortable: true, align: "right" },
  { key: "upi", label: "UPI", type: "currency", sortable: true, align: "right" },
  { key: "card", label: "Card / POS", type: "currency", align: "right" },
  { key: "bankTransfer", label: "Bank transfer", type: "currency", align: "right" },
  { key: "cheque", label: "Cheque", type: "currency", align: "right" },
  { key: "onlineGateway", label: "Online payment", type: "currency", align: "right" },
  { key: "total", label: "Total", type: "currency", sortable: true, align: "right", emphasis: true },
  { key: "goldCredited", label: "Gold credited", type: "weight", align: "right" },
];

function emptyModeRow() {
  return {
    cash: moneyRef(0),
    upi: moneyRef(0),
    card: moneyRef(0),
    bankTransfer: moneyRef(0),
    cheque: moneyRef(0),
    onlineGateway: moneyRef(0),
    total: moneyRef(0),
    paymentCount: 0,
    goldCredited: weightRef(0),
  };
}

export async function buildCollectionReport(req) {
  const envelopeBase = baseEnvelope(req, "COLLECTION", "Collection report");
  const { from, to } = envelopeBase.period;
  const scope = reportDataScope(req);
  const schemeIds = await schemeIdsForPlan(scope, req.query.planId);
  const match = {
    ...scope,
    status: "SUCCESS",
    ...dateMatch("paidAt", { from, to }),
    ...(schemeIds ? { schemeId: { $in: schemeIds } } : {}),
  };

  const [summaryRaw, byBranchMode, byDay, totalWeight] = await Promise.all([
    collectionSummary({ ...req, scope, query: { ...req.query, from, to } }),
    Payment.aggregate([
      { $match: match },
      {
        $group: {
          _id: { branchId: "$branchId", mode: "$mode" },
          amountPaise: { $sum: "$amountPaise" },
          count: { $sum: 1 },
          weightMg: { $sum: { $ifNull: ["$weightMg", 0] } },
        },
      },
    ]),
    Payment.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "Asia/Kolkata" },
          },
          amountPaise: { $sum: "$amountPaise" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Payment.aggregate([
      { $match: match },
      { $group: { _id: null, weightMg: { $sum: { $ifNull: ["$weightMg", 0] } } } },
    ]),
  ]);

  const branchIds = byBranchMode.map((row) => row._id.branchId).filter(Boolean);
  const names = await branchNameMap(req.auth.tenantId, branchIds);

  const branchRows = new Map();
  for (const row of byBranchMode) {
    const branchId = row._id.branchId ?? "unknown";
    if (!branchRows.has(branchId)) {
      branchRows.set(branchId, { ...emptyModeRow(), key: branchId, label: names.get(branchId) ?? branchId });
    }
    const entry = branchRows.get(branchId);
    const modeKey = MODE_ROW_KEY[row._id.mode] ?? "onlineGateway";
    entry[modeKey] = moneyRef((entry[modeKey]?.amountPaise ?? 0) + row.amountPaise);
    entry.paymentCount += row.count;
    entry.total = moneyRef(entry.total.amountPaise + row.amountPaise);
    entry.goldCredited = weightRef(entry.goldCredited.weightMg + row.weightMg);
  }

  const tableRows = [...branchRows.values()]
    .map((row) => ({
      ...row,
      drilldownPath: `/payments?branchId=${row.key}&from=${from}&to=${to}`,
    }))
    .sort((a, b) => b.total.amountPaise - a.total.amountPaise);

  const totalPaise = summaryRaw.amountPaise ?? 0;
  const count = summaryRaw.count ?? 0;
  const cashPaise = summaryRaw.byMode?.find((m) => m.mode === "CASH")?.amountPaise ?? 0;
  const goldMg = totalWeight[0]?.weightMg ?? 0;

  const totalsRow = tableRows.reduce(
    (acc, row) => {
      acc.paymentCount += row.paymentCount;
      for (const key of ["cash", "upi", "card", "bankTransfer", "cheque", "onlineGateway", "total"]) {
        acc[key] = moneyRef(acc[key].amountPaise + row[key].amountPaise);
      }
      acc.goldCredited = weightRef(acc.goldCredited.weightMg + row.goldCredited.weightMg);
      return acc;
    },
    { label: "Total", ...emptyModeRow() },
  );

  const stackedModes = PAYMENT_MODE_ORDER.filter((mode) => mode !== "LEGACY_ONLINE" || byBranchMode.some((r) => r._id.mode === mode));

  const envelope = {
    ...envelopeBase,
    summary: [
      { key: "TOTAL_COLLECTED", label: "Total collected", value: moneyRef(totalPaise), valueType: "currency" },
      { key: "PAYMENT_COUNT", label: "Payments", value: count, valueType: "count" },
      {
        key: "AVERAGE_PAYMENT",
        label: "Average payment",
        value: moneyRef(count ? Math.round(totalPaise / count) : 0),
        valueType: "currency",
      },
      { key: "GOLD_CREDITED", label: "Gold credited", value: weightRef(goldMg), valueType: "weight" },
      {
        key: "CASH_SHARE",
        label: "Cash share",
        value: totalPaise ? Math.round((cashPaise / totalPaise) * 1000) / 10 : 0,
        valueType: "percent",
      },
    ],
    charts: {
      trend: {
        chartType: "line",
        title: "Daily collection",
        yAxis: { type: "currency", label: "Amount" },
        series: [
          {
            key: "COLLECTED",
            name: "Collected",
            data: byDay.map((row) => chartPointCurrency(row._id, row.amountPaise)),
          },
        ],
      },
      byMode: {
        chartType: "donut",
        title: "By payment mode",
        yAxis: { type: "currency", label: "Amount" },
        series: [
          {
            key: "mode",
            name: "Amount",
            data: (summaryRaw.byMode ?? []).map((row) => ({
              x: row.label ?? PAYMENT_MODE_LABELS[row.mode] ?? row.mode,
              y: row.amountPaise,
              yDisplay: moneyRef(row.amountPaise).amountDisplay,
              modeKey: row.mode,
            })),
          },
        ],
        drilldown: { enabled: true, path: "/payments", paramKey: "mode", paramSource: "modeKey" },
      },
      byBranch: {
        chartType: "stackedBar",
        title: "By showroom and mode",
        yAxis: { type: "currency", label: "Amount" },
        series: stackedModes.map((mode) => ({
          key: mode,
          name: PAYMENT_MODE_LABELS[mode] ?? mode,
          data: tableRows.map((branch) => {
            const field = MODE_ROW_KEY[mode];
            const ref = branch[field] ?? moneyRef(0);
            return { x: branch.label, y: ref.amountPaise, yDisplay: ref.amountDisplay };
          }),
        })),
      },
    },
    columns: COLLECTION_COLUMNS,
    totalsRow: tableRows.length ? totalsRow : { label: "Total", ...emptyModeRow(), paymentCount: count, total: moneyRef(totalPaise), goldCredited: weightRef(goldMg) },
  };

  const { rows, meta } = paginateRows(tableRows, req.query);
  return { ...envelope, rows, meta };
}
