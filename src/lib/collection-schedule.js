import { addMonthsClamped } from "./date.js";
import { fixedMaturityDateFromDuration } from "./calendar-cycle.js";
import { applyWeightPrecisionMg, decimalRoundingMode, moneyToWeightMg } from "./money.js";
import { AppError } from "./app-error.js";
import { isValidCalendarDateString } from "./plan-satisfiability.js";

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function resolveCollectionFrequency(plan, frequency, { required = true } = {}) {
  const rules = plan.collectionRules;
  if (!rules && !frequency) return undefined;
  if (rules && frequency && rules.frequencies.includes(frequency)) return frequency;
  if (rules && !frequency && !required) return undefined;
  throw new AppError("INVALID_COLLECTION_FREQUENCY", "Choose a collection frequency allowed by this plan.", 422, {
    field: "collectionFrequency",
  });
}

export function collectionPaymentWeightMg(amountPaise, ratePerGramPaise, goldRules = {}) {
  const rounding = decimalRoundingMode(goldRules.weightRoundingMode);
  return applyWeightPrecisionMg(
    moneyToWeightMg(amountPaise, ratePerGramPaise, rounding),
    goldRules.weightPrecisionMg,
    rounding,
  );
}

export function assertCollectionAmountsAtRate(installments, rate, goldRules) {
  if (!rate?.ratePerGramPaise) {
    throw new AppError("GOLD_RATE_NOT_SET", "Set the applicable 22K gold rate before accepting this collection.", 422);
  }
  const invalid = installments.find((row) => collectionPaymentWeightMg(row.amountPaise, rate.ratePerGramPaise, goldRules) <= 0);
  if (invalid) {
    throw new AppError("GOLD_WEIGHT_ROUNDS_TO_ZERO", "A scheduled collection is too small to credit gold. Increase the amount or choose a less frequent schedule.", 422, {
      installmentNumber: invalid.number,
      amountPaise: invalid.amountPaise,
    });
  }
}

export function buildCollectionSchedule({
  plan, startDate, collectionFrequency, collectionAmountPaise, firstInstallmentMode,
}) {
  if (!isValidCalendarDateString(startDate)) {
    throw new AppError("INVALID_COLLECTION_START_DATE", "Choose a valid collection start date.", 422);
  }
  const frequency = resolveCollectionFrequency(plan, collectionFrequency);
  const rules = plan.collectionRules;
  const collectNow = firstInstallmentMode === "COLLECT_NOW";
  const monthEnd = rules.maturityRule === "CALENDAR_MONTH_END";
  const maturityDate = monthEnd
    ? fixedMaturityDateFromDuration({ startDate, durationMonths: plan.durationMonths, firstInstallmentMode })
    : addMonthsClamped(startDate, plan.durationMonths).format("YYYY-MM-DD");
  const dueDates = [];
  for (let step = collectNow ? 0 : 1; ; step += 1) {
    const date = frequency === "MONTHLY"
      ? addMonthsClamped(startDate, step).format("YYYY-MM-DD")
      : addDays(startDate, step * (frequency === "WEEKLY" ? 7 : 1));
    if (monthEnd ? date > maturityDate : date >= maturityDate) break;
    dueDates.push(date);
  }
  if (!dueDates.length) {
    throw new AppError("EMPTY_COLLECTION_SCHEDULE", "This start date and frequency leave no collections before maturity.", 422);
  }
  const target = rules.amountBasis === "TOTAL_TARGET";
  const evenlySplit = Math.floor(collectionAmountPaise / dueDates.length);
  if (target && evenlySplit < 1) {
    throw new AppError("COLLECTION_TARGET_TOO_LOW", "The target must fund every scheduled collection.", 422);
  }
  const installments = dueDates.map((dueDate, index) => {
    const amountPaise = target
      ? evenlySplit + (index === dueDates.length - 1 ? collectionAmountPaise % dueDates.length : 0)
      : collectionAmountPaise;
    return {
      number: index + 1, dueDate, amountPaise, paidPaise: 0,
      graceEndsAt: addDays(dueDate, plan.scheduleRules?.graceDays ?? 0),
      status: index === 0 && collectNow ? "DUE" : "PENDING",
    };
  });
  const totalPaise = target ? collectionAmountPaise : collectionAmountPaise * installments.length;
  if (!Number.isSafeInteger(totalPaise) || totalPaise < 1) {
    throw new AppError("INVALID_COLLECTION_TOTAL", "The scheduled total is outside the supported range.", 422);
  }
  if (plan.paymentRules?.partialPaymentAllowed === false && plan.paymentRules?.maxPaymentPerTransactionPaise &&
    installments.some((row) => row.amountPaise > plan.paymentRules.maxPaymentPerTransactionPaise)) {
    throw new AppError("COLLECTION_EXCEEDS_PAYMENT_LIMIT", "A scheduled collection exceeds the per-payment limit.", 422);
  }
  return { maturityDate, installments, collectionFrequency: frequency, totalPaise };
}
