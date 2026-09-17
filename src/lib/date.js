import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { env } from "../config/env.js";

dayjs.extend(utc); dayjs.extend(timezone); dayjs.tz.setDefault(env.APP_TIMEZONE);
export const now = () => dayjs().tz(env.APP_TIMEZONE);
export const isoNow = () => now().format();
export const today = () => now().format("YYYY-MM-DD");
export const monthKey = (date = now()) => dayjs(date).tz(env.APP_TIMEZONE).format("YYYY-MM");
export const addMonthsClamped = (date, months) => { const source = dayjs(date).tz(env.APP_TIMEZONE); const target = source.date(1).add(months, "month"); return target.date(Math.min(source.date(), target.daysInMonth())); };
export const elapsedSchemeMonths = (startDate, referenceDate = today()) => {
  const start = dayjs(startDate).tz(env.APP_TIMEZONE).startOf("day");
  const reference = dayjs(referenceDate).tz(env.APP_TIMEZONE).startOf("day");
  if (!start.isValid() || !reference.isValid() || reference.isBefore(start)) return 0;
  let months = reference.diff(start, "month");
  if (addMonthsClamped(start, months).isAfter(reference)) months -= 1;
  return Math.max(0, months);
};
