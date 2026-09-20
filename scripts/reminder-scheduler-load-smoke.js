/**
 * Opt-in load smoke (not part of npm test): synthetic pagination sanity.
 * Usage: node --env-file=.env scripts/reminder-scheduler-load-smoke.js
 */
import { buildReminderDedupeKey } from "../src/lib/reminder-dedupe.js";

const tenantId = "tnt_load_smoke";
const today = "2026-09-18";
const keys = new Set();
for (let i = 0; i < 15_000; i += 1) {
  keys.add(
    buildReminderDedupeKey({
      tenantId,
      schemeId: `sch_${i}`,
      messageType: "PAYMENT_DUE",
      channel: "PUSH",
      offsetKey: "D_DAY",
      reminderDate: today,
      installmentNumber: i % 12,
    }),
  );
}
console.log(
  JSON.stringify(
    {
      syntheticCustomers: 15_000,
      uniqueDedupeKeys: keys.size,
      note: "Run full scheduler against seeded data separately; this script only validates dedupe key generation at scale.",
    },
    null,
    2,
  ),
);
