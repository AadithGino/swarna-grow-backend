import test from "node:test";
import assert from "node:assert/strict";
import {
  getReminderConfig,
  isWithinSendWindow,
  pushEnabledForType,
} from "../src/lib/reminder-config.js";

test("getReminderConfig merges tenant overrides with defaults", () => {
  const config = getReminderConfig({
    settings: {
      reminderConfig: {
        push: { enabled: false },
        offsets: [{ key: "D_DAY", enabled: false }],
      },
    },
  });
  assert.equal(config.push.enabled, false);
  const dDay = config.offsets.find((row) => row.key === "D_DAY");
  assert.equal(dDay.enabled, false);
  const dMinus1 = config.offsets.find((row) => row.key === "D_MINUS_1");
  assert.equal(dMinus1.enabled, true);
});

test("pushEnabledForType respects flexible nudge kind", () => {
  const config = getReminderConfig({});
  assert.equal(
    pushEnabledForType(config, "PAYMENT_DUE", { pushKind: "FLEX_NUDGE" }),
    true,
  );
  assert.equal(pushEnabledForType(config, "PAYMENT_DUE", {}), true);
});

test("isWithinSendWindow respects configured hours", () => {
  const noonIst = new Date("2026-09-18T07:00:00.000Z");
  assert.equal(
    isWithinSendWindow({ startTime: "09:00", endTime: "20:00", timezone: "Asia/Kolkata" }, noonIst),
    true,
  );
});
