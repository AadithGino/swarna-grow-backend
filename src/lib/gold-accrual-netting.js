import Decimal from "decimal.js";
import { LedgerEntryType } from "../constants/enums.js";
import { moneyPaiseFromWeightMg } from "./money.js";

const ACCRUAL_CREDIT_TYPES = new Set([
  LedgerEntryType.INSTALLMENT_PAYMENT,
  LedgerEntryType.FREE_WINDOW_PAYMENT,
]);

/** Net weight/amount deltas for gold accrual reporting (payments minus reversals only). */
export function goldAccrualDeltasForEntry(entry) {
  const weightMg = Number(entry.weightMg ?? 0);
  const amountPaise = Number(entry.amountPaise ?? 0);
  if (entry.type === LedgerEntryType.REVERSAL) {
    return { weightMg: -weightMg, amountPaise: -amountPaise };
  }
  if (ACCRUAL_CREDIT_TYPES.has(entry.type)) {
    return { weightMg, amountPaise };
  }
  return { weightMg: 0, amountPaise: 0 };
}

export function foldGoldAccrualNet(entries) {
  return entries.reduce(
    (acc, entry) => {
      const delta = goldAccrualDeltasForEntry(entry);
      return {
        weightMg: acc.weightMg + delta.weightMg,
        amountPaise: acc.amountPaise + delta.amountPaise,
      };
    },
    { weightMg: 0, amountPaise: 0 },
  );
}

export function displayNetGoldWeightMg(netWeightMg) {
  return Math.max(0, netWeightMg);
}

export function displayNetGoldAmountPaise(netAmountPaise) {
  return Math.max(0, netAmountPaise);
}

/** Weighted acquisition rate from net paid principal and net credited weight (integer paise per gram). */
export function weightedAccrualRatePerGramPaise(netAmountPaise, netWeightMg) {
  const weightMg = displayNetGoldWeightMg(netWeightMg);
  if (weightMg <= 0 || netAmountPaise <= 0) return 0;
  return new Decimal(netAmountPaise)
    .mul(1000)
    .div(weightMg)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
}

export function goldAccrualLiabilityPaise(netWeightMg, ratePerGramPaise) {
  const weightMg = displayNetGoldWeightMg(netWeightMg);
  if (weightMg <= 0 || !ratePerGramPaise) return 0;
  return moneyPaiseFromWeightMg(weightMg, ratePerGramPaise);
}

export function goldAccrualRateExposurePaise(liabilityPaise, netAmountPaise) {
  const received = displayNetGoldAmountPaise(netAmountPaise);
  return Math.max(0, liabilityPaise - received);
}

export function goldAccrualMongoWeightDeltaExpr() {
  return {
    $switch: {
      branches: [
        {
          case: {
            $in: [
              "$type",
              [LedgerEntryType.INSTALLMENT_PAYMENT, LedgerEntryType.FREE_WINDOW_PAYMENT],
            ],
          },
          then: { $ifNull: ["$weightMg", 0] },
        },
        {
          case: { $eq: ["$type", LedgerEntryType.REVERSAL] },
          then: { $multiply: [{ $ifNull: ["$weightMg", 0] }, -1] },
        },
      ],
      default: 0,
    },
  };
}

export function goldAccrualMongoAmountDeltaExpr() {
  return {
    $switch: {
      branches: [
        {
          case: {
            $in: [
              "$type",
              [LedgerEntryType.INSTALLMENT_PAYMENT, LedgerEntryType.FREE_WINDOW_PAYMENT],
            ],
          },
          then: { $ifNull: ["$amountPaise", 0] },
        },
        {
          case: { $eq: ["$type", LedgerEntryType.REVERSAL] },
          then: { $multiply: [{ $ifNull: ["$amountPaise", 0] }, -1] },
        },
      ],
      default: 0,
    },
  };
}
