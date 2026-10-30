/**
 * Single source of truth for the Dues / Overdue / Defaulters workboards.
 *
 * The list endpoint, its KPI summary, the dashboard "overdue" card and the
 * sidebar badge all classify instalments with the same rules, so a number on a
 * card always matches the rows behind it.
 *
 * Effective state of an unpaid FIXED instalment (IST calendar dates, YYYY-MM-DD):
 *   DEFAULTED – the enrollment itself is DEFAULTED and the instalment date has passed
 *   OVERDUE   – status OVERDUE, or DUE / PARTIALLY_PAID whose grace has already ended
 *               (covers the gap before the nightly overdue job runs)
 *   GRACE     – DUE / PARTIALLY_PAID, due date passed, grace still running
 *   DUE       – DUE / PARTIALLY_PAID, due today or later
 * Paid, waived and not-yet-due (PENDING) instalments have no state.
 */
import { SchemeStatus } from "../constants/enums.js";
import { today as calendarToday } from "./date.js";

export const WORKBOARD_STATES = Object.freeze(["DUE", "GRACE", "OVERDUE", "DEFAULTED"]);

/** Enrollments that can still owe instalments (matured / redeemed / closed are excluded). */
export const DUES_OPEN_SCHEME_STATUSES = Object.freeze([
  SchemeStatus.PENDING_PAYMENT,
  SchemeStatus.ACTIVE,
  SchemeStatus.LOCKED,
  SchemeStatus.DEFAULTED,
]);

const NON_DEFAULTED_OPEN_STATUSES = Object.freeze(
  DUES_OPEN_SCHEME_STATUSES.filter((s) => s !== SchemeStatus.DEFAULTED),
);

const UNPAID_RAW_STATUSES = ["DUE", "PARTIALLY_PAID", "OVERDUE"];

/** Today's IST calendar date (honours the test calendar override in lib/date.js). */
export function istTodayYmd() {
  return calendarToday();
}

function ymd(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

export function installmentRemainingPaise(inst) {
  return Math.max(0, (inst?.amountPaise ?? 0) - (inst?.paidPaise ?? 0));
}

export function effectiveInstallmentState(schemeStatus, inst, today) {
  if (!inst || installmentRemainingPaise(inst) <= 0) return null;
  const status = inst.status;
  if (status === "PAID" || status === "WAIVED") return null;
  const due = ymd(inst.dueDate);
  if (schemeStatus === SchemeStatus.DEFAULTED) {
    return due && due <= today ? "DEFAULTED" : null;
  }
  const graceEnds = ymd(inst.graceEndsAt);
  if (status === "OVERDUE") return "OVERDUE";
  if (status !== "DUE" && status !== "PARTIALLY_PAID") return null;
  if (graceEnds && graceEnds < today) return "OVERDUE";
  if (due && due < today) return "GRACE";
  return "DUE";
}

/**
 * Which effective states a board + quick view shows.
 * board: "dues" | "overdues" | "defaulters"; kind: ALL | DUE | GRACE | OVERDUE | DEFAULTED
 */
export function allowedWorkboardStates(board, kind) {
  if (board === "overdues") return new Set(["OVERDUE"]);
  if (board === "defaulters") return new Set(["DEFAULTED"]);
  const view = String(kind ?? "ALL").toUpperCase();
  if (WORKBOARD_STATES.includes(view)) return new Set([view]);
  return new Set(WORKBOARD_STATES);
}

export function installmentInRange(inst, dates = {}) {
  const due = ymd(inst?.dueDate);
  if (!due) return true;
  if (dates.from && due < dates.from) return false;
  if (dates.to && due > dates.to) return false;
  return true;
}

/**
 * Mongo filter that selects exactly the enrollments that have at least one
 * instalment visible on the board (a tight superset; rows are re-checked with
 * effectiveInstallmentState). One $elemMatch keeps status and date on the SAME
 * instalment, so pagination does not return enrollments that then get dropped.
 */
export function workboardSchemeFilter(board, { kind, dates = {}, today }) {
  const allowed = allowedWorkboardStates(board, kind);
  const wantsDefaulted = allowed.has("DEFAULTED");
  const wantsOthers = [...allowed].some((s) => s !== "DEFAULTED");

  const dueDate = {};
  if (dates.from) dueDate.$gte = dates.from;
  if (dates.to) dueDate.$lte = dates.to;

  const elem = { status: { $in: UNPAID_RAW_STATUSES } };
  if (allowed.size === 1) {
    const only = [...allowed][0];
    if (only === "DUE") {
      elem.status = { $in: ["DUE", "PARTIALLY_PAID"] };
      dueDate.$gte = dueDate.$gte && dueDate.$gte > today ? dueDate.$gte : today;
    } else if (only === "GRACE") {
      elem.status = { $in: ["DUE", "PARTIALLY_PAID"] };
      dueDate.$lt = today;
    } else if (only === "OVERDUE") {
      delete elem.status;
      elem.$or = [
        { status: "OVERDUE" },
        { status: { $in: ["DUE", "PARTIALLY_PAID"] }, graceEndsAt: { $lt: today } },
      ];
    } else if (only === "DEFAULTED") {
      dueDate.$lte = dueDate.$lte && dueDate.$lte < today ? dueDate.$lte : today;
    }
  }
  if (Object.keys(dueDate).length) elem.dueDate = dueDate;

  let status;
  if (wantsDefaulted && !wantsOthers) status = SchemeStatus.DEFAULTED;
  else if (!wantsDefaulted) status = { $in: NON_DEFAULTED_OPEN_STATUSES };
  else status = { $in: DUES_OPEN_SCHEME_STATUSES };

  return {
    paymentPattern: "FIXED",
    status,
    installments: { $elemMatch: elem },
  };
}

/** Instalments of one enrollment that are visible on the board, oldest first. */
export function visibleWorkboardInstallments(scheme, board, { kind, dates = {}, today }) {
  const allowed = allowedWorkboardStates(board, kind);
  return (scheme.installments ?? [])
    .map((inst) => ({ inst, state: effectiveInstallmentState(scheme.status, inst, today) }))
    .filter(({ state, inst }) => state && allowed.has(state) && installmentInRange(inst, dates))
    .sort((a, b) => String(a.inst.dueDate ?? "").localeCompare(String(b.inst.dueDate ?? "")));
}

const AGEING_BUCKETS = [
  { label: "1–7 days", max: 7 },
  { label: "8–15 days", max: 15 },
  { label: "16–30 days", max: 30 },
  { label: "30+ days", max: Infinity },
];

export function daysBetweenYmd(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T12:00:00+05:30`);
  const b = new Date(`${toYmd}T12:00:00+05:30`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * KPI totals for a board. Buckets always cover every state the board can show
 * (ignoring the quick view) so the cards work as a breakdown; `customers` is the
 * distinct customers behind those buckets. Amounts are paise.
 */
export function summarizeWorkboard(schemes, board, { dates = {}, today }) {
  const totals = { DUE: 0, GRACE: 0, OVERDUE: 0, DEFAULTED: 0 };
  const counts = { DUE: 0, GRACE: 0, OVERDUE: 0, DEFAULTED: 0 };
  const customersByState = { DUE: new Set(), GRACE: new Set(), OVERDUE: new Set(), DEFAULTED: new Set() };
  const customers = new Set();
  const ageing = Object.fromEntries(AGEING_BUCKETS.map((b) => [b.label, 0]));
  for (const scheme of schemes) {
    for (const { inst, state } of visibleWorkboardInstallments(scheme, board, { kind: "ALL", dates, today })) {
      const remaining = installmentRemainingPaise(inst);
      totals[state] += remaining;
      counts[state] += 1;
      customersByState[state].add(scheme.customerId);
      customers.add(scheme.customerId);
      if (state === "OVERDUE" && inst.dueDate) {
        const days = daysBetweenYmd(ymd(inst.dueDate), today);
        const bucket = AGEING_BUCKETS.find((b) => days <= b.max) ?? AGEING_BUCKETS[3];
        ageing[bucket.label] += remaining;
      }
    }
  }
  return {
    totalsPaise: totals,
    instalmentCounts: counts,
    customersByState: Object.fromEntries(
      Object.entries(customersByState).map(([k, set]) => [k, set.size]),
    ),
    customers: customers.size,
    ageingPaise: ageing,
  };
}
