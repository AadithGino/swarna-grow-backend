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
