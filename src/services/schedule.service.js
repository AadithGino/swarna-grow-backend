import { addMonthsClamped } from "../lib/date.js";

export function buildSchedulePreview({ startDate, installmentAmountPaise = 0, durationMonths, installmentCount, scheduleRules = {} }) {
  const count = installmentCount ?? durationMonths;
  return Array.from({ length: count }, (_, index) => {
    let due = addMonthsClamped(startDate, index);
    if (scheduleRules.dueDateRule === "FIXED_DAY_OF_MONTH" && scheduleRules.dueDayOfMonth) due = due.date(Math.min(scheduleRules.dueDayOfMonth, due.daysInMonth()));
    return { number: index + 1, dueDate: due.format("YYYY-MM-DD"), graceEndsAt: due.add(scheduleRules.graceDays ?? 0, "day").format("YYYY-MM-DD"), amountPaise: installmentAmountPaise, paidPaise: 0, status: index === 0 ? "DUE" : "PENDING" };
  });
}
