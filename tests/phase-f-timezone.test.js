import test from "node:test";
import assert from "node:assert/strict";
import {
  REMINDER_PRODUCT_TIMEZONE,
  calendarDayYmd,
  resolveReminderTimezone,
  validateIanaTimezone,
} from "../src/lib/reminder-timezone.js";
import { isWithinSendWindow, getReminderConfig } from "../src/lib/reminder-config.js";
import { tenantCalendarDayYmd } from "../src/lib/reminder-daily-quota.js";

test("validateIanaTimezone rejects invalid zones", () => {
  assert.equal(validateIanaTimezone("Not/AZone"), false);
  assert.equal(validateIanaTimezone(""), false);
  assert.equal(validateIanaTimezone(REMINDER_PRODUCT_TIMEZONE), true);
});

test("resolveReminderTimezone enforces India-only product invariant", () => {
  const tenant = {
    settings: {
      reminderConfig: {
        sendWindow: { timezone: "America/New_York" },
      },
    },
  };
  assert.equal(resolveReminderTimezone(tenant), REMINDER_PRODUCT_TIMEZONE);
  assert.equal(
    resolveReminderTimezone({
      settings: { reminderConfig: { sendWindow: { timezone: REMINDER_PRODUCT_TIMEZONE } } },
    }),
    REMINDER_PRODUCT_TIMEZONE,
  );
});

test("calendar day uses Asia/Kolkata not server UTC at midnight boundary", () => {
  const justBeforeIstMidnightUtc = new Date("2026-09-18T18:29:59.000Z");
  const justAfterIstMidnightUtc = new Date("2026-09-18T18:30:00.000Z");
  assert.equal(calendarDayYmd(justBeforeIstMidnightUtc), "2026-09-18");
  assert.equal(calendarDayYmd(justAfterIstMidnightUtc), "2026-09-19");
  const istAheadOfUtc = new Date("2026-09-18T20:00:00.000Z");
  assert.equal(calendarDayYmd(istAheadOfUtc), "2026-09-19");
  assert.notEqual(calendarDayYmd(istAheadOfUtc), istAheadOfUtc.toISOString().slice(0, 10));
});

test("send window evaluation uses product timezone from config", () => {
  const config = getReminderConfig({});
  assert.equal(config.sendWindow.timezone, REMINDER_PRODUCT_TIMEZONE);
  const inside = new Date("2026-09-19T04:00:00.000Z");
  assert.equal(isWithinSendWindow(config.sendWindow, inside), true);
});

test("tenantCalendarDayYmd uses product timezone regardless of tenant override", () => {
  const now = new Date("2026-09-19T12:00:00+05:30");
  const tenant = { settings: { reminderConfig: { sendWindow: { timezone: "Europe/London" } } } };
  const tz = resolveReminderTimezone(tenant);
  assert.equal(tenantCalendarDayYmd(now, tz), calendarDayYmd(now, REMINDER_PRODUCT_TIMEZONE));
});
