import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { env } from "../config/env.js";
import { AppError } from "./app-error.js";
import { monthKey, today } from "./date.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault(env.APP_TIMEZONE);

function inTz(date) {
  return dayjs(date).tz(env.APP_TIMEZONE);
}

/** First flexible/fixed calendar cycle month key (YYYY-MM) from enrolment start. */
export function firstCalendarCycleMonthKey(startDate, firstInstallmentMode = "START_NEXT_CYCLE") {
  const start = inTz(startDate).startOf("day");
  if (firstInstallmentMode === "COLLECT_NOW") {
    return start.format("YYYY-MM");
  }
  return start.add(1, "month").format("YYYY-MM");
}

export function calendarMonthBoundsFromKey(cycleKey) {
  const start = inTz(`${cycleKey}-01`).startOf("day");
  const end = start.endOf("month");
  return {
    cycle: cycleKey,
    cycleStart: start.format("YYYY-MM-DD"),
    cycleEnd: end.format("YYYY-MM-DD"),
    expiresAt: end.format("YYYY-MM-DD"),
  };
}

/** Exactly `cycleCount` consecutive calendar months in Asia/Kolkata. */
export function buildCalendarMonthCycles({
  startDate,
  cycleCount,
  firstInstallmentMode = "START_NEXT_CYCLE",
}) {
  const count = Number(cycleCount);
  if (!Number.isFinite(count) || count < 1) return [];
  let key = firstCalendarCycleMonthKey(startDate, firstInstallmentMode);
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(calendarMonthBoundsFromKey(key));
    const anchor = inTz(`${key}-01`).add(1, "month");
    key = anchor.format("YYYY-MM");
  }
  return rows;
}

export function maturityDateFromCalendarCycles(cycles) {
  if (!cycles?.length) return null;
  return cycles[cycles.length - 1].cycleEnd;
}

/** Fixed scheme maturity: last calendar day of the final duration month (not last installment due). */
export function fixedMaturityDateFromDuration({
  startDate,
  durationMonths,
  firstInstallmentMode = "START_NEXT_CYCLE",
}) {
  const count = Number(durationMonths);
  if (!Number.isFinite(count) || count < 1) return null;
  return maturityDateFromCalendarCycles(
    buildCalendarMonthCycles({
      startDate,
      cycleCount: count,
      firstInstallmentMode,
    }),
  );
}

/** True when `today` is strictly after the last free flexible calendar cycle has closed. */
export function isFlexibleLockDueAfterFreePhase(today, cycles, freeCycleCount) {
  const free = Number(freeCycleCount);
  if (!free) return true;
  const rows = cycles ?? [];
  if (rows.length < free) return false;
  const lastFree = rows[free - 1];
  const expiresAt = lastFree?.expiresAt;
  if (!expiresAt) return false;
  return today > expiresAt;
}

export function buildFlexibleSchemeCycleRows({
  startDate,
  durationMonths,
  firstInstallmentMode,
}) {
  const calendar = buildCalendarMonthCycles({
    startDate,
    cycleCount: durationMonths,
    firstInstallmentMode,
  });
  return calendar.map((row) => ({
    cycle: row.cycle,
    capPaise: 0,
    paidPaise: 0,
    remainingPaise: 0,
    status: "UPCOMING",
    expiresAt: row.expiresAt,
  }));
}

/**
 * Server-authoritative calendar cycle for flexible free-phase payments.
 * Caller-supplied targetCycle must match or is rejected with INVALID_PAYMENT_CYCLE.
 */
export function resolveAuthoritativeFreePhaseTargetCycle({
  cycles,
  freeCycleCount,
  suppliedCycle,
  referenceDate,
}) {
  const free = Number(freeCycleCount);
  if (!Number.isFinite(free) || free < 1) {
    throw new AppError(
      "UNSUPPORTED_PLAN_CONFIGURATION",
      "This plan is missing flexible phase cycle configuration.",
      422,
    );
  }
  const rows = cycles ?? [];
  if (!rows.length) {
    throw new AppError("INVALID_PAYMENT_CYCLE", "This scheme has no calendar cycles.", 422);
  }
  const refDay = referenceDate ?? today();
  const refMonth = monthKey(refDay);
  const firstStart = calendarMonthBoundsFromKey(rows[0].cycle).cycleStart;
  if (refDay < firstStart) {
    throw new AppError(
      "INVALID_PAYMENT_CYCLE",
      "This scheme has not reached its first calendar cycle yet.",
      422,
    );
  }
  const cycleIndex = rows.findIndex((row) => row.cycle === refMonth);
  if (cycleIndex < 0) {
    throw new AppError(
      "INVALID_PAYMENT_CYCLE",
      "The current date is not within an active scheme calendar cycle.",
      422,
    );
  }
  if (cycleIndex >= free) {
    throw new AppError(
      "FLEXIBLE_FREE_PHASE_ENDED",
      "The flexible free phase has ended for this scheme.",
      422,
    );
  }
  const authoritative = rows[cycleIndex].cycle;
  if (suppliedCycle != null && suppliedCycle !== "" && suppliedCycle !== authoritative) {
    throw new AppError(
      "INVALID_PAYMENT_CYCLE",
      "The payment cycle must match the current calendar month for this scheme.",
      422,
    );
  }
  return authoritative;
}
