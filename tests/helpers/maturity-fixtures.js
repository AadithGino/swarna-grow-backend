/**
 * Fixed-scheme maturity / redemption test fixtures aligned with v1 contribution rules.
 */

export function paidFixedInstallments(count, amountPaise, options = {}) {
  const startYear = options.startYear ?? 2025;
  let month = options.startMonth ?? 1;
  return Array.from({ length: count }, (_, index) => {
    const dueMonth = month + index;
    const dueDate = `${startYear}-${String(dueMonth).padStart(2, "0")}-05`;
    const graceEndsAt = `${startYear}-${String(dueMonth).padStart(2, "0")}-10`;
    const number = index + 1;
    const waived = options.waivedNumbers?.includes(number);
    return {
      number,
      dueDate,
      amountPaise,
      paidPaise: waived ? 0 : amountPaise,
      status: waived ? "WAIVED" : "PAID",
      graceEndsAt,
    };
  });
}

/** Split `totalPaise` across `installmentCount` fully PAID rows (remainder on last). */
export function paidFixedInstallmentsForTotal(totalPaise, installmentCount = 3, options = {}) {
  const base = Math.floor(totalPaise / installmentCount);
  const remainder = totalPaise - base * installmentCount;
  const startYear = options.startYear ?? 2025;
  let month = options.startMonth ?? 1;
  return Array.from({ length: installmentCount }, (_, index) => {
    const amountPaise = base + (index === installmentCount - 1 ? remainder : 0);
    const dueMonth = month + index;
    return {
      number: index + 1,
      dueDate: `${startYear}-${String(dueMonth).padStart(2, "0")}-05`,
      amountPaise,
      paidPaise: amountPaise,
      status: "PAID",
      graceEndsAt: `${startYear}-${String(dueMonth).padStart(2, "0")}-10`,
    };
  });
}

export function waivedFixedInstallment(number, amountPaise, dueDate, graceEndsAt) {
  return {
    number,
    dueDate,
    amountPaise,
    paidPaise: 0,
    status: "WAIVED",
    graceEndsAt,
  };
}

/** Fields to merge into Scheme.create for a calendar-matured fixed scheme with paid instalments. */
export function buildEligibleMaturedFixedSchemeFields({
  totalPaidPaise,
  installmentCount = 3,
  maturityDate = "2025-12-01",
  startDate = "2025-01-01",
  installmentOptions = {},
}) {
  const installments = paidFixedInstallmentsForTotal(
    totalPaidPaise,
    installmentCount,
    installmentOptions,
  );
  const installmentAmountPaise = installments[0]?.amountPaise ?? totalPaidPaise;
  return {
    startDate,
    maturityDate,
    installmentAmountPaise,
    installments,
  };
}

/** Deliberately invalid MATURED fixture (empty instalments) for guard-rail tests only. */
export function buildIncompleteMaturedFixedSchemeFields({
  maturityDate = "2025-12-01",
  startDate = "2025-01-01",
  installmentAmountPaise = 100_000,
} = {}) {
  return {
    startDate,
    maturityDate,
    installmentAmountPaise,
    installments: [
      {
        number: 1,
        dueDate: "2025-01-05",
        amountPaise: installmentAmountPaise,
        paidPaise: 0,
        status: "DUE",
        graceEndsAt: "2025-01-10",
      },
    ],
  };
}
