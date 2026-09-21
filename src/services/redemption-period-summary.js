import { Redemption } from "../models/index.js";
import { dateMatch } from "../lib/query-filters.js";

/** Cash paid out at completion (excludes gold handover). */
function cashOutExpr() {
  return {
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
  };
}

/** Purchase-adjustment credit (not cash payout). */
function purchaseAdjustmentSettlementExpr() {
  return {
    $cond: [
      { $eq: ["$mode", "PURCHASE_ADJUSTMENT"] },
      { $ifNull: ["$settlementPaise", 0] },
      0,
    ],
  };
}

/** Reference rupee value of gold handed over (weight × rate at handover). */
function handoverValueExpr() {
  return {
    $ifNull: [
      "$handoverValuePaise",
      {
        $cond: [
          { $eq: ["$mode", "GOLD_HANDOVER"] },
          { $ifNull: ["$settlementPaise", 0] },
          0,
        ],
      },
    ],
  };
}

/** Aggregates completed redemptions for a date range (IST day bounds on completedAt). */
export async function redemptionPeriodSummary(scope, query = {}) {
  const match = {
    ...scope,
    status: "COMPLETED",
    ...dateMatch("completedAt", query),
  };

  const [totals, byClosure, byMode] = await Promise.all([
    Redemption.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          settlementPaise: { $sum: { $ifNull: ["$settlementPaise", 0] } },
          principalPaise: { $sum: { $ifNull: ["$principalPaise", 0] } },
          benefitPaise: { $sum: { $ifNull: ["$benefitPaise", 0] } },
          penaltyPaise: { $sum: { $ifNull: ["$penaltyPaise", 0] } },
          weightMg: { $sum: { $ifNull: ["$weightMg", 0] } },
          cashOutPaise: { $sum: cashOutExpr() },
          handoverValuePaise: { $sum: handoverValueExpr() },
          purchaseAdjustmentSettlementPaise: { $sum: purchaseAdjustmentSettlementExpr() },
        },
      },
    ]),
    Redemption.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$closureType",
          count: { $sum: 1 },
          settlementPaise: { $sum: { $ifNull: ["$settlementPaise", 0] } },
          penaltyPaise: { $sum: { $ifNull: ["$penaltyPaise", 0] } },
          benefitPaise: { $sum: { $ifNull: ["$benefitPaise", 0] } },
          cashOutPaise: { $sum: cashOutExpr() },
          handoverValuePaise: { $sum: handoverValueExpr() },
        },
      },
    ]),
    Redemption.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$mode",
          count: { $sum: 1 },
          settlementPaise: { $sum: { $ifNull: ["$settlementPaise", 0] } },
          weightMg: { $sum: { $ifNull: ["$weightMg", 0] } },
          cashOutPaise: { $sum: cashOutExpr() },
          handoverValuePaise: { $sum: handoverValueExpr() },
        },
      },
    ]),
  ]);

  const t = totals[0] ?? {
    count: 0,
    settlementPaise: 0,
    principalPaise: 0,
    benefitPaise: 0,
    penaltyPaise: 0,
    weightMg: 0,
    cashOutPaise: 0,
    handoverValuePaise: 0,
  };

  const closureMap = Object.fromEntries(byClosure.map((row) => [row._id, row]));
  const maturity = closureMap.MATURITY_REDEMPTION ?? {
    count: 0,
    settlementPaise: 0,
    penaltyPaise: 0,
    benefitPaise: 0,
    cashOutPaise: 0,
    handoverValuePaise: 0,
  };
  const premature = closureMap.PREMATURE_CLOSURE ?? {
    count: 0,
    settlementPaise: 0,
    penaltyPaise: 0,
    benefitPaise: 0,
    cashOutPaise: 0,
    handoverValuePaise: 0,
  };

  let cashSettlementPaise = t.cashOutPaise ?? 0;
  let goldWeightMg = 0;
  let goldHandoverValuePaise = t.handoverValuePaise ?? 0;
  for (const row of byMode) {
    if (row._id === "GOLD_HANDOVER") {
      goldWeightMg += row.weightMg ?? 0;
      if (!t.handoverValuePaise) {
        goldHandoverValuePaise += row.handoverValuePaise ?? 0;
      }
    }
  }

  const totalHandedOutPaise =
    cashSettlementPaise + goldHandoverValuePaise;

  return {
    count: t.count,
    settlementPaise: totalHandedOutPaise,
    principalPaise: t.principalPaise,
    benefitPaise: t.benefitPaise,
    penaltyPaise: t.penaltyPaise,
    weightMg: t.weightMg,
    cashSettlementPaise,
    goldWeightMg,
    goldHandoverValuePaise,
    purchaseAdjustmentSettlementPaise: t.purchaseAdjustmentSettlementPaise ?? 0,
    maturityRedemptions: {
      count: maturity.count,
      settlementPaise:
        (maturity.cashOutPaise ?? 0) + (maturity.handoverValuePaise ?? 0),
      benefitPaise: maturity.benefitPaise,
      penaltyPaise: maturity.penaltyPaise,
    },
    prematureClosures: {
      count: premature.count,
      settlementPaise:
        (premature.cashOutPaise ?? 0) + (premature.handoverValuePaise ?? 0),
      benefitPaise: premature.benefitPaise,
      penaltyPaise: premature.penaltyPaise,
    },
  };
}
