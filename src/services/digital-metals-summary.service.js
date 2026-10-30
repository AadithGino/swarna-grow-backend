/**
 * Read-only Digi Gold numbers for the admin app:
 * - per-customer holdings & trading totals (customer detail overview / summary)
 * - shop-wide dashboard block (holdings value, period buys/sells, queues, 14-day trend)
 *
 * Values use the current published customer sell rate (what the shop would pay today).
 * Branch roles only see their branch's wallets and orders.
 */
import { errors } from "../lib/app-error.js";
import { UG_PER_G } from "../lib/digital-metals-quote-engine.js";
import { DEFAULT_DIGITAL_METAL_ASSETS } from "../lib/digital-metals-readiness.js";
import { presentDigitalMetalsAccessState } from "../lib/digital-metals-access.js";
import { digitalMetalsAdminBranchId, digitalMetalsAdminRoleScope } from "../lib/digital-metals-admin-scope.js";
import { resolveReportPeriod } from "./report-builders/report-envelope.js";
import {
  Customer,
  DigitalMetalBuyOrder,
  DigitalMetalPayable,
  DigitalMetalRateVersion,
  DigitalMetalSellOrder,
  DigitalMetalWallet,
} from "../models/index.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";

const IST_OFFSET = "+05:30";

function valueAt(ug, ratePerGramPaise) {
  if (!ratePerGramPaise || !ug) return 0;
  return Math.floor((Number(ug) * Number(ratePerGramPaise)) / UG_PER_G);
}

async function currentRates(tenantId) {
  const at = new Date();
  const rows = await Promise.all(
    DEFAULT_DIGITAL_METAL_ASSETS.map((a) =>
      DigitalMetalRateVersion.findOne({
        tenantId,
        metal: a.metal,
        finenessPpm: a.finenessPpm,
        effectiveAt: { $lte: at },
      })
        .sort({ effectiveAt: -1, createdAt: -1 })
        .lean(),
    ),
  );
  return DEFAULT_DIGITAL_METAL_ASSETS.map((a, i) => ({
    metal: a.metal,
    finenessPpm: a.finenessPpm,
    buyRatePerGramPaise: rows[i]?.customerBuyRatePerGramPaise ?? null,
    sellRatePerGramPaise: rows[i]?.customerSellRatePerGramPaise ?? null,
    effectiveAt: rows[i]?.effectiveAt ?? null,
  }));
}

function rateFor(rates, metal, finenessPpm) {
  return rates.find((r) => r.metal === metal && r.finenessPpm === finenessPpm) ?? null;
}

/* ───────────── Customer ───────────── */

export async function customerDigitalMetalsSummary(tenantId, customerId, tenant) {
  const access = presentDigitalMetalsAccessState(tenant);
  const [wallets, rates, buyAgg, sellAgg, pendingSells, payableOrders, lastBuy, lastSell] = await Promise.all([
    DigitalMetalWallet.find({ tenantId, customerId }).lean(),
    currentRates(tenantId),
    DigitalMetalBuyOrder.aggregate([
      { $match: { tenantId, customerId, status: "CREDITED" } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          paidPaise: { $sum: "$totalPayablePaise" },
          quantityUg: { $sum: "$quantityUg" },
          counterCount: { $sum: { $cond: [{ $ifNull: ["$assisted.byUserId", false] }, 1, 0] } },
        },
      },
    ]),
    DigitalMetalSellOrder.aggregate([
      { $match: { tenantId, customerId, status: { $in: ["PAYABLE_OPEN", "EXECUTED"] } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          settlementPaise: { $sum: "$settlementPaise" },
          quantityUg: { $sum: "$quantityUg" },
        },
      },
    ]),
    DigitalMetalSellOrder.countDocuments({ tenantId, customerId, status: "PENDING_APPROVAL" }),
    DigitalMetalSellOrder.find({ tenantId, customerId, status: "PAYABLE_OPEN", payableId: { $ne: null } })
      .select("_id payableId payoutMethod")
      .lean(),
    DigitalMetalBuyOrder.findOne({ tenantId, customerId }).sort({ createdAt: -1 }).select("createdAt").lean(),
    DigitalMetalSellOrder.findOne({ tenantId, customerId }).sort({ createdAt: -1 }).select("createdAt").lean(),
  ]);

  const payables = payableOrders.length
    ? await DigitalMetalPayable.find({
        tenantId,
        _id: { $in: payableOrders.map((o) => o.payableId) },
        status: "OPEN",
      }).lean()
    : [];
  const methodByPayable = new Map(payableOrders.map((o) => [o.payableId, o.payoutMethod ?? "BANK"]));

  const holdings = wallets
    .filter((w) => (w.heldUg ?? 0) > 0 || (w.reservedUg ?? 0) > 0)
    .map((w) => {
      const rate = rateFor(rates, w.metal, w.finenessPpm);
      const availableUg = Math.max(0, (w.heldUg ?? 0) - (w.reservedUg ?? 0));
      return {
        metal: w.metal,
        finenessPpm: w.finenessPpm,
        heldUg: String(w.heldUg ?? 0),
        reservedUg: String(w.reservedUg ?? 0),
        availableUg: String(availableUg),
        sellRatePerGramPaise: rate?.sellRatePerGramPaise ?? null,
        valuePaise: valueAt(w.heldUg ?? 0, rate?.sellRatePerGramPaise),
      };
    });
  const bought = buyAgg[0] ?? { count: 0, paidPaise: 0, quantityUg: 0, counterCount: 0 };
  const sold = sellAgg[0] ?? { count: 0, settlementPaise: 0, quantityUg: 0 };
  const lastActivity = [lastBuy?.createdAt, lastSell?.createdAt].filter(Boolean).sort((a, b) => b - a)[0] ?? null;
  const ugOf = (metal) =>
    holdings.filter((h) => h.metal === metal).reduce((sum, h) => sum + Number(h.heldUg), 0);

  return {
    moduleActive: access.active,
    hasActivity: holdings.length > 0 || bought.count > 0 || sold.count > 0 || pendingSells > 0,
    holdings,
    totals: {
      valuePaise: holdings.reduce((sum, h) => sum + h.valuePaise, 0),
      goldUg: String(ugOf("GOLD")),
      silverUg: String(ugOf("SILVER")),
    },
    bought: {
      count: bought.count,
      paidPaise: bought.paidPaise,
      quantityUg: String(bought.quantityUg ?? 0),
      counterCount: bought.counterCount,
    },
    sold: {
      count: sold.count,
      settlementPaise: sold.settlementPaise,
      quantityUg: String(sold.quantityUg ?? 0),
    },
    pendingSells,
    openPayables: {
      count: payables.length,
      outstandingPaise: payables.reduce((sum, p) => sum + (p.outstandingPaise ?? 0), 0),
      cashDueCount: payables.filter((p) => methodByPayable.get(p._id) === "CASH").length,
    },
    rates,
    lastActivityAt: lastActivity,
  };
}

export async function getAdminCustomerDigitalMetalsSummary(req) {
  const customer = await Customer.findOne({ _id: req.params.customerId, tenantId: req.auth.tenantId }).lean();
  if (!customer) throw errors.notFound("Customer");
  assertTenantOwnsCustomerScope(req, customer);
  return customerDigitalMetalsSummary(req.auth.tenantId, String(customer._id), req.tenant);
}

/* ───────────── Dashboard ───────────── */

function istDayStart(ymd) {
  return new Date(`${ymd}T00:00:00${IST_OFFSET}`);
}
function istDayEnd(ymd) {
  return new Date(`${ymd}T23:59:59.999${IST_OFFSET}`);
}
function istYmd(date) {
  return new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

async function dashboardScope(req) {
  const tenantId = req.auth.tenantId;
  if (digitalMetalsAdminRoleScope(req) === "TENANT") {
    const focus = req.query?.branchId && String(req.query.branchId).toUpperCase() !== "ALL"
      ? String(req.query.branchId)
      : (req.scope?.branchId ?? null);
    return { tenantId, branchId: focus };
  }
  const branchId = digitalMetalsAdminBranchId(req);
  if (!branchId) throw errors.forbidden("Branch scope is required for this role.");
  return { tenantId, branchId };
}

export async function getAdminDigitalMetalsDashboardSummary(req) {
  const access = presentDigitalMetalsAccessState(req.tenant);
  const { tenantId, branchId } = await dashboardScope(req);
  const { from, to } = resolveReportPeriod(req.query ?? {});
  const start = from ? istDayStart(from) : new Date(Date.now() - 30 * 86_400_000);
  const end = to ? istDayEnd(to) : new Date();
  const base = { tenantId, ...(branchId ? { branchId } : {}) };
  const trendStart = istDayStart(istYmd(new Date(Date.now() - 13 * 86_400_000)));

  const [rates, walletAgg, buyAgg, sellAgg, newInvestorAgg, sellsToApprove, payableOrders, buyTrend, sellTrend, buyByMetalAgg, sellByMetalAgg] =
    await Promise.all([
      currentRates(tenantId),
      DigitalMetalWallet.aggregate([
        { $match: { ...base, heldUg: { $gt: 0 } } },
        {
          $group: {
            _id: { metal: "$metal", finenessPpm: "$finenessPpm" },
            heldUg: { $sum: "$heldUg" },
            customers: { $addToSet: "$customerId" },
          },
        },
      ]),
      DigitalMetalBuyOrder.aggregate([
        { $match: { ...base, status: "CREDITED", creditedAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            amountPaise: { $sum: "$totalPayablePaise" },
            quantityUg: { $sum: "$quantityUg" },
            customers: { $addToSet: "$customerId" },
            counterCount: { $sum: { $cond: [{ $ifNull: ["$assisted.byUserId", false] }, 1, 0] } },
            counterAmountPaise: {
              $sum: { $cond: [{ $ifNull: ["$assisted.byUserId", false] }, "$totalPayablePaise", 0] },
            },
          },
        },
      ]),
      DigitalMetalSellOrder.aggregate([
        { $match: { ...base, status: { $in: ["PAYABLE_OPEN", "EXECUTED"] }, executedAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            amountPaise: { $sum: "$settlementPaise" },
            quantityUg: { $sum: "$quantityUg" },
          },
        },
      ]),
      DigitalMetalBuyOrder.aggregate([
        { $match: { ...base, status: "CREDITED" } },
        { $group: { _id: "$customerId", firstAt: { $min: "$creditedAt" } } },
        { $match: { firstAt: { $gte: start, $lte: end } } },
        { $count: "n" },
      ]),
      DigitalMetalSellOrder.countDocuments({ ...base, status: "PENDING_APPROVAL" }),
      DigitalMetalSellOrder.find({ ...base, status: "PAYABLE_OPEN", payableId: { $ne: null } })
        .select("payableId payoutMethod")
        .lean(),
      DigitalMetalBuyOrder.aggregate([
        { $match: { ...base, status: "CREDITED", creditedAt: { $gte: trendStart } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$creditedAt", timezone: "Asia/Kolkata" } },
            amountPaise: { $sum: "$totalPayablePaise" },
          },
        },
      ]),
      DigitalMetalSellOrder.aggregate([
        { $match: { ...base, status: { $in: ["PAYABLE_OPEN", "EXECUTED"] }, executedAt: { $gte: trendStart } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$executedAt", timezone: "Asia/Kolkata" } },
            amountPaise: { $sum: "$settlementPaise" },
          },
        },
      ]),
      // Gold and silver weights must not be added together on the cards.
      DigitalMetalBuyOrder.aggregate([
        { $match: { ...base, status: "CREDITED", creditedAt: { $gte: start, $lte: end } } },
        { $group: { _id: "$metal", quantityUg: { $sum: "$quantityUg" }, count: { $sum: 1 } } },
      ]),
      DigitalMetalSellOrder.aggregate([
        { $match: { ...base, status: { $in: ["PAYABLE_OPEN", "EXECUTED"] }, executedAt: { $gte: start, $lte: end } } },
        { $group: { _id: "$metal", quantityUg: { $sum: "$quantityUg" }, count: { $sum: 1 } } },
      ]),
    ]);
  const byMetal = (rows) =>
    Object.fromEntries(
      rows
        .filter((row) => row._id)
        .map((row) => [row._id, { quantityUg: String(row.quantityUg ?? 0), count: row.count ?? 0 }]),
    );

  const payables = payableOrders.length
    ? await DigitalMetalPayable.find({
        tenantId,
        _id: { $in: payableOrders.map((o) => o.payableId) },
        status: "OPEN",
      })
        .select("_id outstandingPaise")
        .lean()
    : [];
  const cashPayables = new Set(payableOrders.filter((o) => o.payoutMethod === "CASH").map((o) => o.payableId));

  const holdings = walletAgg.map((row) => {
    const rate = rateFor(rates, row._id.metal, row._id.finenessPpm);
    return {
      metal: row._id.metal,
      finenessPpm: row._id.finenessPpm,
      heldUg: String(row.heldUg),
      customers: row.customers.length,
      valuePaise: valueAt(row.heldUg, rate?.sellRatePerGramPaise),
    };
  });
  const allHolders = new Set(walletAgg.flatMap((row) => row.customers));
  const buys = buyAgg[0] ?? { count: 0, amountPaise: 0, quantityUg: 0, customers: [], counterCount: 0, counterAmountPaise: 0 };
  const sells = sellAgg[0] ?? { count: 0, amountPaise: 0, quantityUg: 0 };

  const buyByDay = new Map(buyTrend.map((r) => [r._id, r.amountPaise]));
  const sellByDay = new Map(sellTrend.map((r) => [r._id, r.amountPaise]));
  const trend = [];
  for (let i = 13; i >= 0; i -= 1) {
    const day = istYmd(new Date(Date.now() - i * 86_400_000));
    trend.push({ date: day, buyPaise: buyByDay.get(day) ?? 0, sellPaise: sellByDay.get(day) ?? 0 });
  }

  return {
    moduleActive: access.active,
    paused: access.paused,
    scope: { branchId },
    period: { from, to, timezone: "Asia/Kolkata" },
    asOf: new Date().toISOString(),
    rates,
    holdings,
    totals: {
      valuePaise: holdings.reduce((sum, h) => sum + h.valuePaise, 0),
      customersHolding: allHolders.size,
    },
    buys: {
      count: buys.count,
      amountPaise: buys.amountPaise,
      quantityUg: String(buys.quantityUg ?? 0),
      customers: buys.customers?.length ?? 0,
      counterCount: buys.counterCount,
      counterAmountPaise: buys.counterAmountPaise,
      byMetal: byMetal(buyByMetalAgg),
    },
    sells: {
      count: sells.count,
      amountPaise: sells.amountPaise,
      quantityUg: String(sells.quantityUg ?? 0),
      byMetal: byMetal(sellByMetalAgg),
    },
    netInflowPaise: buys.amountPaise - sells.amountPaise,
    newInvestors: newInvestorAgg[0]?.n ?? 0,
    queues: {
      sellsToApprove,
      openPayables: payables.length,
      outstandingPaise: payables.reduce((sum, p) => sum + (p.outstandingPaise ?? 0), 0),
      cashPayoutsDue: payables.filter((p) => cashPayables.has(p._id)).length,
    },
    trend,
  };
}
