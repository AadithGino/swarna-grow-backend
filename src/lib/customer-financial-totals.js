import { LedgerEntryType, PaymentStatus } from "../constants/enums.js";
import { NET_COLLECTION_PAYMENT_STATUSES } from "./payment-net-aggregation.js";

const LIFETIME_PAID_CREDITS = new Set([
  LedgerEntryType.INSTALLMENT_PAYMENT,
  "INSTALLMENT_PAYMENT",
  LedgerEntryType.FREE_WINDOW_PAYMENT,
  "FREE_WINDOW_PAYMENT",
]);

/** Net allocated principal from ledger (instalments + free window minus reversals; no benefit/unallocated). */
export function lifetimePaidPaiseFromLedgerEntries(entries) {
  return Math.max(
    0,
    (entries ?? []).reduce((sum, entry) => {
      if (
        entry.type === LedgerEntryType.UNALLOCATED_PAYMENT ||
        entry.type === "UNALLOCATED_PAYMENT"
      ) {
        return sum;
      }
      const amount = Number(entry.amountPaise ?? 0);
      if (LIFETIME_PAID_CREDITS.has(entry.type)) return sum + amount;
      if (entry.type === LedgerEntryType.REVERSAL || entry.type === "REVERSAL") {
        return sum - amount;
      }
      return sum;
    }, 0),
  );
}

/** Net gold weight from ledger on gold-weight schemes only (excludes unallocated rows). */
export function netGoldWeightMgFromLedgerEntries(entries, goldSchemeIds = null) {
  const goldSet =
    goldSchemeIds instanceof Set
      ? goldSchemeIds
      : goldSchemeIds
        ? new Set([...goldSchemeIds].map(String))
        : null;
  return Math.max(
    0,
    (entries ?? []).reduce((sum, entry) => {
      if (
        entry.type === LedgerEntryType.UNALLOCATED_PAYMENT ||
        entry.type === "UNALLOCATED_PAYMENT"
      ) {
        return sum;
      }
      if (goldSet && entry.schemeId && !goldSet.has(String(entry.schemeId))) {
        return sum;
      }
      const weight = Number(entry.weightMg ?? 0);
      if (LIFETIME_PAID_CREDITS.has(entry.type)) return sum + weight;
      if (entry.type === LedgerEntryType.REVERSAL || entry.type === "REVERSAL") {
        return sum - weight;
      }
      return sum;
    }, 0),
  );
}

/** Business payments that count toward collection (excludes suspense/unallocated). */
export function isAllocatedBusinessPayment(payment) {
  if (!payment) return false;
  if (payment.status === PaymentStatus.UNALLOCATED_PENDING_REVIEW) return false;
  if (!NET_COLLECTION_PAYMENT_STATUSES.includes(payment.status)) return false;
  const allocated = Number(payment.allocatedAmountPaise ?? payment.amountPaise ?? 0);
  return allocated > 0;
}

export function countAllocatedBusinessPayments(payments) {
  return (payments ?? []).filter(isAllocatedBusinessPayment).length;
}
