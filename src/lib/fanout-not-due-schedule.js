import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { env } from "../config/env.js";
import { now as calendarNow } from "./date.js";
import {
  ecommerceNotificationScheduledFor,
  schemeNotificationScheduledFor,
} from "./gold-rate-notification-schedule.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = env.APP_TIMEZONE ?? "Asia/Kolkata";

/** Next wall-clock instant when a NOT_DUE fanout may proceed (IST business-day start for scheme rates). */
export function resolveFanoutNotDueResumeAt(broadcast, nowMs = calendarNow().valueOf()) {
  if (broadcast.schemeEffectiveDate) {
    const at = schemeNotificationScheduledFor(broadcast.schemeEffectiveDate);
    if (at && at.getTime() > nowMs) return at;
    return null;
  }
  if (broadcast.ecommerceEffectiveAt) {
    const at = ecommerceNotificationScheduledFor(broadcast.ecommerceEffectiveAt, nowMs);
    if (at && at.getTime() > nowMs) return at;
    return null;
  }
  return null;
}

export function fanoutDueJobId(broadcastId, resumeAt, businessYmd) {
  const ymd = businessYmd
    ? String(businessYmd).slice(0, 10)
    : dayjs(resumeAt).tz(TZ).format("YYYY-MM-DD");
  return `${broadcastId}-fanout-due-${ymd}`;
}
