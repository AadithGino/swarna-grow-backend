import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { env } from "../config/env.js";

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

/** Fixed schemes mature on the last calendar day of the final installment due month. */
export function fixedMaturityDateFromFinalDueDate(finalDueDate) {
  return inTz(finalDueDate).endOf("month").format("YYYY-MM-DD");
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
