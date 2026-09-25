import { Branch, Scheme, Session, User } from "../models/index.js";
import { SchemeStatus, TenantRole, UserStatus, UserType } from "../constants/enums.js";
import {
  calendarDateMatch,
  effectiveScope,
  maturityListFilter,
  resolveDatePreset,
} from "../lib/query-filters.js";
import { getSubscriptionForAdmin } from "./tenant-settings.service.js";
import { moneyRef } from "../lib/money.js";
import { ageingBucket } from "./report-builders/report-envelope.js";

function istTodayYmd() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

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

/** Maturity board KPIs for the current list filters (date range + branch). */
export async function maturityBoardSummary(req) {
  const filter = maturityListFilter(req.query);
  const match = { ...effectiveScope(req), ...filter };
  const today = istTodayYmd();
  const in30 = addDaysYmd(today, 30);

  const [upcoming, maturedToday, incomplete, notRedeemed, totals] =
    await Promise.all([
      Scheme.countDocuments({
        ...match,
        maturityDate: { $gte: today, $lte: in30 },
      }),
      Scheme.countDocuments({ ...match, maturityDate: today }),
      Scheme.countDocuments({
        ...match,
        status: SchemeStatus.DEFAULTED,
        maturityDate: { $lte: today },
      }),
      Scheme.countDocuments({ ...match, status: SchemeStatus.MATURED }),
      Scheme.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            liabilityPaise: {
              $sum: {
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
              },
            },
            goldMg: { $sum: { $ifNull: ["$totals.goldWeightMg", 0] } },
            maturedTodayLiabilityPaise: {
              $sum: {
                $cond: [
                  { $eq: ["$maturityDate", today] },
                  {
                    $ifNull: [
                      "$totals.amountPaidPaise",
                      {
                        $reduce: {
                          input: { $ifNull: ["$installments", []] },
                          initialValue: 0,
                          in: {
                            $add: ["$$value", { $ifNull: ["$$this.paidPaise", 0] }],
                          },
                        },
                      },
                    ],
                  },
                  0,
                ],
              },
            },
            incompleteLiabilityPaise: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", SchemeStatus.DEFAULTED] },
                      { $lte: ["$maturityDate", today] },
                    ],
                  },
                  {
                    $ifNull: [
                      "$totals.amountPaidPaise",
                      {
                        $reduce: {
                          input: { $ifNull: ["$installments", []] },
                          initialValue: 0,
                          in: {
                            $add: ["$$value", { $ifNull: ["$$this.paidPaise", 0] }],
                          },
                        },
                      },
                    ],
                  },
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);

  const row = totals[0] ?? {};
  return {
    upcoming,
    maturedToday,
    incomplete,
    notRedeemed,
    liabilityPaise: row.liabilityPaise ?? 0,
    goldMg: row.goldMg ?? 0,
    maturedTodayLiabilityPaise: row.maturedTodayLiabilityPaise ?? 0,
    incompleteLiabilityPaise: row.incompleteLiabilityPaise ?? 0,
  };
}

function dueBoardBaseFilter(kind, query = {}) {
  const installmentKind = query.kind;
  if (kind === "defaulters") {
    return { status: SchemeStatus.DEFAULTED, paymentPattern: "FIXED" };
  }
  if (kind === "overdues") {
    return {
      paymentPattern: "FIXED",
      "installments.status":
        installmentKind && installmentKind !== "ALL" ? installmentKind : "OVERDUE",
    };
  }
  if (installmentKind === "DEFAULTED") {
    return { status: SchemeStatus.DEFAULTED, paymentPattern: "FIXED" };
  }
  const statusFilter =
    installmentKind === "OVERDUE"
      ? "OVERDUE"
      : installmentKind === "GRACE" || installmentKind === "DUE"
        ? { $in: ["DUE", "PARTIALLY_PAID"] }
        : { $in: ["DUE", "PARTIALLY_PAID", "OVERDUE"] };
  return {
    paymentPattern: "FIXED",
    ...(typeof statusFilter === "string"
      ? { "installments.status": statusFilter }
      : { "installments.status": statusFilter }),
  };
}

function installmentDueYmd(inst) {
  const raw = inst?.dueDate;
  if (!raw) return null;
  return String(raw).slice(0, 10);
}

export function installmentInDateRange(inst, dates) {
  const due = installmentDueYmd(inst);
  if (!due) return true;
  if (dates.from && due < dates.from) return false;
  if (dates.to && due > dates.to) return false;
  return true;
}

export function installmentRemainingPaise(inst) {
  return Math.max(0, (inst.amountPaise ?? 0) - (inst.paidPaise ?? 0));
}

/** Pick the installment row shown on the dues/overdues workboard for a scheme. */
export function pickWorkboardInstallment(installments, boardKind, dates, query = {}) {
  const viewKind = String(query.kind ?? "ALL").toUpperCase();
  let allowed;
  if (boardKind === "overdues") {
    allowed = new Set(["OVERDUE"]);
  } else if (viewKind === "OVERDUE") {
    allowed = new Set(["OVERDUE"]);
  } else if (viewKind === "GRACE" || viewKind === "DUE") {
    allowed = new Set(["DUE", "PARTIALLY_PAID"]);
  } else if (viewKind === "DEFAULTED") {
    allowed = new Set(["DEFAULTED"]);
  } else {
    allowed = new Set(["DUE", "PARTIALLY_PAID", "OVERDUE"]);
  }

  const candidates = (installments ?? [])
    .filter((inst) => allowed.has(inst.status))
    .filter((inst) => {
      if (inst.status === "OVERDUE" && (boardKind === "overdues" || viewKind === "OVERDUE")) {
        return true;
      }
      return installmentInDateRange(inst, dates);
    })
    .filter((inst) => installmentRemainingPaise(inst) > 0)
    .sort((a, b) =>
      String(a.dueDate ?? "").localeCompare(String(b.dueDate ?? "")),
    );

  return candidates[0] ?? null;
}

/** Dues / overdues workboard KPI totals (rupees + customer count). */
export async function duesBoardSummary(req, kind) {
  const dates = resolveDatePreset(req.query.preset, req.query);
  const filter = dueBoardBaseFilter(kind, req.query);
  if ((kind === "dues" || kind === "overdues") && (dates.from || dates.to)) {
    Object.assign(filter, calendarDateMatch("installments.dueDate", dates));
  }
  const match = { ...effectiveScope(req), ...filter };
  const schemes = await Scheme.find(match)
    .select("customerId status installments")
    .lean();

  const today = istTodayYmd();
  let duePaise = 0;
  let gracePaise = 0;
  let overduePaise = 0;
  let defaultedPaise = 0;
  const ageingTotals = {
    "1–7 days": 0,
    "8–15 days": 0,
    "16–30 days": 0,
    "30+ days": 0,
  };
  const customerIds = new Set();

  const daysBetweenYmd = (fromYmd, toYmd) => {
    const a = new Date(`${fromYmd}T12:00:00+05:30`);
    const b = new Date(`${toYmd}T12:00:00+05:30`);
    return Math.max(0, Math.round((b - a) / 86_400_000));
  };

  for (const scheme of schemes) {
    if (scheme.status === SchemeStatus.DEFAULTED) {
      for (const inst of scheme.installments ?? []) {
        if (!installmentInDateRange(inst, dates)) continue;
        const remaining = Math.max(
          0,
          (inst.amountPaise ?? 0) - (inst.paidPaise ?? 0),
        );
        if (remaining <= 0) continue;
        defaultedPaise += remaining;
        customerIds.add(scheme.customerId);
      }
      continue;
    }

    for (const inst of scheme.installments ?? []) {
      if (kind === "overdues" && inst.status !== "OVERDUE") continue;
      if (
        kind === "dues" &&
        !["DUE", "PARTIALLY_PAID", "OVERDUE"].includes(inst.status)
      ) {
        continue;
      }
      if (!installmentInDateRange(inst, dates)) continue;

      const remaining = Math.max(
        0,
        (inst.amountPaise ?? 0) - (inst.paidPaise ?? 0),
      );
      if (remaining <= 0) continue;

      customerIds.add(scheme.customerId);
      const dueYmd = installmentDueYmd(inst);
      const graceEnds = inst.graceEndsAt
        ? String(inst.graceEndsAt).slice(0, 10)
        : null;

      if (inst.status === "OVERDUE") {
        overduePaise += remaining;
        if (kind === "overdues" && dueYmd) {
          const bucket = ageingBucket(daysBetweenYmd(dueYmd, today));
          ageingTotals[bucket.label] =
            (ageingTotals[bucket.label] ?? 0) + remaining;
        }
      } else if (
        dueYmd &&
        dueYmd < today &&
        graceEnds &&
        graceEnds >= today
      ) {
        gracePaise += remaining;
      } else {
        duePaise += remaining;
      }
    }
  }

  return {
    due: duePaise / 100,
    grace: gracePaise / 100,
    overdue: overduePaise / 100,
    defaulted: defaultedPaise / 100,
    customers: customerIds.size,
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
                data: Object.entries(ageingTotals).map(([x, amountPaise]) => ({
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
      Session.countDocuments({
        tenantId,
        expiresAt: { $gt: new Date() },
        revokedAt: { $exists: false },
        $or: [{ consumedAt: { $exists: false } }, { consumedAt: null }],
      }),
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
