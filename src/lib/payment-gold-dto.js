import { goldAccrualLiabilityPaise } from "./gold-accrual-netting.js";
import { netWeightMgFromDoc } from "./payment-net-aggregation.js";
import { moneyRef, rateRef, weightRef } from "./money.js";

function buildGoldAccrualBlock(weightMg, ratePerGramPaise, purchasedAt) {
  if (weightMg <= 0 && ratePerGramPaise <= 0) return null;
  const weight = weightRef(weightMg);
  const ratePerGram = rateRef(ratePerGramPaise);
  const valuePaise = goldAccrualLiabilityPaise(weightMg, ratePerGramPaise);
  return {
    weightMg,
    weightDisplay: weight.weightDisplay,
    weight,
    ratePerGramPaise,
    ratePerGramDisplay: ratePerGram.ratePerGramDisplay,
    ratePerGram,
    valuePaise,
    value: moneyRef(valuePaise),
    purchasedAt: purchasedAt ? new Date(purchasedAt).toISOString() : null,
  };
}

/** Gold booked on a successful payment (gold-weight schemes) — net retained weight after refunds. */
export function paymentGoldAccrualDto(payment) {
  const grossWeightMg = Number(payment?.weightMg ?? 0);
  const ratePerGramPaise = Number(payment?.ratePerGramPaise ?? 0);
  const netWeightMg = netWeightMgFromDoc(payment);
  const purchasedAt = payment?.paidAt ?? payment?.createdAt ?? null;
  if (grossWeightMg <= 0 && ratePerGramPaise <= 0) return null;
  const goldAccrual =
    buildGoldAccrualBlock(netWeightMg, ratePerGramPaise, purchasedAt)
    ?? buildGoldAccrualBlock(0, ratePerGramPaise, purchasedAt);
  const grossGoldAccrual =
    grossWeightMg > netWeightMg
      ? buildGoldAccrualBlock(grossWeightMg, ratePerGramPaise, purchasedAt)
      : undefined;
  return grossGoldAccrual ? { ...goldAccrual, grossGoldAccrual } : goldAccrual;
}

export function paymentReceiptExtraLines(payment) {
  const accrual = paymentGoldAccrualDto(payment);
  if (!accrual) return [];
  const lines = [];
  if (accrual.weightMg > 0) {
    lines.push(`Gold weight: ${accrual.weight.weightDisplay}`);
  }
  if (accrual.ratePerGramPaise > 0) {
    lines.push(`Gold rate: ${accrual.ratePerGram.ratePerGramDisplay} / g`);
  }
  if (accrual.purchasedAt) {
    lines.push(`Gold booked: ${new Date(accrual.purchasedAt).toLocaleDateString("en-IN")}`);
  }
  return lines;
}

/** Admin immutable ledger row (GET …/ledger) with optional payment join. */
export function mapAdminLedgerEntry(entry, payment) {
  const amountPaise = Math.abs(Number(entry?.amountPaise ?? 0));
  const weightMg = Number(entry?.weightMg ?? payment?.weightMg ?? 0);
  const ratePerGramPaise = Number(entry?.ratePerGramPaise ?? payment?.ratePerGramPaise ?? 0);
  const bookedAt = payment?.paidAt ?? entry?.createdAt ?? entry?.effectiveAt;
  const goldAccrual = paymentGoldAccrualDto({
    weightMg,
    refundedWeightMg: payment?.refundedWeightMg ?? 0,
    ratePerGramPaise,
    paidAt: bookedAt,
    createdAt: entry?.createdAt,
  });
  return {
    id: String(entry._id ?? entry.id ?? ""),
    sequence: entry.sequence ?? null,
    type: entry.type ?? null,
    description: entry.description ?? null,
    cycle: entry.cycle ?? null,
    installmentNumber: entry.installmentNumber ?? null,
    amount: moneyRef(amountPaise),
    amountPaise,
    effectiveAt: bookedAt ?? entry?.createdAt,
    receiptNumber: payment?.receiptNumber ?? null,
    paymentId: entry.paymentId ?? payment?._id ?? null,
    mode: payment?.mode ?? null,
    goldAccrual,
  };
}
