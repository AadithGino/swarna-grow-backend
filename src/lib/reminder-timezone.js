import { env } from "../config/env.js";

/** Product invariant: reminder calendar day and send windows use India time only. */
export const REMINDER_PRODUCT_TIMEZONE = "Asia/Kolkata";

const IANA_TZ = /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/;

export function validateIanaTimezone(value) {
  if (!value || typeof value !== "string") return false;
  if (!IANA_TZ.test(value.trim())) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reminder scheduling always uses the product timezone (not server UTC).
 * Per-tenant overrides are ignored unless they match the product zone.
 */
/** Reminder/quota/lease calendar always uses the product timezone (never APP_TIMEZONE alone). */
export function resolveReminderTimezone(_tenant) {
  return REMINDER_PRODUCT_TIMEZONE;
}

export function assertReminderSchedulingTimezone() {
  const fromEnv = env.APP_TIMEZONE;
  if (fromEnv && validateIanaTimezone(fromEnv) && fromEnv !== REMINDER_PRODUCT_TIMEZONE) {
    return {
      ok: false,
      message: `APP_TIMEZONE=${fromEnv} disagrees with reminder product zone ${REMINDER_PRODUCT_TIMEZONE}`,
    };
  }
  return { ok: true };
}

export function calendarDayYmd(now = new Date(), timeZone = REMINDER_PRODUCT_TIMEZONE) {
  return now.toLocaleDateString("en-CA", { timeZone });
}
