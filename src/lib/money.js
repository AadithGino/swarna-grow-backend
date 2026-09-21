import Decimal from "decimal.js";
import { AppError } from "./app-error.js";

const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

/** Rupee paise from gold weight at settlement (not plan weight-rounding policy). */
export const MONEY_PAISE_ROUNDING = Decimal.ROUND_HALF_UP;

export const assertInteger = (value, name = "value") => { if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`); return value; };

function safeIntegerFromDecimal(decimal, name = "amountPaise") {
  if (!decimal.isFinite()) {
    throw new AppError("AMOUNT_OUT_OF_RANGE", `${name} is not a finite amount.`, 400);
  }
  const floored = decimal.floor();
  if (!floored.isInteger()) {
    throw new AppError("AMOUNT_OUT_OF_RANGE", `${name} must resolve to a whole paise amount.`, 400);
  }
  if (floored.gt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError("AMOUNT_OUT_OF_RANGE", `${name} exceeds supported safe integer range.`, 400);
  }
  const value = floored.toNumber();
  assertInteger(value, name);
  return value;
}

/**
 * Percentage of an integer paise base, rounded down to whole paise (no float intermediates).
 * Percent must be 0–100 inclusive.
 */
export function percentOfPaiseFloor(basePaise, percent, { fieldName = "percent" } = {}) {
  const base = assertInteger(Math.max(0, basePaise), "basePaise");
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    throw new AppError(
      "INVALID_PERCENT",
      `${fieldName} must be a finite number.`,
      400,
      { fieldName, percent },
    );
  }
  if (percent < 0 || percent > 100) {
    throw new AppError(
      "INVALID_PERCENT",
      `${fieldName} must be between 0 and 100.`,
      400,
      { fieldName, percent },
    );
  }
  if (percent === 0 || base === 0) return 0;
  return safeIntegerFromDecimal(
    new Decimal(base).mul(percent).div(100),
    "percentAmountPaise",
  );
}

/** mg → paise for settlement valuation (HALF_UP to whole paise; independent of weightRoundingMode). */
export function moneyPaiseFromWeightMg(weightMg, ratePerGramPaise) {
  return weightMgToMoneyPaise(weightMg, ratePerGramPaise, MONEY_PAISE_ROUNDING);
}
export const moneyRef = (amountPaise = 0) => ({ amountPaise: assertInteger(amountPaise, "amountPaise"), amountDisplay: formatter.format(new Decimal(amountPaise).div(100).toNumber()) });
export const weightRef = (weightMg = 0) => ({ weightMg: assertInteger(weightMg, "weightMg"), weightDisplay: `${new Decimal(weightMg).div(1000).toFixed(3)} g` });
export const rateRef = (ratePerGramPaise = 0) => ({ ratePerGramPaise: assertInteger(ratePerGramPaise, "ratePerGramPaise"), ratePerGramDisplay: formatter.format(new Decimal(ratePerGramPaise).div(100).toNumber()) });
export function decimalRoundingMode(mode) {
  if (mode === "ROUND_DOWN") return Decimal.ROUND_DOWN;
  if (mode === "ROUND_UP") return Decimal.ROUND_UP;
  return Decimal.ROUND_HALF_UP;
}

export function applyWeightPrecisionMg(weightMg, precisionMg, rounding = Decimal.ROUND_DOWN) {
  assertInteger(weightMg, "weightMg");
  const step = Math.max(1, Number(precisionMg ?? 1));
  if (step <= 1) return weightMg;
  return new Decimal(weightMg).div(step).toDecimalPlaces(0, rounding).mul(step).toNumber();
}

export function moneyToWeightMg(amountPaise, ratePerGramPaise, rounding = Decimal.ROUND_HALF_UP) {
  assertInteger(amountPaise, "amountPaise"); assertInteger(ratePerGramPaise, "ratePerGramPaise");
  if (ratePerGramPaise <= 0) throw new RangeError("ratePerGramPaise must be positive");
  return new Decimal(amountPaise).mul(1000).div(ratePerGramPaise).toDecimalPlaces(0, rounding).toNumber();
}
export function weightMgToMoneyPaise(weightMg, ratePerGramPaise, rounding = Decimal.ROUND_HALF_UP) {
  assertInteger(weightMg, "weightMg"); assertInteger(ratePerGramPaise, "ratePerGramPaise");
  if (ratePerGramPaise <= 0) throw new RangeError("ratePerGramPaise must be positive");
  return new Decimal(weightMg).mul(ratePerGramPaise).div(1000).toDecimalPlaces(0, rounding).toNumber();
}
