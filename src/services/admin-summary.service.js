import { Branch, Scheme, Session, User } from "../models/index.js";
import { SchemeStatus, TenantRole, UserStatus, UserType } from "../constants/enums.js";
import {
  effectiveScope,
  maturityListFilter,
  resolveDatePreset,
} from "../lib/query-filters.js";
import { getSubscriptionForAdmin } from "./tenant-settings.service.js";
import { moneyRef } from "../lib/money.js";
import {
  installmentRemainingPaise,
  istTodayYmd,
  summarizeWorkboard,
  visibleWorkboardInstallments,
  workboardSchemeFilter,
} from "../lib/dues-workboard.js";

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Enrollment KPI counts for the current list filters + branch scope. */
export async function schemePortfolioSummary(req, listFilters = {}) {
  const match = { ...effectiveScope(req), ...listFilters };
  const count = (status) =>
    typeof status === "object"
      ? Scheme.countDocuments({ ...match, status })
      : Scheme.countDocuments({ ...match, status });

  const [activeOnly, locked, defaulted, matured, redeemed, closedPremature] =
    await Promise.all([
      count(SchemeStatus.ACTIVE),
      count(SchemeStatus.LOCKED),
      count(SchemeStatus.DEFAULTED),
      count(SchemeStatus.MATURED),
      count(SchemeStatus.REDEEMED),
      count(SchemeStatus.CLOSED_PREMATURE),
    ]);

  const activeAndLocked = activeOnly + locked;
  const open = activeAndLocked + defaulted;
  return {
    activeAndLocked,
    open,
    /** @deprecated use activeAndLocked */
    active: activeAndLocked,
    locked,
    defaulted,
    matured,
    redeemed: redeemed + closedPremature,
    redemptionPending: matured,
  };
}

const paidInPaiseExpr = {
  $ifNull: [
    "$totals.amountPaidPaise",
    {
      $reduce: {
        input: { $ifNull: ["$installments", []] },
        initialValue: 0,
        in: { $add: ["$$value", { $ifNull: ["$$this.paidPaise", 0] }] },
      },
    },
  ],
};

async function countAndPaidIn(match) {
  const [row] = await Scheme.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        paidInPaise: { $sum: paidInPaiseExpr },
        goldMg: { $sum: { $ifNull: ["$totals.goldWeightMg", 0] } },
      },
    },
  ]);
  return {
    count: row?.count ?? 0,
    paidInPaise: row?.paidInPaise ?? 0,
    goldMg: row?.goldMg ?? 0,
  };
}

/**
 * Maturity board KPIs.
 * - Snapshot cards (next 30 days, today, incomplete, matured-not-redeemed) ignore
 *   the chosen period so they never change when you flip the calendar month.
 * - The period card (`period*`, plus legacy `liabilityPaise` / `goldMg`) covers the
 *   schemes maturing in the selected month / range.
 * Each count and its rupee value come from the same match, so they always agree.
 */
export async function maturityBoardSummary(req) {
  const scope = effectiveScope(req);
  const periodFilter = maturityListFilter(req.query);
  const today = istTodayYmd();
  const in30 = addDaysYmd(today, 30);
  const OPEN = [SchemeStatus.ACTIVE, SchemeStatus.LOCKED, SchemeStatus.DEFAULTED];

  const [upcoming, maturedToday, incomplete, notRedeemed, period] =
    await Promise.all([
      countAndPaidIn({
        ...scope,
        status: { $in: [...OPEN, SchemeStatus.MATURED] },
        maturityDate: { $gte: today, $lte: in30 },
      }),
      countAndPaidIn({
        ...scope,
        status: { $in: [...OPEN, SchemeStatus.MATURED] },
        maturityDate: today,
      }),
      countAndPaidIn({
        ...scope,
        status: SchemeStatus.DEFAULTED,
        maturityDate: { $lte: today },
      }),
      countAndPaidIn({ ...scope, status: SchemeStatus.MATURED }),
      countAndPaidIn({ ...scope, ...periodFilter }),
    ]);

  return {
    upcoming: upcoming.count,
    upcomingLiabilityPaise: upcoming.paidInPaise,
    maturedToday: maturedToday.count,
    maturedTodayLiabilityPaise: maturedToday.paidInPaise,
    incomplete: incomplete.count,
    incompleteLiabilityPaise: incomplete.paidInPaise,
    notRedeemed: notRedeemed.count,
    notRedeemedLiabilityPaise: notRedeemed.paidInPaise,
    notRedeemedGoldMg: notRedeemed.goldMg,
    periodCount: period.count,
    /** Paid-in on schemes maturing in the selected period. */
    liabilityPaise: period.paidInPaise,
    goldMg: period.goldMg,
  };
}

export {
  installmentRemainingPaise,
  installmentInRange as installmentInDateRange,
} from "../lib/dues-workboard.js";

/** Pick the instalment row shown on the dues / overdue / defaulters workboard for an enrollment. */
export function pickWorkboardInstallment(scheme, boardKind, dates, query = {}, today = istTodayYmd()) {
  const visible = visibleWorkboardInstallments(scheme, boardKind, {
    kind: query.kind,
    dates,
    today,
  });
  if (!visible.length) return null;
  return {
    ...visible[0].inst,
    effectiveState: visible[0].state,
    visibleCount: visible.length,
    visibleRemainingPaise: visible.reduce(
      (sum, row) => sum + installmentRemainingPaise(row.inst),
      0,
    ),
  };
}

/** Workboard date window — defaulters registry is not date-filtered. */
export function workboardDates(kind, query = {}) {
  if (kind === "defaulters") return {};
  return resolveDatePreset(query.preset, query);
}

/** Dues / overdues / defaulters KPI totals (rupees + customer count). */
export async function duesBoardSummary(req, kind) {
  const today = istTodayYmd();
  const dates = workboardDates(kind, req.query);
  // Summary covers the whole board (every state), independent of the quick view.
  const filter = workboardSchemeFilter(kind, { kind: "ALL", dates, today });
  const match = { ...effectiveScope(req), ...filter };
  const schemes = await Scheme.find(match)
    .select("customerId status installments")
    .lean();
  const summary = summarizeWorkboard(schemes, kind, { dates, today });
  const t = summary.totalsPaise;
  return {
    due: t.DUE / 100,
    grace: t.GRACE / 100,
    overdue: t.OVERDUE / 100,
    defaulted: t.DEFAULTED / 100,
    total: (t.DUE + t.GRACE + t.OVERDUE + t.DEFAULTED) / 100,
    customers: summary.customers,
    customersByState: summary.customersByState,
    instalmentCounts: summary.instalmentCounts,
    ...(kind === "overdues"
      ? {
          chart: {
            chartType: "bar",
            title: "Overdue by ageing",
            yAxis: { type: "currency", label: "Amount" },
            series: [
              {
                key: "OVERDUE",
                name: "Overdue",
                data: Object.entries(summary.ageingPaise).map(([x, amountPaise]) => ({
                  x,
                  y: amountPaise,
                  yDisplay: moneyRef(amountPaise).amountDisplay,
                })),
              },
            ],
          },
        }
      : {}),
  };
}

/** Staff & branch access KPIs for the admin access page. */
export async function adminAccessSummary(req) {
  const tenantId = req.auth.tenantId;
  const scope = effectiveScope(req);
  const staffMatch = {
    tenantId,
    type: UserType.TENANT_USER,
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
  };

  const [activeStaff, suspended, admins, activeBranches, sessions] =
    await Promise.all([
      User.countDocuments({ ...staffMatch, status: UserStatus.ACTIVE }),
      User.countDocuments({
        ...staffMatch,
        status: UserStatus.INACTIVE,
      }),
      User.countDocuments({
        ...staffMatch,
        status: UserStatus.ACTIVE,
        role: { $in: [TenantRole.TENANT_ADMIN, TenantRole.TENANT_OWNER] },
      }),
      Branch.countDocuments({
        tenantId,
        active: true,
        ...(scope.branchId ? { _id: scope.branchId } : {}),
      }),
      // Staff sign-ins only — customer-app sessions live in the same collection.
      (async () => {
        const userFilter = scope.branchId
          ? {
              userId: {
                $in: await User.distinct("_id", staffMatch),
              },
            }
          : { userId: { $exists: true, $nin: [null, ""] } };
        return Session.countDocuments({
          tenantId,
          ...userFilter,
          expiresAt: { $gt: new Date() },
          revokedAt: { $exists: false },
          $or: [{ consumedAt: { $exists: false } }, { consumedAt: null }],
        });
      })(),
    ]);

  const subscription = await getSubscriptionForAdmin(req);
  const usage = subscription?.usage ?? {};
  const staffSeats = usage.staffSeats ?? {};
  const branchUsage = usage.branches ?? {};

  return {
    activeStaff,
    staffLimit: Number(staffSeats.limit ?? 0),
    staffUsed: Number(staffSeats.used ?? activeStaff),
    branches: Number(branchUsage.used ?? activeBranches),
    branchLimit: Number(branchUsage.limit ?? 0),
    admins,
    sessions,
    suspended,
    planName: subscription?.currentPlan?.name ?? subscription?.plan?.name,
  };
}
