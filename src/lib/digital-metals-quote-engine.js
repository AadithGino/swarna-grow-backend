/**
 * Phase 2 — exact digital metals quote arithmetic (spec §5).
 * No inventory / reservation side effects.
 */
import Decimal from "decimal.js";
import { AppError } from "./app-error.js";
import { percentOfPaiseHalfUp } from "./money.js";

export const CALCULATION_VERSION = "2026-10-15.v1";
export const UG_PER_G = 1_000_000;
export const MAX_QUANTITY_UG = 10_000_000_000;
export const MIN_RATE_PAIS_PER_G = 1;
export const MAX_RATE_PAIS_PER_G = 100_000_000;

export function metalSubtotalPaiseFromQuantity(quantityUg, ratePerGramPaise) {
  assertQuantityUg(quantityUg);
  assertRatePaise(ratePerGramPaise);
  return new Decimal(quantityUg)
    .mul(ratePerGramPaise)
    .div(UG_PER_G)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
}

export function assertQuantityUg(quantityUg) {
  if (!Number.isSafeInteger(quantityUg) || quantityUg < 0 || quantityUg > MAX_QUANTITY_UG) {
    throw new AppError("INVALID_QUANTITY", "Metal quantity is out of allowed bounds.", 422);
  }
}

export function assertRatePaise(ratePerGramPaise) {
  if (
    !Number.isSafeInteger(ratePerGramPaise)
    || ratePerGramPaise < MIN_RATE_PAIS_PER_G
    || ratePerGramPaise > MAX_RATE_PAIS_PER_G
  ) {
    throw new AppError("INVALID_RATE", "Rate per gram is out of allowed bounds.", 422);
  }
}

export function computeFeePaise(metalSubtotalPaise, feeRule) {
  const sub = Math.max(0, metalSubtotalPaise);
  if (!feeRule || feeRule.type === "NONE") return 0;
  if (feeRule.type === "FLAT_INR") {
    const flat = Number(feeRule.amountPaise ?? 0);
    if (!Number.isSafeInteger(flat) || flat < 0) {
      throw new AppError("INVALID_FEE", "Flat fee must be a non-negative integer paise.", 422);
    }
    return flat;
  }
  if (feeRule.type === "PERCENT") {
    const percent = Number(feeRule.percent ?? 0);
    let fee = new Decimal(sub).mul(percent).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const minPaise = feeRule.minPaise != null ? Number(feeRule.minPaise) : 0;
    const maxPaise = feeRule.maxPaise != null ? Number(feeRule.maxPaise) : null;
    if (minPaise) fee = Decimal.max(fee, minPaise);
    if (maxPaise != null) fee = Decimal.min(fee, maxPaise);
    return fee.toNumber();
  }
  throw new AppError("INVALID_FEE", "Unknown fee rule type.", 422);
}

const TAX_BASES = new Set(["METAL_SUBTOTAL", "FEE", "MINTING", "DELIVERY", "TOTAL_EXGST"]);

export function computeTaxLinesPaise(ctx, taxLines = []) {
  const lines = [];
  let totalTax = 0;
  for (const row of taxLines) {
    if (row?.active === false) continue;
    const baseKey = String(row.base ?? "METAL_SUBTOTAL");
    if (!TAX_BASES.has(baseKey)) {
      throw new AppError("INVALID_TAX", `Unknown tax base ${baseKey}.`, 422);
    }
    let basePaise;
    switch (baseKey) {
      case "METAL_SUBTOTAL":
        basePaise = ctx.metalSubtotalPaise;
        break;
      case "FEE":
        basePaise = ctx.feePaise;
        break;
      case "MINTING":
        basePaise = ctx.mintingPaise ?? ctx.feePaise ?? 0;
        break;
      case "DELIVERY":
        basePaise = ctx.deliveryPaise ?? 0;
        break;
      case "TOTAL_EXGST":
        basePaise =
          (ctx.metalSubtotalPaise ?? 0)
          + (ctx.feePaise ?? 0)
          + (ctx.mintingPaise ?? 0)
          + (ctx.deliveryPaise ?? 0);
        break;
      default:
        basePaise = 0;
        break;
    }
    const amountPaise = percentOfPaiseHalfUp(basePaise, Number(row.ratePercent ?? 0), {
      fieldName: row.code ?? "ratePercent",
    });
    if (amountPaise > 0) {
      lines.push({ code: row.code, base: baseKey, ratePercent: row.ratePercent, amountPaise });
      totalTax += amountPaise;
    }
  }
  return { taxLines: lines, taxPaise: totalTax };
}

function buyTotalFromQuantity(quantityUg, buyRatePaise, buyFeeRule, taxLines) {
  const metalSubtotalPaise = metalSubtotalPaiseFromQuantity(quantityUg, buyRatePaise);
  const feePaise = computeFeePaise(metalSubtotalPaise, buyFeeRule);
  const { taxLines: computedTaxLines, taxPaise } = computeTaxLinesPaise(
    { metalSubtotalPaise, feePaise },
    taxLines,
  );
  const totalPayablePaise = metalSubtotalPaise + feePaise + taxPaise;
  return { quantityUg, metalSubtotalPaise, feePaise, taxPaise, taxLines: computedTaxLines, totalPayablePaise };
}

export function maxQuantityUgForBuyBudget(budgetPaise, buyRatePaise, buyFeeRule, taxLines) {
  if (!Number.isSafeInteger(budgetPaise) || budgetPaise <= 0) {
    throw new AppError("INVALID_BUDGET", "Budget must be a positive integer paise.", 422);
  }
  let lo = 0;
  let hi = Math.min(MAX_QUANTITY_UG, budgetPaise * UG_PER_G);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const { totalPayablePaise } = buyTotalFromQuantity(mid, buyRatePaise, buyFeeRule, taxLines);
    if (totalPayablePaise <= budgetPaise) lo = mid;
    else hi = mid - 1;
  }
  const result = buyTotalFromQuantity(lo, buyRatePaise, buyFeeRule, taxLines);
  if (result.totalPayablePaise <= 0 || result.quantityUg <= 0) {
    throw new AppError("QUOTE_NONPOSITIVE", "Budget cannot purchase a positive metal quantity at current rates.", 422);
  }
  return {
    ...result,
    budgetRemainderPaise: budgetPaise - result.totalPayablePaise,
  };
}

export function buildBuyQuotePayload({
  inputMode,
  budgetPaise,
  quantityUg,
  buyRatePerGramPaise,
  buyFeeRule,
  taxLines,
}) {
  let core;
  if (inputMode === "BUDGET_INR") {
    core = maxQuantityUgForBuyBudget(budgetPaise, buyRatePerGramPaise, buyFeeRule, taxLines);
  } else if (inputMode === "QUANTITY_UG") {
    assertQuantityUg(quantityUg);
    if (quantityUg <= 0) throw new AppError("INVALID_QUANTITY", "Quantity must be positive.", 422);
    core = buyTotalFromQuantity(quantityUg, buyRatePerGramPaise, buyFeeRule, taxLines);
    core.budgetRemainderPaise = 0;
  } else {
    throw new AppError("INVALID_INPUT_MODE", "inputMode must be BUDGET_INR or QUANTITY_UG.", 422);
  }
  if (core.totalPayablePaise <= 0) {
    throw new AppError("QUOTE_NONPOSITIVE", "Payable amount must be positive.", 422);
  }
  return core;
}

export function buildSellQuotePayload({
  quantityUg,
  sellRatePerGramPaise,
  sellFeeRule,
  taxLines,
}) {
  assertQuantityUg(quantityUg);
  if (quantityUg <= 0) throw new AppError("INVALID_QUANTITY", "Quantity must be positive.", 422);
  const metalSubtotalPaise = metalSubtotalPaiseFromQuantity(quantityUg, sellRatePerGramPaise);
  const feePaise = computeFeePaise(metalSubtotalPaise, sellFeeRule);
  const { taxLines: computedTaxLines, taxPaise } = computeTaxLinesPaise(
    { metalSubtotalPaise, feePaise },
    taxLines,
  );
  const settlementPaise = metalSubtotalPaise - feePaise - taxPaise;
  if (settlementPaise <= 0) {
    throw new AppError("QUOTE_NONPOSITIVE", "Net settlement must be positive.", 422);
  }
  return {
    quantityUg,
    metalSubtotalPaise,
    feePaise,
    taxPaise,
    taxLines: computedTaxLines,
    settlementPaise,
  };
}

/** Redemption minting/packaging/delivery charges (INR only — no extra metal deduction). */
export function buildRedemptionChargePayload({
  unitCount,
  unitQuantityUg,
  mintingRule,
  mintingPercentBase,
  metalValuePaisePerUnit,
  packagingPaisePerUnit,
  deliveryFlatPaise,
  deliveryWaiveAboveTotalChargePaise,
  fulfilmentMode,
  taxLines,
}) {
  const count = Number(unitCount);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new AppError("INVALID_QUANTITY", "Unit count must be a positive integer.", 422);
  }
  assertQuantityUg(unitQuantityUg);
  const quantityUg = unitQuantityUg * count;
  const mintingPerUnit =
    mintingPercentBase === "METAL_VALUE_AT_BUY_RATE"
      ? computeFeePaise(metalValuePaisePerUnit, mintingRule)
      : computeFeePaise(0, mintingRule);
  const mintingPaise = mintingPerUnit * count;
  const packagingPaise = Math.max(0, Number(packagingPaisePerUnit ?? 0)) * count;
  let deliveryPaise =
    fulfilmentMode === "DELIVERY" ? Math.max(0, Number(deliveryFlatPaise ?? 0)) : 0;
  const subtotalBeforeDelivery = mintingPaise + packagingPaise;
  if (
    deliveryWaiveAboveTotalChargePaise != null
    && subtotalBeforeDelivery >= Number(deliveryWaiveAboveTotalChargePaise)
  ) {
    deliveryPaise = 0;
  }
  const feePaise = mintingPaise + packagingPaise;
  const { taxLines: computedTaxLines, taxPaise } = computeTaxLinesPaise(
    { metalSubtotalPaise: 0, feePaise, mintingPaise, deliveryPaise },
    taxLines,
  );
  const totalChargePaise = feePaise + deliveryPaise + taxPaise;
  return {
    unitCount: count,
    unitQuantityUg,
    quantityUg,
    mintingPaise,
    packagingPaise,
    deliveryPaise,
    feePaise,
    taxPaise,
    taxLines: computedTaxLines,
    totalChargePaise,
  };
}

export function isRateStale(rateRow, maxAgeSeconds, now = new Date()) {
  if (!rateRow?.publishedAt) return true;
  const publishedAt = new Date(rateRow.publishedAt).getTime();
  const ageMs = now.getTime() - publishedAt;
  return ageMs > maxAgeSeconds * 1000;
}
