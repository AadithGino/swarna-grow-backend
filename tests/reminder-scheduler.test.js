import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReminderDedupeKey,
  deterministicReminderMessageId,
} from "../src/lib/reminder-dedupe.js";
import { evaluateReminderChannels } from "../src/lib/reminder-channel-eligibility.js";
import { getReminderConfig } from "../src/lib/reminder-config.js";
import { reminderLeaseKey } from "../src/lib/reminder-scheduler-lease.js";

test("reminder dedupe key is channel-specific and stable", () => {
  const base = {
    tenantId: "tnt_1",
    schemeId: "sch_1",
    messageType: "PAYMENT_DUE",
    offsetKey: "D_MINUS_1",
    reminderDate: "2026-09-18",
    installmentNumber: 2,
  };
  const wa = buildReminderDedupeKey({ ...base, channel: "WHATSAPP" });
  const push = buildReminderDedupeKey({ ...base, channel: "PUSH" });
  assert.notEqual(wa, push);
  assert.equal(wa, buildReminderDedupeKey({ ...base, channel: "WHATSAPP" }));
  assert.match(deterministicReminderMessageId(wa), /^msg_[a-f0-9]{26}$/);
});

test("WhatsApp opt-out blocks WhatsApp only, not push", () => {
  const config = getReminderConfig({});
  const optedOut = { whatsappOptedOutAt: new Date() };
  const channels = evaluateReminderChannels({
    config,
    customer: optedOut,
    type: "PAYMENT_DUE",
    templateParams: {},
    pushOnly: false,
    pushCountToday: 0,
  });
  assert.equal(channels.whatsapp, false);
  assert.equal(channels.push, true);
});

test("push daily cap blocks push only", () => {
  const config = getReminderConfig({});
  const channels = evaluateReminderChannels({
    config,
    customer: {},
    type: "PAYMENT_DUE",
    templateParams: {},
    pushOnly: false,
    pushCountToday: 99,
  });
  assert.equal(channels.whatsapp, false);
  assert.equal(channels.push, false);
});

test("scheduler lease key includes tenant date and window", () => {
  assert.equal(
    reminderLeaseKey({ tenantId: "tnt_a", today: "2026-09-18", windowKey: "09:00-20:00" }),
    "swarnagrow:reminder:lease:tnt_a:2026-09-18:09:00-20:00",
  );
});

test("payment reminders stop when the installment or capped contribution is resolved", async () => {
  const { isPaymentReminderCurrent, paymentReminderTargets } = await import("../src/lib/reminder-payment-target.js");
  const fixed = { status: "ACTIVE", paymentPattern: "FIXED", installments: [
    { number: 1, dueDate: "2026-05-31", status: "DUE", amountPaise: 1500, paidPaise: 500 },
  ] };
  const reminder = { templateParams: { installmentNumber: 1, dueDate: "2026-05-31" } };
  assert.equal(isPaymentReminderCurrent(reminder, fixed, "2026-05-31"), true);
  for (const status of ["PAID", "WAIVED"]) {
    fixed.installments[0].status = status;
    assert.equal(isPaymentReminderCurrent(reminder, fixed, "2026-05-31"), false);
  }
  const capped = { status: "LOCKED", paymentPattern: "FLEXIBLE", flexiblePhase: "CAPPED", cycles: [
    { cycle: "2026-05", expiresAt: "2026-05-31", status: "PARTIALLY_PAID", capPaise: 1500, paidPaise: 500 },
  ] };
  assert.deepEqual(paymentReminderTargets(capped, "2026-05-31"), [{ cycleKey: "2026-05", dueDate: "2026-05-31" }]);
  const cycleReminder = { templateParams: { cycleKey: "2026-05", dueDate: "2026-05-31" } };
  assert.equal(isPaymentReminderCurrent(cycleReminder, capped, "2026-05-31"), true);
  assert.equal(isPaymentReminderCurrent(cycleReminder, capped, "2026-06-01"), false);
  capped.cycles[0].paidPaise = 1500;
  assert.equal(isPaymentReminderCurrent(cycleReminder, capped, "2026-05-31"), false);
});
