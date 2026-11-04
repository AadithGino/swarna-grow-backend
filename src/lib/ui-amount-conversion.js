import Decimal from "decimal.js";
import { AppError } from "./app-error.js";
import { assertInteger } from "./money.js";
import { UG_PER_G } from "./digital-metals-quote-engine.js";

const MAX_RUPEES_INPUT = 999_999_999.99;
const MAX_GRAMS_INPUT = 999_999.999999;

function parseDecimalInput(value, fieldName) {
  if (value === null || value === undefined || value === "") {
    throw new AppError("VALIDATION", `${fieldName} is required.`, 400, { field: fieldName });
  }
  const raw = typeof value === "number" ? String(value) : String(value).trim().replace(/,/g, "");
  if (!raw || raw === "-") {
    throw new AppError("VALIDATION", `${fieldName} must be a finite number.`, 400, { field: fieldName });
  }
  let decimal;
  try {
    decimal = new Decimal(raw);
  } catch {
    throw new AppError("VALIDATION", `${fieldName} must be a finite number.`, 400, { field: fieldName });
  }
  if (!decimal.isFinite()) {
    throw new AppError("VALIDATION", `${fieldName} must be a finite number.`, 400, { field: fieldName });
  }
  return decimal;
}

/** UI rupees (2 dp max) → integer paise (HALF_UP). Rejects excess precision (no float intermediates). */
export function rupeesToPaise(rupees, { fieldName = "amountRupees" } = {}) {
  const decimal = parseDecimalInput(rupees, fieldName);
  if (decimal.isNegative() || decimal.gt(MAX_RUPEES_INPUT)) {
    throw new AppError("VALIDATION", `${fieldName} is out of range.`, 400, { field: fieldName });
  }
  const paiseExact = decimal.mul(100);
  if (!paiseExact.isInteger()) {
    throw new AppError("VALIDATION", `${fieldName} supports at most two decimal places.`, 400, {
      field: fieldName,
    });
  }
  return assertInteger(paiseExact.toNumber(), "amountPaise");
}

/** Integer paise → rupees number for UI (2 dp). */
export function paiseToRupeesNumber(paise) {
  const p = assertInteger(paise, "amountPaise");
  return new Decimal(p).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

/** UI grams → integer micrograms (HALF_UP to whole ug). Rejects sub-microgram precision. */
export function gramsToUg(grams, { fieldName = "quantityGrams" } = {}) {
  const decimal = parseDecimalInput(grams, fieldName);
  if (decimal.isNegative() || decimal.gt(MAX_GRAMS_INPUT)) {
    throw new AppError("VALIDATION", `${fieldName} is out of range.`, 400, { field: fieldName });
  }
  const ugExact = decimal.mul(UG_PER_G);
  if (!ugExact.isInteger()) {
    throw new AppError("VALIDATION", `${fieldName} exceeds supported microgram precision.`, 400, {
      field: fieldName,
    });
  }
  return assertInteger(ugExact.toNumber(), "quantityUg");
}

/** Integer micrograms → grams number for UI (up to 6 dp, trim trailing zeros in formatters). */
export function ugToGramsNumber(ug) {
  const u = assertInteger(ug, "quantityUg");
  return new Decimal(u).div(UG_PER_G).toNumber();
}
