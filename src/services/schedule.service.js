import dayjs from "dayjs";
import { addMonthsClamped } from "../lib/date.js";
import { fixedMaturityDateFromFinalDueDate } from "../lib/calendar-cycle.js";

export function resolveFixedSchemeMaturityDate(installmentRows) {
  if (!installmentRows?.length) return null;
  return fixedMaturityDateFromFinalDueDate(installmentRows[installmentRows.length - 1].dueDate);
}

function resolveFirstInstallmentDueDate(startDate, scheduleRules, firstInstallmentMode) {
  const start = dayjs(startDate);
  if (firstInstallmentMode === "COLLECT_NOW") return start.format("YYYY-MM-DD");
  if (scheduleRules.dueDateRule === "JOIN_ANNIVERSARY") {
    return addMonthsClamped(startDate, 1).format("YYYY-MM-DD");
  }
  const dueDay = scheduleRules.dueDayOfMonth ?? start.date();
  const thisMonth = start.date(Math.min(dueDay, start.daysInMonth()));
  if (thisMonth.isAfter(start, "day")) return thisMonth.format("YYYY-MM-DD");
  const nextMonth = start.add(1, "month");
  return nextMonth.date(Math.min(dueDay, nextMonth.daysInMonth())).format("YYYY-MM-DD");
}

export function buildSchedulePreview({
  startDate,
  installmentAmountPaise = 0,
  durationMonths,
  installmentCount,
  scheduleRules = {},
  firstInstallmentMode,
}) {
  const count = installmentCount ?? durationMonths;
  if (firstInstallmentMode == null) {
    return Array.from({ length: count }, (_, index) => {
      let due = addMonthsClamped(startDate, index);
      if (scheduleRules.dueDateRule === "FIXED_DAY_OF_MONTH" && scheduleRules.dueDayOfMonth) due = due.date(Math.min(scheduleRules.dueDayOfMonth, due.daysInMonth()));
      return { number: index + 1, dueDate: due.format("YYYY-MM-DD"), graceEndsAt: due.add(scheduleRules.graceDays ?? 0, "day").format("YYYY-MM-DD"), amountPaise: installmentAmountPaise, paidPaise: 0, status: index === 0 ? "DUE" : "PENDING" };
    });
  }
  const mode = firstInstallmentMode ?? scheduleRules.firstInstallmentModeDefault ?? "START_NEXT_CYCLE";
  const firstDue = resolveFirstInstallmentDueDate(startDate, scheduleRules, mode);
  return Array.from({ length: count }, (_, index) => {
    let due = index === 0 ? dayjs(firstDue) : addMonthsClamped(firstDue, index);
    if (index > 0 && scheduleRules.dueDateRule === "FIXED_DAY_OF_MONTH" && scheduleRules.dueDayOfMonth) {
      due = due.date(Math.min(scheduleRules.dueDayOfMonth, due.daysInMonth()));
    }
    return {
      number: index + 1,
      dueDate: due.format("YYYY-MM-DD"),
      graceEndsAt: due.add(scheduleRules.graceDays ?? 0, "day").format("YYYY-MM-DD"),
      amountPaise: installmentAmountPaise,
      paidPaise: 0,
      status: index === 0 && mode === "COLLECT_NOW" ? "DUE" : "PENDING",
    };
  });
}
