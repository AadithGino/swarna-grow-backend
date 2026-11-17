import { errors } from "./app-error.js";
import { addPaise } from "./ecommerce-exact-money.js";

export function remainingSchemeEntitlement({ balance, basis, waiverCapPaise, reservations }) {
  let used = 0;
  let ceiling = balance;
  let usedWaiver = 0;
  for (const row of reservations) {
    if (row.status === "RELEASED") continue;
    const netUnits = row.units - (row.restoredUnits ?? 0);
    const netWaiver = row.waiverPaise - (row.restoredWaiverPaise ?? 0);
    if (netUnits > 0 && row.basis !== basis) {
      throw errors.business("SCHEME_SETTLEMENT_BASIS_IN_USE", "Use the settlement basis already used on this scheme.");
    }
    if (netUnits > 0 && basis === "CASH_VALUE" && Number.isSafeInteger(row.balanceAtReservation)) {
      ceiling = Math.min(ceiling, row.balanceAtReservation);
    }
    used = addPaise(used, netUnits);
    usedWaiver = addPaise(usedWaiver, netWaiver);
  }
  return {
    balance: Math.max(0, ceiling - used),
    waiverCapPaise: waiverCapPaise == null ? undefined : Math.max(0, waiverCapPaise - usedWaiver),
  };
}

const fraction = (value, count, quantity) => Number(BigInt(value) * BigInt(count) / BigInt(quantity));

export function allocateSchemeBenefit(lines, benefitUnits) {
  const total = lines.reduce((sum, line) => addPaise(sum, line.schemeUnits), 0);
  let used = 0;
  return lines.map((line) => {
    const before = used;
    used += line.schemeUnits;
    return { ...line, benefitUnits: total ? fraction(benefitUnits, used, total) - fraction(benefitUnits, before, total) : 0 };
  });
}

export function returnedSchemeBenefitUnits(line, count) {
  if (!line.schemeUnits) return 0;
  const returnedUnits = fraction(line.schemeUnits, count, line.quantity);
  return fraction(line.benefitUnits ?? 0, returnedUnits, line.schemeUnits);
}

/** Allocate a return from immutable order amounts. The final unit carries the rounding remainder. */
export function calculateSchemeReturn(lines, items) {
  const next = lines.map((line) => ({ ...line }));
  let restoredUnits = 0;
  let restoredBenefitUnits = 0;
  let refundedCashPaise = 0;
  let restoredWaiverPaise = 0;
  const byProduct = new Map(next.map((line) => [line.productId, line]));
  const seen = new Set();
  if (!items.length) throw errors.business("INVALID_SCHEME_RETURN", "Choose at least one item to return.");
  for (const { productId, quantity } of items) {
    const line = byProduct.get(productId);
    const before = line?.returnedQuantity ?? 0;
    const after = before + quantity;
    if (!line || seen.has(productId) || !Number.isSafeInteger(quantity) || quantity < 1 || after > line.quantity) {
      throw errors.business("INVALID_SCHEME_RETURN", "Return quantity exceeds the remaining order quantity.");
    }
    seen.add(productId);
    const refund = (value) => fraction(value, after, line.quantity) - fraction(value, before, line.quantity);
    const returnedSchemeUnits = refund(line.schemeUnits);
    restoredUnits = addPaise(restoredUnits, returnedSchemeUnits);
    restoredBenefitUnits = addPaise(restoredBenefitUnits, returnedSchemeBenefitUnits(line, after) - returnedSchemeBenefitUnits(line, before));
    refundedCashPaise = addPaise(refundedCashPaise, refund(line.cashPaise));
    restoredWaiverPaise = addPaise(restoredWaiverPaise, refund(line.waiverPaise));
    line.returnedQuantity = after;
  }
  return { lines: next, restoredUnits, restoredBenefitUnits, refundedCashPaise, restoredWaiverPaise };
}
