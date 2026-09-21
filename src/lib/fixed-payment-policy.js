/** How many consecutive unpaid installments may be included in one payment window. */
export function advanceInstallmentWindowCount(paymentRules = {}) {
  if (paymentRules.advancePaymentAllowed !== true) return 1;
  const extra = Number(paymentRules.maxAdvanceInstallments ?? 0);
  if (!Number.isFinite(extra) || extra < 0) return 1;
  return 1 + extra;
}

/** Consecutive unpaid installments from the current due row (inclusive). */
export function consecutiveUnpaidInstallments(installments, maxCount) {
  const due = installments.find((row) => !["PAID", "WAIVED"].includes(row.status));
  if (!due) return [];
  const rows = [];
  let started = false;
  for (const row of installments) {
    if (row.number === due.number) started = true;
    if (!started) continue;
    if (["PAID", "WAIVED"].includes(row.status)) continue;
    rows.push(row);
    if (rows.length >= maxCount) break;
  }
  return rows;
}

function applyReservationToQuote(baseQuote, reservedPaise, paymentRules) {
  if (!reservedPaise) return baseQuote;
  const partialAllowed = paymentRules.partialPaymentAllowed === true;
  let maxPayablePaise = Math.max(0, baseQuote.maxPayablePaise - reservedPaise);
  let allowedAmountsPaise = baseQuote.allowedAmountsPaise;
  if (allowedAmountsPaise?.length) {
    allowedAmountsPaise = allowedAmountsPaise.filter((amount) => amount <= maxPayablePaise);
    maxPayablePaise = allowedAmountsPaise[allowedAmountsPaise.length - 1] ?? 0;
  }
  const minPayablePaise = partialAllowed
    ? Math.min(baseQuote.minPayablePaise, maxPayablePaise)
    : (allowedAmountsPaise?.[0] ?? maxPayablePaise);
  return {
    ...baseQuote,
    payable: maxPayablePaise > 0 && (partialAllowed || (allowedAmountsPaise?.length ?? 0) > 0),
    minPayablePaise: Math.max(0, minPayablePaise),
    maxPayablePaise,
    allowedAmountsPaise: allowedAmountsPaise?.length ? allowedAmountsPaise : baseQuote.allowedAmountsPaise,
    reservedPaise,
    remainingPayablePaise: maxPayablePaise,
  };
}

export function computeFixedPaymentQuote(scheme, paymentRules = {}, options = {}) {
  const installments = scheme.installments ?? [];
  const due = installments.find((row) => !["PAID", "WAIVED"].includes(row.status));
  if (!due) {
    return {
      payable: false,
      minPayablePaise: 0,
      maxPayablePaise: 0,
      allowedAmountsPaise: [],
      installmentNumber: null,
      currentInstallmentNumber: null,
      consecutivePayableInstallments: [],
      reservedPaise: options.reservedPaise ?? 0,
      remainingPayablePaise: 0,
    };
  }
  const partialAllowed = paymentRules.partialPaymentAllowed === true;
  const maxCount = advanceInstallmentWindowCount(paymentRules);
  const consecutive = consecutiveUnpaidInstallments(installments, maxCount);
  const currentRemaining = due.amountPaise - due.paidPaise;
  const consecutivePayableInstallments = consecutive.map((row) => row.number);

  let base;
  if (!partialAllowed) {
    const allowedAmountsPaise = [];
    let cumulative = 0;
    for (const row of consecutive) {
      cumulative += row.amountPaise - row.paidPaise;
      allowedAmountsPaise.push(cumulative);
    }
    const maxPayablePaise = allowedAmountsPaise[allowedAmountsPaise.length - 1] ?? currentRemaining;
    const perTxnCap = paymentRules.maxPaymentPerTransactionPaise;
    const cappedMax = perTxnCap != null ? Math.min(maxPayablePaise, perTxnCap) : maxPayablePaise;
    const allowedCapped = allowedAmountsPaise.filter((amount) => amount <= cappedMax);
    base = {
      payable: allowedCapped.length > 0,
      minPayablePaise: allowedCapped[0] ?? currentRemaining,
      maxPayablePaise: cappedMax,
      allowedAmountsPaise: allowedCapped,
      installmentNumber: due.number,
      currentInstallmentNumber: due.number,
      suggestedPaise: allowedCapped[0] ?? currentRemaining,
      consecutivePayableInstallments,
    };
  } else {
    let maxPayablePaise = consecutive.reduce(
      (sum, row) => sum + (row.amountPaise - row.paidPaise),
      0,
    );
    const perTxnCap = paymentRules.maxPaymentPerTransactionPaise;
    if (perTxnCap != null) maxPayablePaise = Math.min(maxPayablePaise, perTxnCap);
    const minPayablePaise = Math.min(
      paymentRules.minPaymentPaise ?? currentRemaining,
      currentRemaining,
      maxPayablePaise,
    );
    base = {
      payable: maxPayablePaise > 0,
      minPayablePaise: Math.max(1, minPayablePaise),
      maxPayablePaise,
      allowedAmountsPaise: null,
      installmentNumber: due.number,
      currentInstallmentNumber: due.number,
      suggestedPaise: currentRemaining,
      consecutivePayableInstallments,
    };
  }

  return applyReservationToQuote(base, options.reservedPaise ?? 0, paymentRules);
}

export function buildFixedPayableQuote(scheme, paymentRules = {}, options = {}) {
  const quote = computeFixedPaymentQuote(scheme, paymentRules, options);
  return {
    model: "FIXED",
    ...quote,
    partialPaymentAllowed: paymentRules.partialPaymentAllowed === true,
    advancePaymentAllowed: paymentRules.advancePaymentAllowed === true,
    maxAdvanceInstallments:
      paymentRules.advancePaymentAllowed === true
        ? Number(paymentRules.maxAdvanceInstallments ?? 0)
        : 0,
    maxPaymentPerTransactionPaise: paymentRules.maxPaymentPerTransactionPaise ?? null,
  };
}

export function isFixedPaymentAmountAllowed(quote, amountPaise) {
  if (!quote.payable) return false;
  if (quote.allowedAmountsPaise?.length) {
    return quote.allowedAmountsPaise.includes(amountPaise);
  }
  return amountPaise >= quote.minPayablePaise && amountPaise <= quote.maxPayablePaise;
}

/** Preview which installment numbers receive a validated fixed payment amount. */
export function previewFixedAllocation(installments, amountPaise, paymentRules = {}) {
  const rows = (installments ?? []).map((row) => ({ ...row }));
  const partialAllowed = paymentRules.partialPaymentAllowed === true;
  let remaining = amountPaise;
  let fromInstallment = null;
  let throughInstallment = null;
  for (const installment of rows) {
    if (remaining <= 0) break;
    if (["PAID", "WAIVED"].includes(installment.status)) continue;
    const need = installment.amountPaise - installment.paidPaise;
    if (need <= 0) continue;
    if (fromInstallment == null) fromInstallment = installment.number;
    if (!partialAllowed) {
      if (remaining < need) break;
      remaining -= need;
      throughInstallment = installment.number;
      continue;
    }
    const allocation = Math.min(need, remaining);
    remaining -= allocation;
    throughInstallment = installment.number;
  }
  if (remaining > 0 || fromInstallment == null) {
    throw new Error("FIXED_PAYMENT_ALLOCATION_PREVIEW_FAILED");
  }
  return { fromInstallment, throughInstallment };
}

/** Apply a validated fixed payment amount to installment rows (mutates scheme.installments). */
export function allocateFixedPaymentToInstallments(scheme, amountPaise, paymentRules = {}) {
  const partialAllowed = paymentRules.partialPaymentAllowed === true;
  let remaining = amountPaise;
  for (const installment of scheme.installments ?? []) {
    if (remaining <= 0) break;
    if (["PAID", "WAIVED"].includes(installment.status)) continue;
    const need = installment.amountPaise - installment.paidPaise;
    if (need <= 0) continue;
    if (!partialAllowed) {
      if (remaining < need) {
        throw new Error("FIXED_PAYMENT_PARTIAL_NOT_ALLOWED");
      }
      installment.paidPaise += need;
      remaining -= need;
      installment.status = "PAID";
      continue;
    }
    const allocation = Math.min(need, remaining);
    installment.paidPaise += allocation;
    remaining -= allocation;
    installment.status =
      installment.paidPaise >= installment.amountPaise ? "PAID" : "PARTIALLY_PAID";
  }
  if (remaining > 0) {
    throw new Error("FIXED_PAYMENT_OVER_ALLOCATED");
  }
}
