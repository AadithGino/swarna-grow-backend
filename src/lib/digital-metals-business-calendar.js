import dayjs from "dayjs";
import { env } from "../config/env.js";

/** IST calendar date (YYYY-MM-DD) for an instant — never use UTC slice. */
export function istBusinessDateFromInstant(instant = new Date()) {
  return dayjs(instant).tz(env.APP_TIMEZONE).format("YYYY-MM-DD");
}

export function istBusinessDayBounds(businessDate) {
  const start = dayjs.tz(`${businessDate}T00:00:00.000`, env.APP_TIMEZONE);
  const end = start.add(1, "day");
  return { start: start.toDate(), end: end.toDate(), businessDate };
}

/** Exclusive lower bound for businessDate string comparisons in hedge periods. */
export function businessDateAfter(dateStr) {
  return dateStr;
}

export function businessDateOnOrBefore(reportBusinessDate, candidate) {
  return candidate <= reportBusinessDate;
}

export function businessDateInPeriodExclusiveStart(startExclusive, endInclusive, candidate) {
  return candidate > startExclusive && candidate <= endInclusive;
}

/** IST calendar dates ending on `endBusinessDate`, newest first (inclusive). */
export function listIstBusinessDatesEnding(endBusinessDate, count) {
  const n = Math.max(1, Math.min(Number(count) || 1, 90));
  const out = [];
  let cur = dayjs.tz(`${endBusinessDate}T12:00:00.000`, env.APP_TIMEZONE);
  for (let i = 0; i < n; i += 1) {
    out.push(cur.format("YYYY-MM-DD"));
    cur = cur.subtract(1, "day");
  }
  return out;
}
