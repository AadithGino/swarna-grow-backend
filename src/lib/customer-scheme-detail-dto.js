import { moneyRef, weightRef } from "./money.js";
import { paymentGoldAccrualDto } from "./payment-gold-dto.js";
import { monthKey, today } from "./date.js";

function statusLabel(scheme, uiStatus) {
  if (uiStatus === "REDEMPTION_PENDING") return "Redemption in progress";
  const map = {
    ACTIVE: "Active",
    LOCKED: "Capped phase",
    DEFAULTED: "Defaulted",
    MATURED: "Matured",
    REDEEMED: "Redeemed",
    CLOSED_PREMATURE: "Closed early",
  };
  return map[uiStatus ?? scheme.status] ?? scheme.status;
}

const REDEMPTION_MODE_LABELS = {
  CASH: "Cash payout",
  GOLD_HANDOVER: "Take as gold",
  PURCHASE_ADJUSTMENT: "Adjust against purchase",
};

function payButtonState(scheme, actions, paymentBlock) {
  if (paymentBlock?.code) {
    return {
      enabled: false,
      reason: paymentBlock.code,
      helperText: paymentBlock.message ?? "Payments are temporarily unavailable.",
    };
  }
  if (actions?.canRecordPayment === false) {
    return { enabled: false, reason: "PAYMENTS_NOT_AVAILABLE", helperText: "Payments are not available for this scheme right now." };
  }
  if (scheme.status === "MATURED") {
    return { enabled: false, reason: "SCHEME_MATURED", helperText: "Use redemption request instead of paying instalments." };
  }
  return { enabled: true, reason: null, helperText: null };
}

function fixedProgress(scheme) {
  const installments = scheme.installments ?? [];
  const paid = installments.filter((r) => ["PAID", "WAIVED"].includes(r.status)).length;
  const total = installments.length || scheme.planSnapshot?.installmentCount || 0;
  const next = installments.find((r) => !["PAID", "WAIVED"].includes(r.status));
  return {
    installmentsPaid: paid,
    installmentsTotal: total,
    amountPaid: moneyRef(installments.reduce((s, r) => s + (r.paidPaise ?? 0), 0)),
    nextDue: next
      ? {
          installmentNumber: next.number,
          dueDate: next.dueDate,
          amount: moneyRef(Math.max(0, (next.amountPaise ?? 0) - (next.paidPaise ?? 0))),
          status: next.status,
        }
      : null,
  };
}

function flexibleCappedProgress(scheme) {
  const pos = scheme.paymentPosition;
  if (pos?.currentCycleCapPaise != null) {
    const cap = Number(pos.currentCycleCapPaise ?? 0);
    const paid = Number(pos.confirmedThisCyclePaise ?? 0);
    const remaining = Number(pos.remainingThisCyclePaise ?? Math.max(0, cap - paid));
    return {
      phase: "CAPPED",
      currentCycle: pos.targetCycle ?? pos.cycleLabel ?? monthKey(),
      cycleCap: moneyRef(cap),
      paidThisCycle: moneyRef(paid),
      remainingThisCycle: moneyRef(remaining),
      lockedAverage: moneyRef(scheme.lockedAveragePaise ?? cap),
    };
  }
  const current = monthKey();
  const cycle =
    scheme.cycles?.find((r) => r.cycle === current && (r.capPaise ?? 0) > 0) ??
    scheme.cycles?.find((r) => (r.capPaise ?? 0) > 0 && (r.paidPaise ?? 0) < (r.capPaise ?? 0));
  const capPaise = cycle?.capPaise ?? scheme.lockedAveragePaise ?? 0;
  const paidPaise = cycle?.paidPaise ?? 0;
  const remainingPaise =
    cycle?.remainingPaise ?? Math.max(0, Number(capPaise) - Number(paidPaise));
  return {
    phase: "CAPPED",
    currentCycle: cycle?.cycle ?? current,
    cycleCap: moneyRef(capPaise),
    paidThisCycle: moneyRef(paidPaise),
    remainingThisCycle: moneyRef(remainingPaise),
    lockedAverage: moneyRef(scheme.lockedAveragePaise ?? capPaise),
  };
}

function passbookSummary(scheme, passbook, totals) {
  if (passbook?.totals) {
    return {
      paid: passbook.totals.paid,
      pending: passbook.totals.pending ?? moneyRef(0),
      installmentsPaid: passbook.totals.installmentsPaid ?? 0,
      installmentsTotal: passbook.totals.installmentsTotal ?? 0,
      paymentCount: passbook.totals.paymentCount ?? null,
    };
  }
  return {
    paid: moneyRef(totals?.amountPaidPaise ?? 0),
    pending: moneyRef(0),
    installmentsPaid: null,
    installmentsTotal: null,
    paymentCount: null,
  };
}

function refDisplay(ref) {
  if (!ref || typeof ref !== "object") return "—";
  if (ref.amountDisplay) return ref.amountDisplay;
  if (ref.weightDisplay) return ref.weightDisplay;
  if (Number.isFinite(ref.amountPaise)) return moneyRef(ref.amountPaise).amountDisplay;
  if (Number.isFinite(ref.weightMg)) return weightRef(ref.weightMg).weightDisplay;
  return "—";
}

function paymentStatusLabel(status) {
  const map = {
    SUCCESS: "Successful",
    PENDING: "Processing",
    FAILED: "Failed",
    REVERSED: "Reversed",
    UNALLOCATED_PENDING_REVIEW: "Under review",
  };
  return map[status] ?? status ?? "Unknown";
}

function sanitizeReceiptNumber(payment) {
  if (payment.status !== "SUCCESS") return undefined;
  const receiptNumber = payment.receiptNumber;
  if (!receiptNumber || String(receiptNumber).startsWith("PENDING-")) return undefined;
  return receiptNumber;
}

/** Customer passbook row for GET /app/payments and scheme detail. */
export function mapCustomerPaymentListItem(payment, scheme) {
  const mode = String(payment.mode ?? payment.source ?? "ONLINE").toUpperCase();
  const channel =
    mode.includes("CASH") ? "CASH" : mode.includes("UPI") ? "UPI" : mode.includes("BANK") ? "BANK_TRANSFER" : "PHONEPE";
  const id = String(payment._id ?? payment.id ?? "");
  const status = payment.status ?? "SUCCESS";
  const receiptNumber = sanitizeReceiptNumber(payment);
  const goldAccrual = paymentGoldAccrualDto(payment);
  return {
    id,
    amount: moneyRef(payment.amountPaise ?? 0),
    status,
    statusLabel: paymentStatusLabel(status),
    paidAt: payment.paidAt ?? payment.createdAt,
    createdAt: payment.createdAt,
    schemeId: String(scheme._id ?? scheme.id ?? payment.schemeId ?? ""),
    schemeNumber: scheme.enrollmentNumber ?? "",
    schemeName: scheme.planSnapshot?.displayName ?? scheme.planSnapshot?.name ?? "Savings scheme",
    receiptNumber,
    receiptDownloadPath: status === "SUCCESS" && id ? `/app/payments/${id}/receipt` : undefined,
    channel,
    channelLabel:
      payment.recordedByLabel ??
      (channel === "CASH"
        ? "Cash at branch"
        : channel === "PHONEPE"
          ? "PhonePe"
          : channel === "UPI"
            ? "UPI"
            : "Bank transfer"),
    recordedByLabel: payment.recordedByLabel ?? undefined,
    paymentPattern: scheme.paymentPattern === "FIXED" ? "FIXED" : "FLEXIBLE",
    targetCycle: payment.targetCycle ?? null,
    valueBasis: scheme.valueBasis ?? scheme.planSnapshot?.valueBasis ?? "CASH",
    goldAccrual,
    transactionId: payment.providerTransactionId ? String(payment.providerTransactionId) : undefined,
  };
}

function mapCustomerPaymentRow(payment, scheme) {
  return mapCustomerPaymentListItem(payment, scheme);
}

function describePenalty(penalty) {
  if (!penalty) return null;
  if (penalty.mode === "PERCENT_OF_PAID") return `${penalty.value}% of total amount paid`;
  if (penalty.mode === "FLAT_PAISE") return moneyRef(penalty.value ?? 0).amountDisplay;
  return penalty.mode ? String(penalty.mode).replaceAll("_", " ").toLowerCase() : null;
}

function buildMaturityBenefit(planSnapshot) {
  const benefit = planSnapshot?.benefit;
  if (!benefit?.type) {
    return {
      title: "Maturity benefit",
      summary: "This plan does not define a separate maturity benefit.",
      details: [],
      eligibility: [],
    };
  }
  const title = benefit.displayLabel ?? benefitLabel(planSnapshot);
  const details = [];
  if (benefit.type === "FIXED_BONUS_AMOUNT" && benefit.bonusValue != null) {
    const basis =
      benefit.bonusBasis === "PERCENT_OF_PAID"
        ? `${benefit.bonusValue}% of your total contributions`
        : benefit.bonusBasis ?? "As per plan rules";
    details.push(`Bonus: ${basis}`);
    if (benefit.maxBonusPaise) details.push(`Maximum bonus: ${moneyRef(benefit.maxBonusPaise).amountDisplay}`);
  }
  if (benefit.type === "ONE_FREE_INSTALLMENT") {
    details.push("One instalment amount is credited as benefit when eligibility is met.");
  }
  if (benefit.type === "CASH_BONUS") details.push("Cash bonus is calculated from completed cycles at maturity.");
  if (benefit.type === "GOLD_BENEFIT") {
    details.push("Additional gold benefit is valued using the published rate on or before maturity.");
  }
  const eligibility = [];
  const el = benefit.eligibility ?? {};
  if (el.requireAllInstallmentsPaid) eligibility.push("All scheduled instalments must be paid.");
  if (el.maxAllowedDefaults != null && el.maxAllowedDefaults === 0) {
    eligibility.push("No defaulted or missed instalments.");
  }
  if (el.minMonthsCompleted) eligibility.push(`At least ${el.minMonthsCompleted} months must be completed.`);
  if (!eligibility.length) eligibility.push("Subject to plan eligibility checked at maturity.");
  return {
    title,
    summary: title,
    type: benefit.type,
    details,
    eligibility,
  };
}

function buildPlanRules(raw, displayMode, payableRange) {
  const plan = raw.planSnapshot ?? {};
  const sections = [];

  if (payableRange?.payable !== false && (payableRange?.maxPayable?.amountPaise ?? 0) > 0) {
    const phaseTitle =
      displayMode === "FLEXIBLE_FREE_WINDOW"
        ? "What you can pay now (free window)"
        : displayMode === "FLEXIBLE_LOCK_WINDOW"
          ? "What you can pay now (capped phase)"
          : "What you can pay now";
    const items = [
      `Minimum per payment: ${payableRange.minPayable.amountDisplay}`,
      `Maximum per payment: ${payableRange.maxPayable.amountDisplay}`,
    ];
    if (payableRange.cycleCap) items.push(`This cycle cap: ${payableRange.cycleCap.amountDisplay}`);
    if (payableRange.remainingThisCycle) {
      items.push(`Remaining this cycle: ${payableRange.remainingThisCycle.amountDisplay}`);
    }
    if (payableRange.contributionIsOptional) items.push("Contributions are optional in this phase.");
    if (payableRange.helperText) items.push(payableRange.helperText);
    sections.push({ title: phaseTitle, items });
  }

  const flex = plan.flexibleRules;
  if (flex?.flexiblePhase) {
    const fp = flex.flexiblePhase;
    sections.push({
      title: "Free window rules",
      items: [
        `Duration: ${flex.flexiblePhaseCycles ?? "—"} month(s) from enrolment`,
        `Per payment: ${moneyRef(fp.minimumPaymentPaise ?? 0).amountDisplay} – ${moneyRef(fp.maximumPaymentPaise ?? 0).amountDisplay}`,
        fp.minTotalPaise
          ? `Minimum total to enter capped phase: ${moneyRef(fp.minTotalPaise).amountDisplay}`
          : null,
        flex.carryForwardMode === "NONE"
          ? "Unused monthly room does not carry forward."
          : null,
        "Payments are optional; nothing becomes overdue.",
      ].filter(Boolean),
    });
  }
  if (flex?.cappedPhase) {
    const cp = flex.cappedPhase;
    sections.push({
      title: "Capped phase rules",
      items: [
        flex.cappedPhaseCycles ? `Duration: ${flex.cappedPhaseCycles} month(s) after free window` : null,
        `Minimum per payment: ${moneyRef(cp.minimumPaymentPaise ?? 0).amountDisplay}`,
        raw.lockedAveragePaise
          ? `Your snapshotted monthly cap: ${moneyRef(raw.lockedAveragePaise).amountDisplay}`
          : "Monthly cap is set from your free-window average when the capped phase starts.",
        cp.allowFutureCyclePayment ? "Future-cycle payments allowed as per plan." : "Pay only the current cycle.",
        "Skipping a month does not create default; unused cap expires each cycle.",
      ].filter(Boolean),
    });
  }

  if (plan.paymentPattern === "FIXED" && plan.paymentRules) {
    const pr = plan.paymentRules;
    sections.push({
      title: "Fixed instalment rules",
      items: [
        plan.installmentAmountPaise || raw.installmentAmountPaise
          ? `Instalment amount: ${moneyRef(raw.installmentAmountPaise ?? plan.amountRules?.defaultAmountPaise ?? 0).amountDisplay}`
          : null,
        pr.partialPaymentAllowed ? "Partial instalment payments allowed." : "Full instalment due each time.",
        pr.advancePaymentAllowed ? "Advance instalments allowed." : "Pay one due instalment at a time.",
        pr.minPaymentPaise ? `Minimum payment: ${moneyRef(pr.minPaymentPaise).amountDisplay}` : null,
      ].filter(Boolean),
    });
  }

  const redemption = plan.redemptionRules ?? {};
  const penalty = describePenalty(redemption.prematurePenalty);
  sections.push({
    title: "Premature closure",
    items: [
      redemption.prematureClosureAllowed
        ? "Early closure may be requested before contractual maturity."
        : "Early closure is not allowed before contractual maturity.",
      redemption.lockInMonths
        ? `Lock-in: ${redemption.lockInMonths} month(s) from enrolment before closure is considered.`
        : null,
      penalty ? `Penalty: ${penalty}` : null,
      redemption.prematurePenalty?.benefitTreatment === "FORFEIT"
        ? "Maturity benefit is forfeited on premature closure."
        : null,
      redemption.allowedModes?.length
        ? `Settlement modes: ${redemption.allowedModes.join(", ").replaceAll("_", " ").toLowerCase()}`
        : null,
    ].filter(Boolean),
  });

  if (plan.termsText) {
    sections.push({
      title: "Plan terms",
      items: String(plan.termsText)
        .split(/\n+/)
        .map((line) => line.replace(/^\d+\.\s*/, "").trim())
        .filter(Boolean),
    });
  }

  sections.push({
    title: "General",
    items: [
      "Paid contributions never expire and stay in your immutable ledger.",
      `Contractual maturity date: ${raw.maturityDate ?? "—"}.`,
      "Benefits are finalised only at maturity unless the plan allows earlier redemption.",
    ],
  });

  return { sections };
}

function schemeValueBasis(raw) {
  return raw.valueBasis ?? raw.planSnapshot?.valueBasis ?? "CASH";
}

function goldTotalsRef(raw, totals) {
  if (schemeValueBasis(raw) !== "GOLD_WEIGHT") return undefined;
  const ref = weightRef(totals?.goldWeightMg ?? 0);
  return { goldAccumulated: ref, goldAccrued: ref };
}

function buildProgressCard(raw, displayMode, totals) {
  const gold = goldTotalsRef(raw, totals);
  if (displayMode === "FIXED") {
    const fixed = fixedProgress(raw);
    return {
      type: "FIXED",
      installmentsPaid: fixed.installmentsPaid,
      installmentsTotal: fixed.installmentsTotal,
      ...gold,
    };
  }
  if (displayMode === "FLEXIBLE_FREE_WINDOW") {
    const freeMonths = raw.planSnapshot?.flexibleRules?.flexiblePhaseCycles ?? 6;
    const month = Math.min(freeMonths, freeWindowCurrentMonth(raw.startDate));
    const completed = freeWindowMonthsCompleted(raw.startDate);
    return {
      type: "FLEXIBLE_FREE_WINDOW",
      freeWindowMonth: month,
      freeWindowMonths: freeMonths,
      freeWindowMonthsCompleted: completed,
      ...gold,
    };
  }
  const capped = flexibleCappedProgress(raw);
  return {
    type: "FLEXIBLE_LOCK_WINDOW",
    cycleCap: capped.cycleCap,
    paidThisCycle: capped.paidThisCycle,
    remainingThisCycle: capped.remainingThisCycle,
    lockedAverage: capped.lockedAverage,
    currentCycle: capped.currentCycle,
    ...gold,
  };
}

function buildHeader(card, displayMode, _raw) {
  const eyebrow =
    displayMode === "FIXED"
      ? "FIXED SAVINGS"
      : displayMode === "FLEXIBLE_FREE_WINDOW"
        ? "FLEXIBLE · FREE WINDOW"
        : "FLEXIBLE · CAPPED PHASE";
  let title = card.planName;
  let description = card.subtitle;
  if (displayMode === "FIXED") {
    title = `Your goal is ${card.progressPercent}% complete`;
    const remaining = (card.progressCard?.installmentsTotal ?? 0) - (card.progressCard?.installmentsPaid ?? 0);
    description =
      remaining > 0
        ? `${remaining} instalment${remaining === 1 ? "" : "s"} remain before contractual maturity.`
        : "All instalments are paid. The scheme matures on its contractual date.";
  } else if (displayMode === "FLEXIBLE_LOCK_WINDOW") {
    title = card.nextActionAmount
      ? `${card.nextActionAmount.amountDisplay} available this cycle`
      : card.nextActionLabel;
  }
  return { eyebrow, title, description };
}

/** Customer-safe scheme detail for GET /app/schemes/:schemeId */
export function mapCustomerSchemeDetail(raw) {
  const displayMode = resolveDisplayMode(raw);
  const totals = raw.totals ?? { amountPaidPaise: 0, goldWeightMg: 0 };
  const actions = raw.actions ?? {};
  const card = mapHomeSchemeCard({ ...raw, displayMode, totals });
  const progressCard = buildProgressCard(raw, displayMode, totals);
  const header = buildHeader({ ...card, progressCard }, displayMode, raw);

  const isGoldWeight = schemeValueBasis(raw) === "GOLD_WEIGHT";
  const goldAccumulated = isGoldWeight ? weightRef(totals.goldWeightMg ?? 0) : undefined;

  const statCards = [{ label: "Total paid", value: refDisplay(moneyRef(totals.amountPaidPaise ?? 0)), caption: "Permanent ledger balance" }];
  if (isGoldWeight) {
    statCards.unshift({
      label: "Gold accumulated",
      value: refDisplay(goldAccumulated),
      caption: "From eligible contributions",
    });
  } else if (totals.goldWeightMg) {
    statCards.push({
      label: "Gold accumulated",
      value: refDisplay(weightRef(totals.goldWeightMg)),
      caption: "From eligible contributions",
    });
  }
  if (displayMode === "FIXED" && progressCard.installmentsTotal) {
    statCards.push({
      label: "Instalments",
      value: `${progressCard.installmentsPaid ?? 0} / ${progressCard.installmentsTotal}`,
      caption: "Paid vs scheduled",
    });
  }
  if (displayMode === "FLEXIBLE_LOCK_WINDOW" && raw.lockedAveragePaise) {
    statCards.push({
      label: "Monthly cap",
      value: refDisplay(moneyRef(raw.lockedAveragePaise)),
      caption: "Snapshotted average",
    });
  }

  const paymentBlock = raw.paymentBlock ?? null;
  const payState = payButtonState(raw, actions, paymentBlock);
  const payAllowed = Boolean(payState.enabled && card.canPay && !paymentBlock);
  const payButton = {
    visible: !["MATURED", "REDEEMED", "CLOSED_PREMATURE"].includes(raw.status) && actions.canRecordPayment !== false,
    enabled: payAllowed,
    label:
      payAllowed && card.nextActionAmount
        ? `Pay ${card.nextActionAmount.amountDisplay} with PhonePe`
        : payAllowed
          ? "Contribute with PhonePe"
          : paymentBlock?.code === "GOLD_RATE_NOT_SET"
            ? "Gold rate not published"
            : "Payments unavailable",
    reason: payState.reason ?? undefined,
    helperText: payState.helperText ?? undefined,
  };

  const payments = (raw.payments ?? []).map((row) => mapCustomerPaymentRow(row, raw));
  const passbookTotals = passbookSummary(raw, raw.passbook, totals);
  const passbookSummaryUi = {
    totalEntries: raw.passbook?.rows?.length ?? passbookTotals.paymentCount ?? payments.length,
    lastPaymentAt: payments.length ? payments[payments.length - 1].paidAt : null,
    totalPaid: moneyRef(totals.amountPaidPaise ?? 0),
  };

  const pending = raw.pendingRedemption;
  const allowedRedemptionModes = raw.planSnapshot?.redemptionRules?.allowedModes ?? ["CASH"];
  const redemptionUi = {
    eligible: raw.status === "MATURED" && !pending,
    status: pending?.status ?? raw.completedRedemption?.status ?? "NOT_ELIGIBLE",
    preferredModes: allowedRedemptionModes.map((mode) => ({
      mode,
      label: REDEMPTION_MODE_LABELS[mode] ?? String(mode).replaceAll("_", " ").toLowerCase(),
    })),
    blocker:
      pending != null
        ? "Redemption request already in progress"
        : raw.status !== "MATURED"
          ? "Available after contractual maturity"
          : undefined,
  };

  const helperText =
    displayMode === "FLEXIBLE_FREE_WINDOW"
      ? "Flexible contributions are optional. Paid amounts never expire."
      : displayMode === "FLEXIBLE_LOCK_WINDOW"
        ? "Unused monthly allowance does not carry forward. Paid money never expires."
        : card.benefitLabel || "Your plan matures on the contractual date even if all instalments are paid early.";

  const maturityBenefit = buildMaturityBenefit(raw.planSnapshot);
  const planRules = buildPlanRules(raw, displayMode, raw.payableRange);

  return {
    ...card,
    planId: raw.planId,
    passbookNumber: raw.passbookNumber ?? undefined,
    valueBasis: raw.valueBasis,
    uiStatus: raw.uiStatus ?? raw.status,
    header,
    progressCard,
    statCards,
    payButton,
    passbookSummary: passbookSummaryUi,
    redemption: redemptionUi,
    maturityBenefit,
    planRules,
    lifecycleActions: ["DOWNLOAD_PASSBOOK", "VIEW_PLAN"],
    payableRange: raw.payableRange,
    payments,
    version: raw.version ?? 1,
    positionVersion: raw.positionVersion ?? 0,
    helperText,
    benefitLabel: maturityBenefit.title || card.benefitLabel,
    goldAccumulated,
    goldAccrued: goldAccumulated,
  };
}

function resolveDisplayMode(scheme) {
  if (scheme.displayMode) return scheme.displayMode;
  if (scheme.paymentPattern === "FIXED") return "FIXED";
  if (scheme.flexiblePhase === "FLEXIBLE") return "FLEXIBLE_FREE_WINDOW";
  return "FLEXIBLE_LOCK_WINDOW";
}

function amountPaidPaise(scheme) {
  if (scheme.paymentPattern === "FIXED") {
    if (scheme.totals?.amountPaidPaise != null) return scheme.totals.amountPaidPaise;
    return (scheme.installments ?? []).reduce((sum, row) => sum + (row.paidPaise ?? 0), 0);
  }
  const fromCycles = (scheme.cycles ?? []).reduce((sum, row) => sum + (row.paidPaise ?? 0), 0);
  if (fromCycles > 0) return fromCycles;
  if (scheme.totals?.amountPaidPaise != null) return scheme.totals.amountPaidPaise;
  return 0;
}

function benefitLabel(planSnapshot) {
  const benefit = planSnapshot?.benefit;
  if (!benefit?.type) return "";
  if (benefit.displayLabel) return benefit.displayLabel;
  if (benefit.type === "FIXED_BONUS_AMOUNT") {
    if (benefit.bonusValue != null && benefit.bonusBasis === "PERCENT_OF_PAID") {
      return `${benefit.bonusValue}% bonus on maturity`;
    }
    return "Fixed bonus at maturity";
  }
  if (benefit.type === "ONE_FREE_INSTALLMENT") return "One free instalment on completion";
  if (benefit.type === "CASH_BONUS") return "Cash bonus based on completed cycles";
  if (benefit.type === "GOLD_BENEFIT") return "Gold benefit valued at maturity rate";
  return benefit.displayName ?? benefit.type;
}

function subtitleForMode(displayMode) {
  if (displayMode === "FIXED") return "Fixed monthly gold savings";
  if (displayMode === "FLEXIBLE_FREE_WINDOW") return "Flexible savings · Free window";
  return "Flexible savings · Capped phase";
}

/** 1-based index of the current calendar month within the scheme (inclusive of start month). */
function freeWindowCurrentMonth(startDate, endDate = today()) {
  if (!startDate) return 1;
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const index =
    (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
  return Math.max(1, index);
}

/** Full free-window months already elapsed (start month does not count until the next month). */
function freeWindowMonthsCompleted(startDate, endDate = today()) {
  return Math.max(0, freeWindowCurrentMonth(startDate, endDate) - 1);
}

/** Compact scheme row for GET /app/home activeSchemes[]. */
export function mapHomeSchemeCard(scheme, extras = {}) {
  const displayMode = resolveDisplayMode(scheme);
  const uiStatus = scheme.uiStatus ?? scheme.status;
  const paidPaise = amountPaidPaise(scheme);
  const planName = scheme.planSnapshot?.displayName ?? scheme.planSnapshot?.name ?? "Savings scheme";
  let progressPercent;
  let progressLabel;
  let progressDetail;
  let progressPhase;
  let nextActionLabel;
  let nextActionAmount = null;
  let canPay = ["ACTIVE", "LOCKED", "DEFAULTED"].includes(scheme.status);
  let cappedProgress;
  const planMonths = scheme.planSnapshot?.durationMonths ?? scheme.planSnapshot?.installmentCount ?? null;

  if (displayMode === "FIXED") {
    progressPhase = "FIXED";
    const fixed = fixedProgress(scheme);
    const total = fixed.installmentsTotal || 1;
    const paid = fixed.installmentsPaid ?? 0;
    progressPercent = Math.min(100, Math.round((paid / total) * 100));
    progressLabel = `${paid} of ${total} instalments paid`;
    progressDetail = planMonths ? `${planMonths}-month fixed plan` : "Fixed monthly instalments";
    if (fixed.nextDue) {
      nextActionLabel = `Next payment · ${fixed.nextDue.dueDate}`;
      nextActionAmount = fixed.nextDue.amount;
      canPay = canPay && fixed.nextDue.amount.amountPaise > 0;
    } else {
      nextActionLabel = "All instalments paid";
      canPay = false;
    }
  } else if (displayMode === "FLEXIBLE_FREE_WINDOW") {
    progressPhase = "FREE_WINDOW";
    const freeMonths = scheme.planSnapshot?.flexibleRules?.flexiblePhaseCycles ?? 6;
    const month = Math.min(freeMonths, freeWindowCurrentMonth(scheme.startDate));
    const completed = Math.min(freeMonths, freeWindowMonthsCompleted(scheme.startDate));
    progressPercent = freeMonths ? Math.min(100, Math.round((completed / freeMonths) * 100)) : 0;
    progressLabel = `Free window · month ${month} of ${freeMonths}`;
    const cappedMonths = planMonths && planMonths > freeMonths ? planMonths - freeMonths : null;
    progressDetail = cappedMonths
      ? `Optional contributions now · ${cappedMonths}-month capped phase follows`
      : "Optional contributions · capped phase follows free window";
    if (scheme.lockedAveragePaise) {
      progressDetail = `Capped phase cap ${moneyRef(scheme.lockedAveragePaise).amountDisplay}/month (snapshotted)`;
    }
    nextActionLabel = "Contribute any time";
    canPay = canPay && scheme.status === "ACTIVE";
  } else {
    progressPhase = "CAPPED";
    cappedProgress = flexibleCappedProgress(scheme);
    const cap = cappedProgress.cycleCap?.amountPaise ?? 0;
    const remaining = cappedProgress.remainingThisCycle?.amountPaise ?? 0;
    progressPercent = cap ? Math.min(100, Math.round(((cap - remaining) / cap) * 100)) : 0;
    const cycleLabel = cappedProgress.currentCycle ? formatCycleLabel(cappedProgress.currentCycle) : "This month";
    progressLabel = `${cappedProgress.paidThisCycle.amountDisplay} of ${cappedProgress.cycleCap.amountDisplay} · ${cycleLabel}`;
    progressDetail = `${cappedProgress.remainingThisCycle.amountDisplay} remaining · cap from free-window average`;
    nextActionLabel =
      remaining > 0 ? `${cappedProgress.remainingThisCycle.amountDisplay} room this month` : "Cycle allowance used";
    nextActionAmount = remaining > 0 ? cappedProgress.remainingThisCycle : null;
    canPay = canPay && remaining > 0;
  }

  const isGoldWeight = schemeValueBasis(scheme) === "GOLD_WEIGHT";
  const goldMg = scheme.totals?.goldWeightMg ?? 0;
  const goldAccumulated = isGoldWeight ? weightRef(goldMg) : undefined;

  return {
    id: scheme._id ?? scheme.id,
    schemeNumber: scheme.enrollmentNumber,
    passbookNumber: extras.passbookNumber ?? undefined,
    planName,
    subtitle: subtitleForMode(displayMode),
    displayMode,
    valueBasis: scheme.valueBasis ?? scheme.planSnapshot?.valueBasis,
    goldAccumulated,
    goldAccrued: goldAccumulated,
    status: scheme.status,
    statusLabel: statusLabel(scheme, uiStatus),
    progressPhase,
    progressPercent,
    progressLabel,
    progressDetail,
    totalPaid: moneyRef(paidPaise),
    maturityDate: scheme.maturityDate,
    nextActionLabel,
    nextActionAmount: nextActionAmount ?? undefined,
    canPay,
    benefitLabel: benefitLabel(scheme.planSnapshot),
    recentPayments: extras.recentPayments ?? undefined,
    ...(cappedProgress
      ? {
          cycleCap: cappedProgress.cycleCap,
          remainingThisCycle: cappedProgress.remainingThisCycle,
        }
      : {}),
  };
}

function formatCycleLabel(cycleKey) {
  if (!cycleKey || cycleKey.length < 7) return cycleKey ?? "";
  const [year, month] = cycleKey.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}
