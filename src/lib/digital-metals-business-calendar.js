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
