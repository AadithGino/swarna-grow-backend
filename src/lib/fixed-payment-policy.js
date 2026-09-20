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

export function computeFixedPaymentQuote(scheme, paymentRules = {}) {
  const installments = scheme.installments ?? [];
  const due = installments.find((row) => !["PAID", "WAIVED"].includes(row.status));
  if (!due) {
    return {
      payable: false,
      minPayablePaise: 0,
      maxPayablePaise: 0,
      allowedAmountsPaise: [],
      installmentNumber: null,
    };
  }
  const partialAllowed = paymentRules.partialPaymentAllowed === true;
  const advanceAllowed = paymentRules.advancePaymentAllowed === true;
  const maxAdvanceInstallments = advanceAllowed
    ? Math.max(1, paymentRules.maxAdvanceInstallments ?? 1)
    : 1;
  const consecutive = consecutiveUnpaidInstallments(installments, maxAdvanceInstallments);
  const currentRemaining = due.amountPaise - due.paidPaise;

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
    return {
      payable: allowedCapped.length > 0,
      minPayablePaise: allowedCapped[0] ?? currentRemaining,
      maxPayablePaise: cappedMax,
      allowedAmountsPaise: allowedCapped,
      installmentNumber: due.number,
      suggestedPaise: allowedCapped[0] ?? currentRemaining,
    };
  }

  let maxPayablePaise = currentRemaining;
  if (advanceAllowed) {
    maxPayablePaise = consecutive.reduce(
      (sum, row) => sum + (row.amountPaise - row.paidPaise),
      0,
    );
  }
  const perTxnCap = paymentRules.maxPaymentPerTransactionPaise;
  if (perTxnCap != null) maxPayablePaise = Math.min(maxPayablePaise, perTxnCap);
  const minPayablePaise = Math.min(
    paymentRules.minPaymentPaise ?? currentRemaining,
    currentRemaining,
  );
  return {
    payable: maxPayablePaise > 0,
    minPayablePaise: Math.max(1, minPayablePaise),
    maxPayablePaise,
    allowedAmountsPaise: null,
    installmentNumber: due.number,
    suggestedPaise: currentRemaining,
  };
}

export function isFixedPaymentAmountAllowed(quote, amountPaise) {
  if (quote.allowedAmountsPaise?.length) {
    return quote.allowedAmountsPaise.includes(amountPaise);
  }
  return amountPaise >= quote.minPayablePaise && amountPaise <= quote.maxPayablePaise;
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
        installment.paidPaise += remaining;
        remaining = 0;
        installment.status = installment.paidPaise >= installment.amountPaise ? "PAID" : "PARTIALLY_PAID";
        break;
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
