/**
 * Per-turn context for the agent: today's date and ready-made date windows (so the
 * model never has to do calendar arithmetic), plus the tenant's branches, plans and
 * latest gold rate so names like "Kochi branch" or "Gold 360" resolve without a tool call.
 */
import dayjs from "dayjs";
import { today as todayIst } from "../../../lib/date.js";
import { Branch, GoldRate, SchemePlan } from "../../../models/index.js";
import { rupeesDisplay } from "./format.js";

function ymd(d) {
  return d.format("YYYY-MM-DD");
}

export function dateWindows(todayYmd = todayIst()) {
  // Plain UTC calendar arithmetic on the IST calendar date — no timezone drift.
  const t = dayjs.utc(`${todayYmd}T00:00:00Z`);
  const startOfWeek = t.subtract((t.day() + 6) % 7, "day"); // Monday
  const monthStart = t.startOf("month");
  const lastMonthStart = monthStart.subtract(1, "month");
  const lastMonthEnd = monthStart.subtract(1, "day");
  const fyStartYear = t.month() >= 3 ? t.year() : t.year() - 1; // Indian FY: Apr–Mar
  const fyStart = t.date(1).year(fyStartYear).month(3);
  const lastFyStart = fyStart.subtract(1, "year");
  const lastFyEnd = fyStart.subtract(1, "day");
  const quarterStartMonth = Math.floor(t.month() / 3) * 3;
  const quarterStart = t.date(1).month(quarterStartMonth);
  const lastQuarterStart = quarterStart.subtract(3, "month");
  const lastQuarterEnd = quarterStart.subtract(1, "day");
  return {
    today: ymd(t),
    weekday: t.format("dddd"),
    yesterday: ymd(t.subtract(1, "day")),
    thisWeek: { from: ymd(startOfWeek), to: ymd(t) },
    lastWeek: { from: ymd(startOfWeek.subtract(7, "day")), to: ymd(startOfWeek.subtract(1, "day")) },
    thisMonth: { from: ymd(monthStart), to: ymd(t) },
    lastMonth: { from: ymd(lastMonthStart), to: ymd(lastMonthEnd) },
    last7Days: { from: ymd(t.subtract(6, "day")), to: ymd(t) },
    last30Days: { from: ymd(t.subtract(29, "day")), to: ymd(t) },
    last90Days: { from: ymd(t.subtract(89, "day")), to: ymd(t) },
    thisQuarter: { from: ymd(quarterStart), to: ymd(t) },
    lastQuarter: { from: ymd(lastQuarterStart), to: ymd(lastQuarterEnd) },
    thisYear: { from: `${t.year()}-01-01`, to: ymd(t) },
    thisFinancialYear: { from: ymd(fyStart), to: ymd(t) },
    lastFinancialYear: { from: ymd(lastFyStart), to: ymd(lastFyEnd) },
  };
}

export async function buildTurnContext(req, scope) {
  const branchMatch = { tenantId: scope.tenantId };
  if (scope.branchId) branchMatch._id = scope.branchId;
  const [branches, plans, rate] = await Promise.all([
    Branch.find(branchMatch, { name: 1, code: 1, active: 1, isHeadOffice: 1 })
      .sort({ isHeadOffice: -1, name: 1 })
      .limit(40)
      .lean(),
    SchemePlan.find({ tenantId: scope.tenantId }, { name: 1, code: 1, status: 1, paymentPattern: 1, valueBasis: 1 })
      .sort({ status: 1, name: 1 })
      .limit(40)
      .lean(),
    GoldRate.findOne(
      scope.branchId
        ? { tenantId: scope.tenantId, branchId: { $in: [scope.branchId, null] } }
        : { tenantId: scope.tenantId },
      { ratePerGramPaise: 1, effectiveDate: 1, purity: 1 },
    )
      .sort({ effectiveDate: -1, createdAt: -1 })
      .lean(),
  ]);
  return {
    windows: dateWindows(),
    role: req.auth?.role ?? null,
    branchScoped: Boolean(scope.branchId),
    branches: branches.map((b) => ({
      id: b._id,
      name: b.name,
      code: b.code,
      ...(b.active === false ? { inactive: true } : {}),
      ...(b.isHeadOffice ? { headOffice: true } : {}),
    })),
    plans: plans.map((p) => ({
      id: p._id,
      name: p.name,
      code: p.code,
      status: p.status,
      pattern: p.paymentPattern,
      basis: p.valueBasis,
    })),
    goldRate: rate
      ? { ratePerGram: rupeesDisplay(rate.ratePerGramPaise), purity: rate.purity, date: rate.effectiveDate }
      : null,
  };
}

/** The dynamic context block placed at the start of each user turn. */
export function contextBlock(ctx, shopName) {
  return [
    "<context>",
    JSON.stringify({
      shop: shopName ?? undefined,
      today: ctx.windows.today,
      weekday: ctx.windows.weekday,
      timezone: "Asia/Kolkata",
      dateWindows: ctx.windows,
      viewerRole: ctx.role,
      viewerLimitedToOneBranch: ctx.branchScoped,
      branches: ctx.branches,
      plans: ctx.plans,
      latestGoldRate: ctx.goldRate,
    }),
    "</context>",
  ].join("\n");
}
