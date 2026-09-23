import {
  AuditEntityType,
  ClosureType,
  LedgerEntryType,
  RedemptionMode,
  RedemptionStatus,
  SchemeStatus,
  ValueBasis,
} from "../constants/enums.js";
import {
  Branch,
  Customer,
  LedgerEntry,
  Redemption,
  Scheme,
  Tenant,
} from "../models/index.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import {
  assertSettlementSnapshotComplete,
  buildSettlementSnapshotFromPreview,
  computeClosureSettlementCore,
  closureSettlementFiguresDiffer,
  resolveSettlementModeFromReq,
  sanitizeSettlementClassificationFromRequest,
  settlementSnapshotClassificationInvalid,
} from "../lib/scheme-closure-settlement.js";
import { loadExcludedPaymentIdsForLedgerEntries } from "../lib/flexible-lock-settlement.js";
import { nextSchemeLedgerSequence } from "./sequence.service.js";
import { writeAudit } from "./audit.service.js";
import { paginate } from "../lib/pagination.js";
import {
  applyWeightPrecisionMg,
  decimalRoundingMode,
  moneyToWeightMg,
  moneyPaiseFromWeightMg,
  rateRef,
} from "../lib/money.js";
import { goldRateForExactDate } from "../lib/gold-rate-lookup.js";
import { dateMatch, effectiveScope, searchRegex } from "../lib/query-filters.js";
import { addMonthsClamped, elapsedSchemeMonths, today } from "../lib/date.js";
import { assertFeatureEntitled } from "../lib/tenant-limits.js";
import { isSystemPolicyClosureSettlement } from "../lib/system-policy-closure.js";
import { assessMaturityContributionEligibility } from "../lib/maturity-eligibility.js";

const OPEN_REDEMPTION_STATUSES = [
  RedemptionStatus.REQUESTED,
  RedemptionStatus.PENDING_APPROVAL,
  RedemptionStatus.APPROVED,
];

const REDEMPTION_MODE_LABELS = {
  CASH: "Cash payout",
  GOLD_HANDOVER: "Take as gold",
  PURCHASE_ADJUSTMENT: "Adjust against purchase",
};

function moneyField(paise) {
  const value = Math.max(0, Number(paise ?? 0));
  return {
    amountPaise: value,
    amountDisplay: new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(value / 100),
  };
}

/**
 * Gold settlement rupees are today's rate × grams, not the rupees originally collected.
 * Rewrite the credit lines so they add up to that figure, and show the grams used.
 */
function alignGoldValuationLines({
  lines,
  goldWeightMg,
  benefitWeightMg,
  penaltyWeightMg,
  penaltyPaise,
  settlementPaise,
  ratePerGramPaise,
  collectedPaise,
}) {
  if (!(ratePerGramPaise > 0) || !(goldWeightMg > 0)) return;
  const principalValue = moneyPaiseFromWeightMg(goldWeightMg, ratePerGramPaise);
  const benefitValue = benefitWeightMg > 0
    ? moneyPaiseFromWeightMg(benefitWeightMg, ratePerGramPaise)
    : 0;
  const paidLine = lines.find((line) => line.key === "TOTAL_PAID");
  if (paidLine) {
    paidLine.label = paidLine.label.replace(/^Total paid/, "Gold balance");
    paidLine.amount = moneyField(principalValue);
    paidLine.weight = weightDisplayFromMg(goldWeightMg);
    paidLine.note = `Collected ${moneyField(collectedPaise).amountDisplay}. Valued at today's 22K rate.`;
  }
  const benefitLine = lines.find((line) => line.key === "BENEFIT" && !line.forfeited);
  if (benefitLine && benefitWeightMg > 0) {
    benefitLine.amount = moneyField(benefitValue);
    benefitLine.weight = weightDisplayFromMg(benefitWeightMg);
  }
  const penaltyLine = lines.find((line) => line.key === "PENALTY");
  let penaltyValue = Math.max(0, penaltyPaise);
  const credits = principalValue + (benefitLine && benefitWeightMg > 0 ? benefitValue : 0);
  if (penaltyWeightMg > 0 && penaltyLine) {
    penaltyValue = Math.max(0, credits - settlementPaise);
    penaltyLine.weight = weightDisplayFromMg(penaltyWeightMg);
  }
  const sum = credits - penaltyValue;
  const delta = settlementPaise - sum;
  if (delta !== 0) {
    if (benefitLine && benefitWeightMg > 0) {
      benefitLine.amount = moneyField(benefitValue + delta);
    } else if (paidLine) {
      paidLine.amount = moneyField(principalValue + delta);
    }
  }
  if (penaltyLine && penaltyValue !== penaltyPaise) {
    penaltyLine.amount = moneyField(penaltyValue);
  }
}

function installmentsPaidCount(scheme) {
  if (scheme.paymentPattern === "FLEXIBLE") {
    const freeCycles = scheme.planSnapshot?.flexibleRules?.flexiblePhaseCycles ?? 0;
    if (scheme.flexiblePhase === "FLEXIBLE") {
      return (scheme.cycles ?? [])
        .slice(0, freeCycles)
        .filter((cycle) => cycle.paidPaise > 0).length;
    }
    return (scheme.cycles ?? []).filter(
      (cycle) => cycle.capPaise > 0 && cycle.paidPaise >= cycle.capPaise,
    ).length;
  }
  return (scheme.installments ?? []).filter((row) =>
    ["PAID", "WAIVED"].includes(row.status),
  ).length;
}

function assertRedemptionModeAllowed(rules, mode) {
  const allowed = rules?.allowedModes ?? ["CASH"];
  if (!allowed.includes(mode)) {
    throw errors.business(
      "REDEMPTION_MODE_NOT_ALLOWED",
      `Redemption mode ${mode} is not allowed for this plan.`,
      { allowedModes: allowed },
    );
  }
}

function weightDisplayFromMg(weightMg) {
  const mg = Math.max(0, Number(weightMg ?? 0));
  if (!mg) return null;
  return {
    weightMg: mg,
    weightDisplay: `${(mg / 1000).toFixed(3)} g`,
  };
}

/** Per-mode settlement figures for gold-weight preview UI (admin + customer). */
async function buildSettlementModePreviews({
  scheme,
  allowedModeCodes,
  ledgerEntries,
  excludedPaymentIds,
  closureType,
  tenantOps,
  systemPolicyClosure,
  benefitEligible,
  paidCount,
  monthsCompleted,
  lockInMet,
  requiredPaid,
  defaultCount,
  benefitDef,
  rules,
  isPremature,
}) {
  if (scheme.valueBasis !== ValueBasis.GOLD_WEIGHT) return undefined;
  const modePreviews = {};
  for (const mode of allowedModeCodes) {
    const core = await computeClosureSettlementCore({
      scheme,
      ledgerEntries,
      excludedPaymentIds,
      closureType,
      valuationDateYmd: today(),
      mode,
      tenantOps,
      systemPolicyClosure,
      benefitEligible,
      paidCount,
      monthsCompleted,
      lockInMet,
      requiredPaid,
      defaultCount,
      benefitDef,
      rules,
      isPremature,
    });
    const ratePaise = core.settlementRatePerGramPaise ?? 0;
    const weight = weightDisplayFromMg(core.weightMg ?? core.goldWeightMg);
    const entry = {};
    if (ratePaise > 0) entry.rateApplied = rateRef(ratePaise);
    if (weight) {
      entry.weight = weight;
      entry.weightDisplay = weight.weightDisplay;
    }
    if (mode === RedemptionMode.GOLD_HANDOVER && ratePaise > 0) {
      entry.note = `At today's rate of ${rateRef(ratePaise).ratePerGramDisplay} per gram`;
    } else if (mode === RedemptionMode.CASH) {
      entry.note = ratePaise > 0
        ? `Cash equivalent at ${rateRef(ratePaise).ratePerGramDisplay} per gram${
          core.settlementRateEffectiveDate ? ` (${core.settlementRateEffectiveDate})` : ""
        }.`
        : "Settlement is paid in cash; accrued gold weight is closed out against this payout.";
    } else if (mode === RedemptionMode.PURCHASE_ADJUSTMENT) {
      entry.note = "Value is adjusted against an in-store purchase when staff complete handover.";
    }
    if (Object.keys(entry).length) modePreviews[mode] = entry;
  }
  return Object.keys(modePreviews).length ? modePreviews : undefined;
}

function assertRedemptionBranchAllowed(scheme, req) {
  if (scheme.planSnapshot?.redemptionRules?.redeemAtAnyBranch !== false) return;
  const actorBranch = req.scope?.branchId ?? req.auth?.branchId;
  if (actorBranch && scheme.branchId !== actorBranch) {
    throw errors.business(
      "REDEMPTION_BRANCH_MISMATCH",
      "This plan must be redeemed at the enrolling branch.",
    );
  }
}

export async function settlementPreview(req, closureType) {
  sanitizeSettlementClassificationFromRequest(req);
  const accessScope =
    req.auth.type === "CUSTOMER"
      ? { tenantId: req.auth.tenantId, customerId: req.auth.id }
      : req.scope;
  const scheme = await Scheme.findOne({
    _id: req.params.schemeId,
    ...accessScope,
  }).lean();
  if (!scheme) throw errors.notFound("Scheme");
  const [entries, customer] = await Promise.all([
    LedgerEntry.find({ tenantId: scheme.tenantId, schemeId: scheme._id }).lean(),
    Customer.findOne({ _id: scheme.customerId, tenantId: scheme.tenantId })
      .select("_id name mobile passbookNumber customerNumber")
      .lean(),
  ]);
  const rules = scheme.planSnapshot?.redemptionRules ?? {};
  const benefitDef = scheme.planSnapshot?.benefit ?? null;
  const isPremature = closureType === ClosureType.PREMATURE_CLOSURE;
  const systemPolicyClosure = isSystemPolicyClosureSettlement(scheme);
  const blockers = [];

  if (systemPolicyClosure) {
    if (req.auth?.type === "CUSTOMER") {
      blockers.push({
        code: "SETTLEMENT_STAFF_REQUIRED",
        message: "Staff must complete settlement for this scheme.",
      });
    }
    if (scheme.settlementCompletedAt) {
      blockers.push({
        code: "SETTLEMENT_ALREADY_COMPLETED",
        message: "Settlement has already been completed for this scheme.",
      });
    }
    if (closureType !== ClosureType.PREMATURE_CLOSURE) {
      blockers.push({
        code: "SCHEME_NOT_CLOSABLE",
        message: "This scheme requires staff settlement as a premature policy closure.",
      });
    }
  }

  const paidCount = installmentsPaidCount(scheme);
  const monthsCompleted = elapsedSchemeMonths(scheme.startDate, today());
  const lockInMonths = rules.lockInMonths ?? 0;
  const lockInEligibleFrom = addMonthsClamped(scheme.startDate, lockInMonths).format("YYYY-MM-DD");
  const lockInMet = lockInMonths === 0 || monthsCompleted >= lockInMonths;
  if (isPremature && !systemPolicyClosure) {
    if (!rules.prematureClosureAllowed) {
      blockers.push({
        code: "PREMATURE_CLOSURE_NOT_ALLOWED",
        message: "This plan does not allow premature closure.",
      });
    }
    if (!lockInMet) {
      blockers.push({
        code: "LOCK_IN_NOT_MET",
        message: `This scheme has a ${lockInMonths}-month lock-in. It can be closed from ${lockInEligibleFrom}.`,
        eligibleFrom: lockInEligibleFrom,
        monthsCompleted,
        lockInMonths,
      });
    }
    if (!["ACTIVE", "LOCKED", "DEFAULTED"].includes(scheme.status)) {
      blockers.push({
        code: "SCHEME_NOT_CLOSABLE",
        message: `Scheme status ${scheme.status} cannot be closed prematurely.`,
      });
    }
  } else if (!isPremature && scheme.status !== SchemeStatus.MATURED) {
    blockers.push({
      code: "SCHEME_NOT_MATURED",
      message: "The scheme has not matured yet.",
      eligibleFrom: scheme.maturityDate,
    });
  } else if (
    !isPremature &&
    !systemPolicyClosure &&
    scheme.status === SchemeStatus.MATURED
  ) {
    const maturityContributions = assessMaturityContributionEligibility(scheme);
    if (!maturityContributions.paymentEligible) {
      blockers.push({
        code: "MATURITY_CONTRIBUTIONS_INCOMPLETE",
        message:
          maturityContributions.message ??
          "Required contributions must be complete before normal redemption.",
      });
    }
  }

  if (
    systemPolicyClosure
    && scheme.status !== SchemeStatus.CLOSED_PREMATURE
  ) {
    blockers.push({
      code: "SCHEME_NOT_CLOSABLE",
      message: "System-policy settlement requires a closed scheme in settlement state.",
    });
  }

  const cappedCycles = (scheme.cycles ?? []).filter((cycle) => cycle.capPaise > 0);
  const requiredPaid =
    scheme.paymentPattern === "FLEXIBLE"
      ? cappedCycles.length > 0 &&
        cappedCycles.every((cycle) => cycle.paidPaise >= cycle.capPaise)
      : (scheme.installments ?? []).every((row) =>
          ["PAID", "WAIVED"].includes(row.status),
        );
  const defaultCount = (scheme.installments ?? []).filter(
    (row) => row.status === "OVERDUE",
  ).length;
  const eligibility = benefitDef?.eligibility;
  const minMonthsCompleted = eligibility?.minMonthsCompleted ?? 0;
  const benefitEligible =
    !systemPolicyClosure &&
    !isPremature &&
    benefitDef &&
    benefitDef.type !== "TEXT_ONLY" &&
    monthsCompleted >= minMonthsCompleted &&
    ((!eligibility?.requireAllInstallmentsPaid || requiredPaid) &&
      defaultCount <= (eligibility?.maxAllowedDefaults ?? Number.MAX_SAFE_INTEGER));

  const [excludedPaymentIds, tenant] = await Promise.all([
    loadExcludedPaymentIdsForLedgerEntries(entries, scheme.tenantId),
    Tenant.findById(scheme.tenantId).select("operations").lean(),
  ]);
  const settlementMode = resolveSettlementModeFromReq(req);
  if (scheme.valueBasis === ValueBasis.GOLD_WEIGHT) {
    if (!settlementMode) {
      throw errors.business(
        "REDEMPTION_MODE_REQUIRED",
        "Redemption mode is required for gold-weight settlement preview.",
      );
    }
    assertRedemptionModeAllowed(rules, settlementMode);
  }
  const core = await computeClosureSettlementCore({
    scheme,
    ledgerEntries: entries,
    excludedPaymentIds,
    closureType,
    valuationDateYmd: today(),
    mode: settlementMode,
    tenantOps: tenant,
    systemPolicyClosure,
    benefitEligible,
    paidCount,
    monthsCompleted,
    lockInMet,
    requiredPaid,
    defaultCount,
    benefitDef,
    rules,
    isPremature,
  });
  blockers.push(...core.blockers);
  if (systemPolicyClosure && core.settlementPaise <= 0 && blockers.length === 0) {
    blockers.push({
      code: "SETTLEMENT_PRINCIPAL_ZERO",
      message: "No refundable principal remains for settlement.",
    });
  }
  const {
    benefitPaise,
    benefitWeightMg,
    benefitRatePerGramPaise,
    penaltyPaise,
    penaltyWeightMg,
    settlementPaise,
    principalPaise,
    goldWeightMg,
    weightMg,
    prematureBenefitTreatment,
    penaltyRule,
    settlementRatePerGramPaise,
    settlementRateEffectiveDate,
  } = core;
  const totals = { amountPaidPaise: principalPaise, goldWeightMg };
  const eligible = blockers.length === 0;
  const valuationRatePerGramPaise = settlementRatePerGramPaise ?? 0;
  const valuationRateEffectiveDate = settlementRateEffectiveDate ?? "";

  const benefitLabel =
    benefitDef?.displayLabel ??
    (benefitDef?.type === "ONE_FREE_INSTALLMENT"
      ? "Plan benefit"
      : benefitDef?.type ?? "Benefit");

  const lines = [
    {
      key: "TOTAL_PAID",
      label: `Total paid (${paidCount} installment${paidCount === 1 ? "" : "s"})`,
      amount: moneyField(totals.amountPaidPaise),
      sign: "+",
    },
  ];

  if (isPremature && prematureBenefitTreatment === "FORFEIT") {
    lines.push({
      key: "BENEFIT",
      label: `${benefitLabel} — forfeited`,
      amount: moneyField(0),
      sign: "+",
      forfeited: true,
      forfeitReason: "Premature closure benefit treatment is forfeiture",
    });
  } else if (benefitDef?.type === "TEXT_ONLY") {
    // settlement lines exclude text-only benefit value
  } else if (benefitPaise > 0) {
    lines.push({
      key: "BENEFIT",
      label: benefitLabel,
      amount: moneyField(benefitPaise),
      sign: "+",
      isComputed: true,
    });
  } else if (benefitDef && !benefitEligible) {
    lines.push({
      key: "BENEFIT",
      label: `${benefitLabel} — not eligible`,
      amount: moneyField(0),
      sign: "+",
      forfeited: true,
      forfeitReason: "Eligibility conditions were not met",
    });
  }

  lines.push({
    key: "PENALTY",
    label: isPremature
      ? penaltyRule?.mode === "PERCENT_OF_PAID"
        ? `Premature closure charge (${penaltyRule.value ?? 0}% of amount paid)`
        : "Premature closure charge"
      : "Penalty",
    amount: moneyField(penaltyPaise),
    sign: "-",
  });

  if (scheme.valueBasis === ValueBasis.GOLD_WEIGHT && valuationRatePerGramPaise > 0) {
    alignGoldValuationLines({
      lines,
      goldWeightMg,
      benefitWeightMg,
      penaltyWeightMg,
      penaltyPaise,
      settlementPaise,
      ratePerGramPaise: valuationRatePerGramPaise,
      collectedPaise: totals.amountPaidPaise,
    });
  }

  const textBenefits =
    benefitDef?.type === "TEXT_ONLY"
      ? [
        {
          text: benefitDef.textBenefit ?? benefitDef.displayLabel ?? "",
          displayLabel: benefitDef.displayLabel ?? "Plan benefit",
          note: "Apply this manually at the counter. It is not calculated in the settlement value below.",
        },
      ]
      : [];

  const allowedModeCodes = rules.allowedModes ?? ["CASH"];
  const allowedModes = allowedModeCodes.map((mode) => ({
    mode,
    label: REDEMPTION_MODE_LABELS[mode] ?? mode,
    available: true,
    note:
      mode === RedemptionMode.GOLD_HANDOVER &&
      scheme.valueBasis !== ValueBasis.GOLD_WEIGHT
        ? "Available when plan is gold-weight based"
        : mode === RedemptionMode.GOLD_HANDOVER
          ? "Gold weight is handed over at completion; rupee value uses the gold rate on the handover date."
          : mode === RedemptionMode.CASH && scheme.valueBasis === ValueBasis.GOLD_WEIGHT
            ? "Settlement is paid in cash; accrued gold weight is closed out against this payout."
            : undefined,
  })).map((row) => ({
    ...row,
    available: allowedModeCodes.includes(row.mode),
  }));

  const approvalRequired = Boolean(
    rules.approvalRequired ||
      tenant?.operations?.redemptionApprovalRequired,
  );
  const warningText = isPremature && eligible
    ? prematureBenefitTreatment === "FORFEIT"
      ? penaltyPaise > 0
        ? "Closing early forfeits the maturity benefit and applies a premature closure charge. This cannot be undone."
        : "Closing early forfeits the maturity benefit. This cannot be undone."
      : penaltyPaise > 0
        ? "Closing early applies a premature closure charge. The configured benefit is retained. This cannot be undone."
        : "Closing early retains the configured benefit. This cannot be undone."
    : undefined;

  const modePreviews = await buildSettlementModePreviews({
    scheme,
    allowedModeCodes,
    ledgerEntries: entries,
    excludedPaymentIds,
    closureType,
    tenantOps: tenant,
    systemPolicyClosure,
    benefitEligible,
    paidCount,
    monthsCompleted,
    lockInMet,
    requiredPaid,
    defaultCount,
    benefitDef,
    rules,
    isPremature,
  });

  const valuationNote =
    scheme.valueBasis === ValueBasis.GOLD_WEIGHT && valuationRatePerGramPaise > 0
      ? "Cash equivalent uses today's published gold rate. It changes when the rate changes."
      : undefined;

  return {
    type: closureType,
    eligible,
    blockers,
    scheme: {
      id: scheme._id,
      schemeNumber: scheme.enrollmentNumber,
      planName: scheme.planSnapshot?.name,
      valueBasis: scheme.valueBasis,
      status: scheme.status,
      maturityDate: scheme.maturityDate,
      monthsCompleted,
      lockInMonths,
      lockInMet,
      ...(systemPolicyClosure
        ? {
          closureReason: scheme.closureReason,
          settlementRequired: scheme.settlementRequired,
        }
        : {}),
    },
    customer: customer
      ? {
        id: customer._id,
        name: customer.name,
        mobile: customer.mobile,
        passbookNumber: customer.passbookNumber ?? customer.customerNumber,
      }
      : undefined,
    computation: {
      lines,
      finalValue: moneyField(settlementPaise),
      goldWeight: (weightMg || totals.goldWeightMg)
        ? {
          weightMg: weightMg || totals.goldWeightMg,
          weightDisplay: `${((weightMg || totals.goldWeightMg) / 1000).toFixed(3)} g`,
        }
        : null,
    },
    benefit: benefitDef
      ? {
        type: benefitDef.type,
        displayLabel: benefitDef.displayLabel,
        isComputed: benefitDef.type !== "TEXT_ONLY",
        applied: benefitPaise > 0,
        value: benefitPaise > 0 ? moneyField(benefitPaise) : null,
        eligibilityMet: benefitEligible,
      }
      : null,
    textBenefits,
    penalty: isPremature && penaltyRule
      ? {
        mode: penaltyRule.mode,
        value: penaltyRule.value,
        amount: moneyField(penaltyPaise),
        benefitTreatment: penaltyRule.benefitTreatment,
      }
      : null,
    allowedModes,
    modePreviews,
    approvalRequired,
    approvalReason: approvalRequired
      ? "Admin approval is required before this scheme can be closed."
      : undefined,
    warningText,
    valuationNote,
    closureType,
    schemeId: scheme._id,
    principalPaise,
    principalWeightMg: goldWeightMg,
    goldWeightMg,
    weightMg,
    benefitEligible,
    benefitPaise,
    benefitWeightMg,
    benefitRatePerGramPaise,
    penaltyPaise,
    penaltyWeightMg,
    settlementPaise,
    valuationRatePerGramPaise,
    valuationRateEffectiveDate,
    mode: settlementMode ?? null,
    systemPolicyClosure,
    closureReason: systemPolicyClosure ? (scheme.closureReason ?? "") : "",
    maxSettlementPaise: systemPolicyClosure ? principalPaise : undefined,
  };
}
export async function requestCustomerRedemption(req) {
  const scheme = await Scheme.findOne({
    _id: req.params.schemeId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!scheme) throw errors.notFound("Scheme");
  assertRedemptionModeAllowed(scheme.planSnapshot?.redemptionRules, req.body.preferredMode);
  if (req.body.expectedVersion !== scheme.version) {
    throw new AppError("VERSION_CONFLICT", "This scheme changed. Refresh and try again.", 409);
  }
  const preview = await settlementPreview(
    {
      ...req,
      body: {
        ...req.body,
        mode: req.body.preferredMode ?? req.body.mode,
      },
    },
    ClosureType.MATURITY_REDEMPTION,
  );
  if (!preview.eligible) {
    throw errors.business(
      preview.blockers[0]?.code ?? "NOT_ELIGIBLE",
      preview.blockers[0]?.message ?? "This scheme is not eligible for redemption.",
    );
  }
  const existingOpen = await Redemption.findOne({
    tenantId: req.auth.tenantId,
    schemeId: scheme._id,
    status: { $in: OPEN_REDEMPTION_STATUSES },
  }).lean();
  if (existingOpen) {
    throw errors.business(
      "REDEMPTION_ALREADY_OPEN",
      "A redemption request is already in progress for this scheme.",
    );
  }
  if (req.body.preferredMode === RedemptionMode.PURCHASE_ADJUSTMENT) {
    const billNumber = String(req.body.modeDetails?.billNumber ?? "").trim();
    if (!billNumber || billNumber.length > 64) {
      throw errors.business(
        "BILL_NUMBER_REQUIRED",
        "A valid purchase bill number is required for purchase adjustment.",
      );
    }
  }
  const row = await Redemption.create({
    _id: createId("redemption"),
    tenantId: scheme.tenantId,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    closureType: ClosureType.MATURITY_REDEMPTION,
    mode: req.body.preferredMode,
    modeDetails: {
      preferredDate: req.body.preferredDate,
      remarks: req.body.remarks,
      ...(req.body.modeDetails?.billNumber
        ? { billNumber: String(req.body.modeDetails.billNumber).trim() }
        : {}),
      settlementSnapshot: buildSettlementSnapshotFromPreview(
        preview,
        scheme.version,
        req.body.preferredMode,
      ),
    },
    status: RedemptionStatus.REQUESTED,
    principalPaise: preview.principalPaise,
    benefitPaise: preview.benefitPaise,
    benefitWeightMg: preview.benefitWeightMg,
    benefitRatePerGramPaise: preview.benefitRatePerGramPaise,
    penaltyPaise: preview.penaltyPaise,
    penaltyWeightMg: preview.penaltyWeightMg,
    settlementPaise: preview.settlementPaise,
    weightMg:
      preview.weightMg
      ?? (preview.goldWeightMg ?? 0) + (preview.benefitWeightMg ?? 0),
    requestedBy: req.auth.id,
    requestedAt: new Date(),
  });
  return {
    id: row._id,
    status: row.status,
    preferredMode: req.body.preferredMode,
    preferredDate: req.body.preferredDate ?? null,
    remarks: req.body.remarks ?? null,
    settlementPaise: row.settlementPaise,
  };
}

export async function initiateRedemption(
  req,
  closureType,
  customerRequest = false,
) {
  sanitizeSettlementClassificationFromRequest(req);
  const schemeRow = await Scheme.findOne({
    _id: req.params.schemeId,
    tenantId: req.auth.tenantId,
    ...(req.auth.type === "CUSTOMER" ? { customerId: req.auth.id } : req.scope),
  }).lean();
  if (!schemeRow) throw errors.notFound("Scheme");
  if (customerRequest && isSystemPolicyClosureSettlement(schemeRow)) {
    throw errors.business(
      "SETTLEMENT_STAFF_REQUIRED",
      "Staff must complete settlement for this scheme.",
    );
  }
  assertRedemptionModeAllowed(schemeRow.planSnapshot?.redemptionRules, req.body.mode);
  assertRedemptionBranchAllowed(schemeRow, req);
  if (
    closureType === ClosureType.PREMATURE_CLOSURE
    && !isSystemPolicyClosureSettlement(schemeRow)
  ) {
    assertFeatureEntitled(
      req.tenant ?? await Tenant.findById(req.auth.tenantId).lean(),
      "prematureRedemption",
      "Premature closure is not included in your plan.",
    );
  }
  const preview = await settlementPreview(
    {
      ...req,
      body: { ...(req.body ?? {}), mode: req.body.mode },
    },
    closureType,
  );
  if (!preview.eligible) {
    throw errors.business(
      preview.blockers[0]?.code ?? "NOT_ELIGIBLE",
      preview.blockers[0]?.message ?? "This scheme is not eligible for closure.",
    );
  }
  const modeDetails = {
    ...(req.body.modeDetails ?? {}),
    settlementSnapshot: buildSettlementSnapshotFromPreview(
      preview,
      schemeRow.version,
      req.body.mode,
    ),
  };
  const expected = modeDetails.expectedFinalValuePaise;
  if (
    expected != null &&
    Number(expected) !== Number(preview.settlementPaise)
  ) {
    throw errors.business(
      "SETTLEMENT_VALUE_CHANGED",
      "The settlement amount changed since preview. Refresh and confirm again.",
      { preview },
    );
  }
  if (closureType === ClosureType.PREMATURE_CLOSURE && !preview.systemPolicyClosure) {
    if (preview.penaltyPaise > 0 && !modeDetails.acknowledgePenalty) {
      throw errors.business(
        "ACKNOWLEDGEMENT_REQUIRED",
        "Confirm the premature closure penalty before submitting.",
      );
    }
    if (
      preview.penalty?.benefitTreatment === "FORFEIT"
      && !modeDetails.acknowledgeBenefitForfeit
    ) {
      throw errors.business(
        "ACKNOWLEDGEMENT_REQUIRED",
        "Confirm that the maturity benefit is forfeited before submitting.",
      );
    }
  }
  if (
    preview.systemPolicyClosure
    && preview.maxSettlementPaise != null
    && Number(req.body.settlementPaise ?? preview.settlementPaise) > Number(preview.maxSettlementPaise)
  ) {
    throw errors.business(
      "SETTLEMENT_EXCEEDS_PRINCIPAL",
      "Settlement cannot exceed the refundable principal.",
    );
  }
  if (req.body.mode === RedemptionMode.PURCHASE_ADJUSTMENT) {
    const billNumber = String(req.body.modeDetails?.billNumber ?? "").trim();
    if (!billNumber || billNumber.length > 64) {
      throw errors.business(
        "BILL_NUMBER_REQUIRED",
        "A valid purchase bill number is required for purchase adjustment.",
      );
    }
    req.body.modeDetails = { ...req.body.modeDetails, billNumber };
  }
  return withTransaction(async (session) => {
    const scheme = await Scheme.findOne({
      _id: preview.schemeId,
      tenantId: req.auth.tenantId,
    }).session(session);
    const existingOpen = await Redemption.findOne({
      tenantId: req.auth.tenantId,
      schemeId: preview.schemeId,
      status: { $in: OPEN_REDEMPTION_STATUSES },
    }).session(session);
    if (existingOpen) {
      throw errors.business(
        "REDEMPTION_ALREADY_OPEN",
        "A redemption is already in progress for this scheme. Complete or reject it from Maturity & redemption.",
      );
    }
    if (req.body.expectedVersion !== scheme.version)
      throw new AppError(
        "VERSION_CONFLICT",
        "This scheme changed. Refresh and try again.",
        409,
      );
    const tenant = await Tenant.findById(scheme.tenantId)
      .select("operations")
      .session(session);
    const needsApproval =
      customerRequest ||
      scheme.planSnapshot?.redemptionRules?.approvalRequired ||
      tenant?.operations?.redemptionApprovalRequired;
    const status = needsApproval
      ? RedemptionStatus.PENDING_APPROVAL
      : RedemptionStatus.APPROVED;
    const row = (
      await Redemption.create(
        [
          {
            _id: createId("redemption"),
            tenantId: scheme.tenantId,
            branchId: scheme.branchId,
            schemeId: scheme._id,
            customerId: scheme.customerId,
            closureType,
            mode: req.body.mode,
            modeDetails,
            status,
            principalPaise: preview.principalPaise,
            benefitPaise: preview.benefitPaise,
            benefitWeightMg: preview.benefitWeightMg,
            benefitRatePerGramPaise: preview.benefitRatePerGramPaise,
            penaltyPaise: preview.penaltyPaise,
            penaltyWeightMg: preview.penaltyWeightMg,
            settlementPaise: preview.settlementPaise,
            weightMg:
              preview.weightMg
              ?? (preview.goldWeightMg ?? 0) + (preview.benefitWeightMg ?? 0),
            requestedBy: req.auth.id,
            requestedAt: new Date(),
          },
        ],
        { session },
      )
    )[0];
    const auditEventId = await writeAudit({
      req,
      action:
        closureType === ClosureType.PREMATURE_CLOSURE
          ? "PREMATURE_CLOSURE_REQUESTED"
          : "REDEMPTION_REQUESTED",
      entityType: AuditEntityType.REDEMPTION,
      entityId: row._id,
      after: row.toObject(),
      metadata: req.body.remarks
        ? { remarks: String(req.body.remarks) }
        : undefined,
      session,
    });
    return { ...row.toObject(), auditEventId };
  });
}
export async function transitionRedemption(req, action) {
  return withTransaction(async (session) => {
    const row = await Redemption.findOne({
      _id: req.params.redemptionId ?? req.params.id,
      ...req.scope,
    }).session(session);
    if (!row) throw errors.notFound("Redemption");
    const before = row.toObject();
    const allowed = {
      approve: [RedemptionStatus.PENDING_APPROVAL, RedemptionStatus.REQUESTED],
      reject: [
        RedemptionStatus.PENDING_APPROVAL,
        RedemptionStatus.REQUESTED,
        RedemptionStatus.APPROVED,
      ],
      complete: [RedemptionStatus.APPROVED],
    };
    if (!allowed[action].includes(row.status))
      throw new AppError(
        "REDEMPTION_STATUS_INVALID",
        "This redemption cannot move to the requested status.",
        422,
      );
    row.status =
      action === "approve"
        ? RedemptionStatus.APPROVED
        : action === "reject"
          ? RedemptionStatus.REJECTED
          : RedemptionStatus.COMPLETED;
    if (action === "approve") {
      row.approvedBy = req.auth.id;
      row.approvedAt = new Date();
    }
    if (action === "complete") {
      row.completedBy = req.auth.id;
      row.completedAt = new Date();
      if (req.body?.mode != null && req.body.mode !== row.mode) {
        throw errors.business(
          "REDEMPTION_MODE_NOT_ALLOWED",
          "Redemption mode cannot be changed after the request was created.",
          { requestedMode: row.mode, bodyMode: req.body.mode },
        );
      }
      const snapshotCheck = assertSettlementSnapshotComplete(
        row.modeDetails?.settlementSnapshot,
      );
      if (!snapshotCheck.ok) {
        throw errors.business(
          snapshotCheck.code,
          "This redemption is missing a valid settlement snapshot. Create a new request.",
        );
      }
      if (row.mode === RedemptionMode.PURCHASE_ADJUSTMENT) {
        const billNumber = String(
          req.body.modeDetails?.billNumber ?? row.modeDetails?.billNumber ?? "",
        ).trim();
        if (!billNumber || billNumber.length > 64) {
          throw errors.business(
            "BILL_NUMBER_REQUIRED",
            "A valid purchase bill number is required for purchase adjustment.",
          );
        }
        row.modeDetails = { ...(row.modeDetails ?? {}), billNumber };
      }
      const scheme = await Scheme.findById(row.schemeId).session(session);
      const completeDate = today();
      const freshPreview = await settlementPreview(
        {
          params: { schemeId: row.schemeId },
          auth: req.auth,
          scope: req.scope,
          body: { mode: row.mode },
          query: {},
        },
        row.closureType,
      );
      if (!freshPreview.eligible) {
        throw errors.business(
          freshPreview.blockers[0]?.code ?? "NOT_ELIGIBLE",
          freshPreview.blockers[0]?.message ?? "This scheme is no longer eligible for redemption.",
        );
      }
      const snapshot = row.modeDetails.settlementSnapshot;
      if (snapshot.mode !== row.mode) {
        throw errors.business(
          "SETTLEMENT_VALUE_CHANGED",
          "The settlement amount changed since this request was submitted. Refresh and try again.",
        );
      }
      const baseline = {
        settlementPaise: snapshot.settlementPaise,
        principalPaise: snapshot.principalPaise,
        principalWeightMg: snapshot.principalWeightMg,
        benefitPaise: snapshot.benefitPaise,
        benefitWeightMg: snapshot.benefitWeightMg,
        benefitRatePerGramPaise: snapshot.benefitRatePerGramPaise,
        penaltyPaise: snapshot.penaltyPaise,
        penaltyWeightMg: snapshot.penaltyWeightMg,
        goldWeightMg: snapshot.goldWeightMg,
        weightMg: snapshot.weightMg,
        valuationRatePerGramPaise: snapshot.valuationRatePerGramPaise,
        valuationRateEffectiveDate: snapshot.valuationRateEffectiveDate,
        mode: snapshot.mode,
        systemPolicyClosure: snapshot.systemPolicyClosure,
        closureReason: snapshot.closureReason,
      };
      if (closureSettlementFiguresDiffer(baseline, freshPreview)) {
        throw errors.business(
          "SETTLEMENT_VALUE_CHANGED",
          "The settlement amount changed since this request was submitted. Refresh and try again.",
        );
      }
      if (settlementSnapshotClassificationInvalid(snapshot, scheme, freshPreview)) {
        throw errors.business(
          "SETTLEMENT_VALUE_CHANGED",
          "Settlement classification no longer matches this scheme. Create a new request.",
        );
      }
      row.principalPaise = freshPreview.principalPaise;
      row.benefitPaise = freshPreview.benefitPaise;
      row.benefitWeightMg = freshPreview.benefitWeightMg;
      row.benefitRatePerGramPaise = freshPreview.benefitRatePerGramPaise;
      row.penaltyPaise = freshPreview.penaltyPaise;
      row.penaltyWeightMg = freshPreview.penaltyWeightMg;
      row.settlementPaise = freshPreview.settlementPaise;
      row.weightMg =
        freshPreview.weightMg
        ?? (freshPreview.goldWeightMg ?? 0) + (freshPreview.benefitWeightMg ?? 0);
      let ledgerDebitAmountPaise;
      let ledgerDebitWeightMg;
      let ledgerDebitRatePaise = 0;

      if (row.mode === RedemptionMode.GOLD_HANDOVER) {
        const rate = await goldRateForExactDate(
          { tenantId: row.tenantId, branchId: row.branchId },
          completeDate,
        );
        if (!rate || rate.effectiveDate !== completeDate) {
          throw errors.business(
            "GOLD_RATE_NOT_SET",
            "Set today's 22K gold rate before completing a gold handover.",
          );
        }
        const goldRules = scheme.planSnapshot?.goldRules ?? {};
        const tenantOps = await Tenant.findById(row.tenantId)
          .select("operations")
          .session(session)
          .lean();
        const rounding = decimalRoundingMode(
          goldRules.weightRoundingMode
            ?? tenantOps?.operations?.weightRoundingMode
            ?? "HALF_UP",
        );
        const precisionMg = goldRules.weightPrecisionMg ?? 1;
        row.handoverRatePerGramPaise = rate.ratePerGramPaise;
        row.handoverRateEffectiveDate = rate.effectiveDate;
        row.cashOutPaise = 0;
        if (scheme.valueBasis === ValueBasis.GOLD_WEIGHT) {
          row.handoverValuePaise = freshPreview.settlementPaise ?? 0;
          ledgerDebitAmountPaise = row.handoverValuePaise;
          ledgerDebitWeightMg = row.weightMg ?? 0;
        } else {
          let handoverWeightMg = moneyToWeightMg(
            row.settlementPaise ?? 0,
            rate.ratePerGramPaise,
            rounding,
          );
          handoverWeightMg = applyWeightPrecisionMg(
            handoverWeightMg,
            precisionMg,
            rounding,
          );
          if (!(handoverWeightMg > 0)) {
            throw errors.business(
              "GOLD_WEIGHT_ROUNDS_TO_ZERO",
              "Settlement rounds to zero gold weight at today's rate.",
            );
          }
          row.weightMg = handoverWeightMg;
          row.handoverValuePaise = moneyPaiseFromWeightMg(
            handoverWeightMg,
            rate.ratePerGramPaise,
          );
          ledgerDebitAmountPaise = row.settlementPaise ?? 0;
          ledgerDebitWeightMg = handoverWeightMg;
        }
        ledgerDebitRatePaise = rate.ratePerGramPaise;
      } else if (row.mode === RedemptionMode.PURCHASE_ADJUSTMENT) {
        row.cashOutPaise = 0;
        row.handoverValuePaise = 0;
        ledgerDebitAmountPaise = row.settlementPaise ?? 0;
        ledgerDebitWeightMg =
          scheme.valueBasis === ValueBasis.GOLD_WEIGHT
            ? (freshPreview.goldWeightMg ?? 0) + (freshPreview.benefitWeightMg ?? 0)
            : 0;
      } else {
        row.cashOutPaise = row.settlementPaise ?? 0;
        row.handoverValuePaise = 0;
        row.handoverRatePerGramPaise = undefined;
        row.handoverRateEffectiveDate = undefined;
        ledgerDebitAmountPaise = row.settlementPaise ?? 0;
        ledgerDebitWeightMg =
          scheme.valueBasis === ValueBasis.GOLD_WEIGHT
            ? (freshPreview.goldWeightMg ?? 0) + (freshPreview.benefitWeightMg ?? 0)
            : 0;
      }

      const nextLedgerSequence = () =>
        nextSchemeLedgerSequence(row.tenantId, row.schemeId, session);
      let sequence = await nextLedgerSequence();
      if (row.benefitPaise > 0 || row.benefitWeightMg > 0) {
        await LedgerEntry.create(
          [
            {
              _id: createId("ledger"),
              tenantId: row.tenantId,
              branchId: row.branchId,
              schemeId: row.schemeId,
              customerId: row.customerId,
              redemptionId: row._id,
              type: LedgerEntryType.BENEFIT_CREDIT,
              sequence,
              amountPaise: row.benefitPaise,
              weightMg: row.benefitWeightMg,
              ratePerGramPaise: row.benefitRatePerGramPaise,
              actorType: "USER",
              actorId: req.auth.id,
              description: "Maturity benefit",
            },
          ],
          { session },
        );
        sequence = await nextLedgerSequence();
      }
      if (row.penaltyPaise > 0) {
        await LedgerEntry.create(
          [
            {
              _id: createId("ledger"),
              tenantId: row.tenantId,
              branchId: row.branchId,
              schemeId: row.schemeId,
              customerId: row.customerId,
              redemptionId: row._id,
              type: LedgerEntryType.CLOSURE_PENALTY,
              sequence,
              amountPaise: row.penaltyPaise,
              weightMg: row.penaltyWeightMg > 0 ? row.penaltyWeightMg : undefined,
              actorType: "USER",
              actorId: req.auth.id,
              description: "Premature closure penalty",
            },
          ],
          { session },
        );
        sequence = await nextLedgerSequence();
      }
      const redemptionDescription =
        row.mode === RedemptionMode.PURCHASE_ADJUSTMENT
          ? "Purchase adjustment completed"
          : row.mode === RedemptionMode.GOLD_HANDOVER
            ? "Gold handover completed"
            : "Cash redemption completed";
      await LedgerEntry.create(
        [
          {
            _id: createId("ledger"),
            tenantId: row.tenantId,
            branchId: row.branchId,
            schemeId: row.schemeId,
            customerId: row.customerId,
            redemptionId: row._id,
            type: LedgerEntryType.REDEMPTION_DEBIT,
            sequence,
            amountPaise: ledgerDebitAmountPaise,
            weightMg: ledgerDebitWeightMg,
            ratePerGramPaise: ledgerDebitRatePaise,
            actorType: "USER",
            actorId: req.auth.id,
            description: redemptionDescription,
            metadata: row.modeDetails?.billNumber
              ? { billNumber: row.modeDetails.billNumber }
              : undefined,
          },
        ],
        { session },
      );
      const schemeBefore = scheme.toObject();
      if (isSystemPolicyClosureSettlement(scheme)) {
        scheme.settlementRequired = false;
        scheme.settlementCompletedAt = new Date();
      } else {
        scheme.status =
          row.closureType === ClosureType.PREMATURE_CLOSURE
            ? SchemeStatus.CLOSED_PREMATURE
            : SchemeStatus.REDEEMED;
      }
      scheme.version += 1;
      await scheme.save({ session });
      await writeAudit({
        req,
        action:
          row.closureType === ClosureType.PREMATURE_CLOSURE
            ? "SCHEME_CLOSED_PREMATURE"
            : "SCHEME_REDEEMED",
        entityType: AuditEntityType.SCHEME,
        entityId: scheme._id,
        before: schemeBefore,
        after: scheme.toObject(),
        metadata: { redemptionId: row._id },
        session,
      });
    }
    if (action === "reject") row.rejectionReason = req.body.reason;
    row.version += 1;
    await row.save({ session });
    const metadata = {};
    if (action === "reject" && req.body.reason) {
      metadata.reason = String(req.body.reason);
    }
    if (req.body.remarks) metadata.remarks = String(req.body.remarks);
    const auditEventId = await writeAudit({
      req,
      action: `REDEMPTION_${row.status}`,
      entityType: AuditEntityType.REDEMPTION,
      entityId: row._id,
      before,
      after: row.toObject(),
      metadata: Object.keys(metadata).length ? metadata : undefined,
      session,
    });
    return { ...row.toObject(), auditEventId };
  });
}
export async function getRedemptionForAdmin(req) {
  const row = await Redemption.findOne({
    _id: req.params.redemptionId,
    ...req.scope,
  }).lean();
  if (!row) throw errors.notFound("Redemption");

  const [customer, scheme, branch] = await Promise.all([
    Customer.findOne({ _id: row.customerId, tenantId: row.tenantId })
      .select("_id name mobile customerNumber")
      .lean(),
    Scheme.findOne({ _id: row.schemeId, tenantId: row.tenantId })
      .select(
        "_id enrollmentNumber status maturityDate valueBasis planSnapshot.name customerId closureReason settlementRequired settlementCompletedAt",
      )
      .lean(),
    row.branchId
      ? Branch.findOne({ _id: row.branchId, tenantId: row.tenantId })
          .select("_id name code")
          .lean()
      : null,
  ]);

  return {
    ...row,
    id: row._id,
    customer: customer
      ? {
          _id: customer._id,
          id: customer._id,
          name: customer.name,
          mobile: customer.mobile,
          customerNumber: customer.customerNumber,
        }
      : undefined,
    scheme: scheme
      ? {
          _id: scheme._id,
          id: scheme._id,
          enrollmentNumber: scheme.enrollmentNumber,
          name: scheme.planSnapshot?.name,
          status: scheme.status,
          maturityDate: scheme.maturityDate,
          closureReason: scheme.closureReason ?? null,
          settlementRequired: scheme.settlementRequired === true,
          settlementCompletedAt: scheme.settlementCompletedAt ?? null,
        }
      : undefined,
    systemPolicyClosure: Boolean(
      row.modeDetails?.settlementSnapshot?.systemPolicyClosure,
    ),
    closureReasonSnapshot:
      row.modeDetails?.settlementSnapshot?.closureReason ?? null,
    branch: branch
      ? {
          _id: branch._id,
          id: branch._id,
          name: branch.name,
          code: branch.code,
        }
      : undefined,
  };
}

export async function listRedemptions(req) {
  const filters = {};
  if (req.query.open === "true" || req.query.open === "1") {
    filters.status = { $in: OPEN_REDEMPTION_STATUSES };
  } else if (req.query.status) {
    filters.status = req.query.status;
  }
  if (req.query.closureType) filters.closureType = req.query.closureType;
  if (req.query.mode) filters.mode = req.query.mode;
  Object.assign(filters, dateMatch("createdAt", req.query));
  const scope = effectiveScope(req);
  const pattern = searchRegex(req.query.q);
  if (pattern) {
    const matchedCustomers = await Customer.find({
      tenantId: req.auth.tenantId,
      ...(req.scope.branchId ? { branchId: req.scope.branchId } : {}),
      $or: [
        { name: pattern },
        { mobile: pattern },
        { customerNumber: pattern },
      ],
    })
      .select("_id")
      .lean();
    filters.$or = [
      { customerId: { $in: matchedCustomers.map((row) => row._id) } },
      { schemeId: pattern },
    ];
  }
  const result = await paginate(Redemption, {
    scope,
    filters,
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: "createdAt:desc",
  });
  if (!result.data.length) return result;
  const customerIds = [
    ...new Set(result.data.map((row) => row.customerId).filter(Boolean)),
  ];
  const schemeIds = [
    ...new Set(result.data.map((row) => row.schemeId).filter(Boolean)),
  ];
  const [customers, schemes] = await Promise.all([
    Customer.find({ _id: { $in: customerIds } })
      .select("_id name")
      .lean(),
    Scheme.find({ _id: { $in: schemeIds } })
      .select("_id enrollmentNumber planSnapshot.name")
      .lean(),
  ]);
  const customerMap = new Map(customers.map((row) => [row._id, row]));
  const schemeMap = new Map(schemes.map((row) => [row._id, row]));
  result.data = result.data.map((row) => {
    const customer = customerMap.get(row.customerId);
    const scheme = schemeMap.get(row.schemeId);
    return {
      ...row,
      customer: customer
        ? { _id: customer._id, id: customer._id, name: customer.name }
        : undefined,
      scheme: scheme
        ? {
            _id: scheme._id,
            id: scheme._id,
            enrollmentNumber: scheme.enrollmentNumber,
            name: scheme.planSnapshot?.name,
            schemeNumber: scheme.enrollmentNumber,
          }
        : undefined,
    };
  });
  return result;
}
