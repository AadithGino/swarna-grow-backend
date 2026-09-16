import Decimal from "decimal.js";

const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
export const assertInteger = (value, name = "value") => { if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`); return value; };
export const moneyRef = (amountPaise = 0) => ({ amountPaise: assertInteger(amountPaise, "amountPaise"), amountDisplay: formatter.format(new Decimal(amountPaise).div(100).toNumber()) });
export const weightRef = (weightMg = 0) => ({ weightMg: assertInteger(weightMg, "weightMg"), weightDisplay: `${new Decimal(weightMg).div(1000).toFixed(3)} g` });
export const rateRef = (ratePerGramPaise = 0) => ({ ratePerGramPaise: assertInteger(ratePerGramPaise, "ratePerGramPaise"), ratePerGramDisplay: formatter.format(new Decimal(ratePerGramPaise).div(100).toNumber()) });
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
