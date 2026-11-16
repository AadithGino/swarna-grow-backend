import { MessageType, SchemeStatus } from "../constants/enums.js";

export const REMINDABLE_PAYMENT_STATUSES = [
  SchemeStatus.ACTIVE, SchemeStatus.DEFAULTED, SchemeStatus.LOCKED, SchemeStatus.PENDING_PAYMENT,
];

function installmentOutstanding(row) {
  return Boolean(row && !["PAID", "WAIVED"].includes(row.status) && row.amountPaise > (row.paidPaise ?? 0));
}

export function cappedReminderOutstanding(scheme, cycleKey, today) {
  if (scheme.flexiblePhase !== "CAPPED" || ![SchemeStatus.ACTIVE, SchemeStatus.LOCKED].includes(scheme.status)) return false;
  if (cycleKey !== today.slice(0, 7)) return false;
  const cycle = scheme.cycles?.find((row) => row.cycle === cycleKey);
  return Boolean(cycle && cycle.expiresAt >= today && cycle.capPaise > (cycle.paidPaise ?? 0) &&
    ["UPCOMING", "PARTIALLY_PAID"].includes(cycle.status));
}

export function paymentReminderTargets(scheme, today) {
  const firstPayment = scheme.status === SchemeStatus.PENDING_PAYMENT;
  if (firstPayment && scheme.paymentPattern === "FLEXIBLE") {
    return [{ dueDate: scheme.startDate, firstPayment }];
  }
  if (scheme.paymentPattern === "FIXED") {
    return (scheme.installments ?? [])
      .filter((row) => installmentOutstanding(row) && (!firstPayment || row.number === 1))
      .map((row) => ({ dueDate: row.dueDate, installmentNumber: row.number, firstPayment }));
  }
  const cycleKey = today.slice(0, 7);
  if (!cappedReminderOutstanding(scheme, cycleKey, today)) return [];
  const cycle = scheme.cycles.find((row) => row.cycle === cycleKey);
  return [{ dueDate: cycle.expiresAt, cycleKey }];
}

export function isScheduledPaymentReminder(message) {
  return Boolean(message.reminderDedupeKey &&
    [MessageType.PAYMENT_DUE, MessageType.PAYMENT_OVERDUE].includes(message.type));
}

export function isPaymentReminderCurrent(message, scheme, today) {
  if (!scheme || !REMINDABLE_PAYMENT_STATUSES.includes(scheme.status)) return false;
  const { installmentNumber, cycleKey, firstPayment, dueDate, pushKind } = message.templateParams ?? {};
  if (firstPayment && scheme.status !== SchemeStatus.PENDING_PAYMENT) return false;
  if (cycleKey) return paymentReminderTargets(scheme, today).some((target) => target.cycleKey === cycleKey && target.dueDate === dueDate);
  if (installmentNumber != null || firstPayment) {
    return paymentReminderTargets(scheme, today).some((target) =>
      target.installmentNumber === installmentNumber && (!dueDate || target.dueDate === dueDate));
  }
  return pushKind !== "FLEX_NUDGE" || scheme.flexiblePhase === "FLEXIBLE";
}
