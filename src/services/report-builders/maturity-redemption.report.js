import { Customer, Redemption, Scheme } from "../../models/index.js";
import { moneyRef, weightRef } from "../../lib/money.js";
import { dateMatch } from "../../lib/query-filters.js";
import { paginate } from "../../lib/pagination.js";
import {
  baseEnvelope,
  branchNameMap,
  buildCurrencyTrendPoints,
  reportDataScope,
  reportTrendGroupBy,
} from "./report-envelope.js";
import { redemptionPeriodSummary } from "../redemption-period-summary.js";
import {
  resolveCalculatedBenefitPaise,
  resolveIncludedBenefitPaise,
} from "../../lib/redemption-benefit-accounting.js";

const MODE_LABEL = {
  CASH: "Cash",
  GOLD_HANDOVER: "Jewellery",
  PURCHASE_ADJUSTMENT: "Purchase adjustment",
};

const CLOSURE_LABEL = {
  MATURITY_REDEMPTION: "Maturity",
  PREMATURE_CLOSURE: "Premature",
};

const COLUMNS = [
  { key: "schemeNumber", label: "Scheme", type: "text", sticky: true },
  { key: "customer", label: "Customer", type: "customer" },
  { key: "branch", label: "Showroom", type: "text" },
  { key: "closureType", label: "Type", type: "text" },
  { key: "settledAmount", label: "Settled", type: "currency", align: "right", emphasis: true },
  { key: "goldWeight", label: "Gold (g)", type: "weight", align: "right" },
  {
    key: "goldHandoverValue",
    label: "Gold value (₹)",
    type: "currency",
    align: "right",
  },
  { key: "benefitPaid", label: "Benefit", type: "currency", align: "right" },
  { key: "penalty", label: "Penalty", type: "currency", align: "right" },
  { key: "mode", label: "Mode", type: "text" },
  { key: "settledAt", label: "Settled on", type: "date" },
];

export async function buildMaturityRedemptionReport(req) {
  const envelope = baseEnvelope(req, "MATURITY_REDEMPTION", "Maturity & redemption");
  const { from, to } = envelope.period;

  const scope = reportDataScope(req);
  const page = await paginate(Redemption, {
    scope,
    filters: {
      status: "COMPLETED",
      ...dateMatch("completedAt", { from, to }),
    },
    cursor: req.query.cursor,
    limit: req.query.limit ?? 50,
    sort: "completedAt:desc",
  });

  const schemeIds = [...new Set(page.data.map((r) => r.schemeId))];
  const customerIds = [...new Set(page.data.map((r) => r.customerId))];
  const branchIds = [...new Set(page.data.map((r) => r.branchId).filter(Boolean))];

  const [schemes, customers, branchNames, periodTotals, byMode, byWeek] = await Promise.all([
    Scheme.find({ _id: { $in: schemeIds } }).select("_id enrollmentNumber").lean(),
    Customer.find({ _id: { $in: customerIds } }).select("_id name").lean(),
    branchNameMap(req.auth.tenantId, branchIds),
    redemptionPeriodSummary(scope, { from, to }),
    Redemption.aggregate([
      {
        $match: {
          ...scope,
          status: "COMPLETED",
          ...dateMatch("completedAt", { from, to }),
        },
      },
      {
        $group: {
          _id: "$mode",
          amountPaise: {
            $sum: {
              $add: [
                {
                  $ifNull: [
                    "$cashOutPaise",
                    {
                      $cond: [
                        { $eq: ["$mode", "GOLD_HANDOVER"] },
                        0,
                        { $ifNull: ["$settlementPaise", 0] },
                      ],
                    },
                  ],
                },
                { $ifNull: ["$handoverValuePaise", 0] },
              ],
            },
          },
        },
      },
    ]),
    Redemption.aggregate([
      {
        $match: {
          ...scope,
          status: "COMPLETED",
          ...dateMatch("completedAt", { from, to }),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$completedAt", timezone: "Asia/Kolkata" },
          },
          amountPaise: {
            $sum: {
              $add: [
                {
                  $ifNull: [
                    "$cashOutPaise",
                    {
                      $cond: [
                        { $eq: ["$mode", "GOLD_HANDOVER"] },
                        0,
                        { $ifNull: ["$settlementPaise", 0] },
                      ],
                    },
                  ],
                },
                { $ifNull: ["$handoverValuePaise", 0] },
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const schemeMap = new Map(schemes.map((s) => [s._id, s]));
  const customerMap = new Map(customers.map((c) => [c._id, c]));
  const totals = periodTotals;

  const groupBy = reportTrendGroupBy(from, to, req.query);
  const settlementTrend = buildCurrencyTrendPoints(byWeek, from, to, groupBy);

  const rows = page.data.map((red) => {
    const scheme = schemeMap.get(red.schemeId);
    const customer = customerMap.get(red.customerId);
    return {
      key: red._id,
      schemeNumber: scheme?.enrollmentNumber ?? red.schemeId,
      customer: customer ? { id: customer._id, name: customer.name } : { name: "—" },
      branch: branchNames.get(red.branchId) ?? "—",
      closureType: CLOSURE_LABEL[red.closureType] ?? red.closureType ?? "—",
      settledAmount: moneyRef(
        red.mode === "GOLD_HANDOVER"
          ? (red.handoverValuePaise ?? red.settlementPaise ?? 0)
          : (red.cashOutPaise ?? red.settlementPaise ?? 0),
      ),
      goldWeight:
        red.mode === "GOLD_HANDOVER" && red.weightMg
          ? weightRef(red.weightMg)
          : null,
      goldHandoverValue:
        red.mode === "GOLD_HANDOVER"
          ? moneyRef(red.handoverValuePaise ?? red.settlementPaise ?? 0)
          : null,
      benefitPaid: moneyRef(resolveIncludedBenefitPaise(red)),
      calculatedBenefitPaise: resolveCalculatedBenefitPaise(red),
      benefitExcludedFromPayout:
        resolveCalculatedBenefitPaise(red) > 0
        && resolveIncludedBenefitPaise(red) === 0,
      penalty: moneyRef(red.penaltyPaise ?? 0),
      mode: MODE_LABEL[red.mode] ?? red.mode,
      settledAt: red.completedAt ? new Date(red.completedAt).toISOString().slice(0, 10) : null,
      drilldownPath: `/redemptions/${red._id}`,
    };
  });

  return {
    ...envelope,
    summary: [
      {
        key: "COMPLETED",
        label: "Completions",
        value: String(totals.count),
        valueType: "count",
      },
      {
        key: "MATURITY_COUNT",
        label: "Maturity redemptions",
        value: String(totals.maturityRedemptions.count),
        valueType: "count",
      },
      {
        key: "PREMATURE_COUNT",
        label: "Premature closures",
        value: String(totals.prematureClosures.count),
        valueType: "count",
      },
      {
        key: "TOTAL_SETTLED",
        label: "Total handed out",
        value: moneyRef(totals.settlementPaise),
        valueType: "currency",
      },
      {
        key: "CASH_HANDED",
        label: "Cash payouts",
        value: moneyRef(totals.cashSettlementPaise),
        valueType: "currency",
      },
      {
        key: "BENEFIT_PAID",
        label: "Benefits paid",
        value: moneyRef(totals.benefitPaise),
        valueType: "currency",
      },
      {
        key: "PENALTY",
        label: "Premature penalties",
        value: moneyRef(totals.penaltyPaise),
        valueType: "currency",
      },
      {
        key: "GOLD_HANDED",
        label: "Gold weight handed",
        value: weightRef(totals.goldWeightMg || totals.weightMg),
        valueType: "weight",
      },
      {
        key: "GOLD_HANDOVER_VALUE",
        label: "Gold handover value",
        value: moneyRef(totals.goldHandoverValuePaise ?? 0),
        valueType: "currency",
        note:
          (totals.goldWeightMg ?? 0) > 0
            ? `${((totals.goldWeightMg ?? 0) / 1000).toFixed(3)} g at handover-day rate`
            : undefined,
      },
    ],
    charts: {
      settlementTrend: {
        chartType: "line",
        title: "Settlements",
        subtitle: `Grouped by ${groupBy.toLowerCase()}`,
        yAxis: { type: "currency", label: "Amount" },
        series: [
          {
            key: "SETTLED",
            name: "Settled",
            data: settlementTrend,
          },
        ],
      },
      byMode: {
        chartType: "donut",
        title: "Settlement mode",
        yAxis: { type: "currency", label: "Amount" },
        series: [
          {
            key: "mode",
            name: "Amount",
            data: byMode.map((row) => ({
              x: MODE_LABEL[row._id] ?? row._id,
              y: row.amountPaise,
              yDisplay: moneyRef(row.amountPaise).amountDisplay,
              modeKey: row._id,
            })),
          },
        ],
      },
    },
    columns: COLUMNS,
    rows,
    meta: page.meta,
  };
}
