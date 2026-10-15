import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { env } from "../config/env.js";
import { today } from "./date.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = env.APP_TIMEZONE ?? "Asia/Kolkata";

/** Past effective dates must not trigger current-rate announcements. */
export const ECOMMERCE_PUBLISH_NOW_GRACE_MS = 2 * 60 * 1000;

export function isHistoricalSchemeEffectiveDate(effectiveDateYmd) {
  return String(effectiveDateYmd).slice(0, 10) < today();
}

export function schemeNotificationScheduledFor(effectiveDateYmd) {
  const ymd = String(effectiveDateYmd).slice(0, 10);
  const startIst = dayjs.tz(`${ymd}T00:00:00`, TZ);
  const now = dayjs().tz(TZ);
  if (ymd > today()) {
    return startIst.toDate();
  }
  if (ymd === today()) {
    return now.toDate();
  }
  return null;
}

export function isHistoricalEcommerceEffectiveAt(effectiveAt, nowMs = Date.now()) {
  const at = new Date(effectiveAt).getTime();
  return at < nowMs - ECOMMERCE_PUBLISH_NOW_GRACE_MS;
}

export function ecommerceNotificationScheduledFor(effectiveAt, nowMs = Date.now()) {
  const at = new Date(effectiveAt).getTime();
  if (isHistoricalEcommerceEffectiveAt(effectiveAt, nowMs)) {
    return null;
  }
  return new Date(Math.max(at, nowMs));
}
