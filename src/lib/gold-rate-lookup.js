import { GoldRate } from "../models/index.js";
import { AppError } from "./app-error.js";

export const V1_GOLD_PURITY = "22K";

export function assertV1GoldPurity(purity) {
  const normalized = purity ?? V1_GOLD_PURITY;
  if (normalized !== V1_GOLD_PURITY) {
    throw new AppError(
      "GOLD_PURITY_NOT_SUPPORTED",
      "Only 22K gold rates are supported.",
      400,
      { purity: normalized },
    );
  }
}

function branchScope(scope) {
  return [{ branchId: scope.branchId ?? null }, { branchId: null }];
}

/** Exact calendar-day 22K rate (handover completion). */
export async function goldRateForExactDate(scope, dateYmd, session = null) {
  const query = GoldRate.findOne({
    tenantId: scope.tenantId,
    effectiveDate: dateYmd,
    purity: V1_GOLD_PURITY,
    $or: branchScope(scope),
  })
    .sort({ branchId: -1, createdAt: -1 });
  if (session) query.session(session);
  return query.lean();
}

/** Today's / payment-day 22K rate. */
export async function currentGoldRate22K(scope, dateYmd, session = null) {
  return goldRateForExactDate(scope, dateYmd, session);
}

/** Latest 22K rate on or before date (maturity benefit valuation). */
export async function latestGoldRate22KOnOrBefore(scope, dateYmd, session = null) {
  const query = GoldRate.findOne({
    tenantId: scope.tenantId,
    effectiveDate: { $lte: dateYmd },
    purity: V1_GOLD_PURITY,
    $or: branchScope(scope),
  })
    .sort({ effectiveDate: -1, branchId: -1, createdAt: -1 });
  if (session) query.session(session);
  return query.lean();
}
