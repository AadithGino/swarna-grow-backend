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
import { ledgerTotals } from "./scheme.service.js";
import { writeAudit } from "./audit.service.js";
import { paginate } from "../lib/pagination.js";
import { latestGoldRateOnOrBefore } from "./tenant.service.js";
import { moneyToWeightMg, weightMgToMoneyPaise } from "../lib/money.js";
import { dateMatch, effectiveScope, searchRegex } from "../lib/query-filters.js";
import { addMonthsClamped, elapsedSchemeMonths, today } from "../lib/date.js";
import { assertFeatureEntitled } from "../lib/tenant-limits.js";

const OPEN_REDEMPTION_STATUSES = [
  RedemptionStatus.REQUESTED,
  RedemptionStatus.PENDING_APPROVAL,
  RedemptionStatus.APPROVED,
];

const REDEMPTION_MODE_LABELS = {
  CASH: "Cash payout",
  GOLD_HANDOVER: "Take as gold",
  PURCHASE_ADJUSTMENT: "Adjust against purchase",
  TRANSFER_TO_SCHEME: "Start a new scheme",
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

function computePenaltyPaise(penaltyRule, amountPaidPaise) {
  if (!penaltyRule || penaltyRule.mode === "NONE") return 0;
  if (penaltyRule.mode === "PERCENT_OF_PAID") {
    return Math.floor((amountPaidPaise * (penaltyRule.value ?? 0)) / 100);
  }
  if (penaltyRule.mode === "FLAT") {
    return penaltyRule.flatPaise ?? penaltyRule.value ?? 0;
  }
  return penaltyRule.value ?? 0;
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
  const totals = ledgerTotals(entries);
  const rules = scheme.planSnapshot?.redemptionRules ?? {};
  const benefitDef = scheme.planSnapshot?.benefit ?? null;
  const isPremature = closureType === ClosureType.PREMATURE_CLOSURE;
  const paidCount = installmentsPaidCount(scheme);
  const monthsCompleted = elapsedSchemeMonths(scheme.startDate, today());
  const lockInMonths = rules.lockInMonths ?? 0;
  const lockInEligibleFrom = addMonthsClamped(scheme.startDate, lockInMonths).format("YYYY-MM-DD");
  const lockInMet = lockInMonths === 0 || monthsCompleted >= lockInMonths;
  const blockers = [];

  if (isPremature) {
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
  } else if (scheme.status !== SchemeStatus.MATURED) {
    blockers.push({
      code: "SCHEME_NOT_MATURED",
      message: "The scheme has not matured yet.",
      eligibleFrom: scheme.maturityDate,
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
    !isPremature &&
    benefitDef &&
    benefitDef.type !== "TEXT_ONLY" &&
    monthsCompleted >= minMonthsCompleted &&
    ((!eligibility?.requireAllInstallmentsPaid || requiredPaid) &&
      defaultCount <= (eligibility?.maxAllowedDefaults ?? Number.MAX_SAFE_INTEGER));

  const cycleCap =
    scheme.lockedAveragePaise ||
    scheme.cycles?.find((cycle) => cycle.capPaise > 0)?.capPaise ||
    0;

  let benefitPaise = 0;
  if (benefitEligible && benefitDef?.type === "FIXED_BONUS_AMOUNT") {
    benefitPaise =
      benefitDef.bonusBasis === "PERCENT_OF_PAID"
        ? Math.floor((totals.amountPaidPaise * benefitDef.bonusValue) / 100)
        : benefitDef.bonusValue;
    if (benefitDef.maxBonusPaise) benefitPaise = Math.min(benefitPaise, benefitDef.maxBonusPaise);
  }
  if (benefitEligible && benefitDef?.type === "ONE_FREE_INSTALLMENT") {
    benefitPaise =
      scheme.paymentPattern === "FLEXIBLE"
        ? cycleCap
        : scheme.installmentAmountPaise;
  }

  const penaltyRule = isPremature ? rules.prematurePenalty : null;
  const penaltyPaise = isPremature
    ? computePenaltyPaise(penaltyRule, totals.amountPaidPaise)
    : 0;

  let benefitWeightMg = 0;
  let benefitRatePerGramPaise = 0;
  if (scheme.valueBasis === "GOLD_WEIGHT" && benefitPaise > 0) {
    const rate = await latestGoldRateOnOrBefore(
      { tenantId: scheme.tenantId, branchId: scheme.branchId },
      scheme.maturityDate,
    );
    if (!rate) {
      blockers.push({
        code: "GOLD_RATE_NOT_SET",
        message:
          "A gold rate effective on or before the maturity date is required to calculate the benefit.",
      });
    } else {
      benefitRatePerGramPaise = rate.ratePerGramPaise;
      benefitWeightMg = moneyToWeightMg(benefitPaise, benefitRatePerGramPaise);
    }
  }

  const settlementPaise = Math.max(
    0,
    totals.amountPaidPaise + benefitPaise - penaltyPaise,
  );
  const eligible = blockers.length === 0;

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

  if (isPremature) {
    lines.push({
      key: "BENEFIT",
      label: `${benefitLabel} — forfeited`,
      amount: moneyField(0),
      sign: "+",
      forfeited: true,
      forfeitReason: "Benefit applies only on maturity",
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
    available:
      row.mode !== RedemptionMode.GOLD_HANDOVER ||
      scheme.valueBasis === ValueBasis.GOLD_WEIGHT,
  }));

  const tenant = await Tenant.findById(scheme.tenantId)
    .select("operations")
    .lean();
  const approvalRequired = Boolean(
    rules.approvalRequired ||
      tenant?.operations?.redemptionApprovalRequired,
  );
  const warningText = isPremature && eligible
    ? penaltyPaise > 0
      ? "Closing early forfeits the maturity benefit and applies a premature closure charge. This cannot be undone."
      : "Closing early forfeits the maturity benefit. This cannot be undone."
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
      goldWeight: totals.goldWeightMg
        ? { weightMg: totals.goldWeightMg, weightDisplay: `${(totals.goldWeightMg / 1000).toFixed(3)} g` }
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
    approvalRequired,
    approvalReason: approvalRequired
      ? "Admin approval is required before this scheme can be closed."
      : undefined,
    warningText,
    closureType,
    schemeId: scheme._id,
    principalPaise: totals.amountPaidPaise,
    goldWeightMg: totals.goldWeightMg,
    benefitEligible,
    benefitPaise,
    benefitWeightMg,
    benefitRatePerGramPaise,
    penaltyPaise,
    settlementPaise,
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
  const preview = await settlementPreview(req, ClosureType.MATURITY_REDEMPTION);
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
      settlementSnapshot: {
        schemeVersion: scheme.version,
        principalPaise: preview.principalPaise,
        benefitPaise: preview.benefitPaise,
        benefitWeightMg: preview.benefitWeightMg,
        benefitRatePerGramPaise: preview.benefitRatePerGramPaise,
        penaltyPaise: preview.penaltyPaise,
        settlementPaise: preview.settlementPaise,
        goldWeightMg: preview.goldWeightMg,
        computedAt: new Date().toISOString(),
      },
    },
    status: RedemptionStatus.REQUESTED,
    principalPaise: preview.principalPaise,
    benefitPaise: preview.benefitPaise,
    benefitWeightMg: preview.benefitWeightMg,
    benefitRatePerGramPaise: preview.benefitRatePerGramPaise,
    penaltyPaise: preview.penaltyPaise,
    settlementPaise: preview.settlementPaise,
    weightMg: (preview.goldWeightMg ?? 0) + (preview.benefitWeightMg ?? 0),
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
  const schemeRow = await Scheme.findOne({
    _id: req.params.schemeId,
    tenantId: req.auth.tenantId,
    ...(req.auth.type === "CUSTOMER" ? { customerId: req.auth.id } : req.scope),
  }).lean();
  if (!schemeRow) throw errors.notFound("Scheme");
  assertRedemptionModeAllowed(schemeRow.planSnapshot?.redemptionRules, req.body.mode);
  assertRedemptionBranchAllowed(schemeRow, req);
  if (closureType === ClosureType.PREMATURE_CLOSURE) {
    assertFeatureEntitled(
      req.tenant ?? await Tenant.findById(req.auth.tenantId).lean(),
      "prematureRedemption",
      "Premature closure is not included in your plan.",
    );
  }
  const preview = await settlementPreview(req, closureType);
  if (!preview.eligible) {
    throw errors.business(
      preview.blockers[0]?.code ?? "NOT_ELIGIBLE",
      preview.blockers[0]?.message ?? "This scheme is not eligible for closure.",
    );
  }
  const modeDetails = req.body.modeDetails ?? {};
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
  if (closureType === ClosureType.PREMATURE_CLOSURE) {
    if (preview.penaltyPaise > 0 && !modeDetails.acknowledgePenalty) {
      throw errors.business(
        "ACKNOWLEDGEMENT_REQUIRED",
        "Confirm the premature closure penalty before submitting.",
      );
    }
    if (!modeDetails.acknowledgeBenefitForfeit) {
      throw errors.business(
        "ACKNOWLEDGEMENT_REQUIRED",
        "Confirm that the maturity benefit is forfeited before submitting.",
      );
    }
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
            modeDetails: req.body.modeDetails,
            status,
            principalPaise: preview.principalPaise,
            benefitPaise: preview.benefitPaise,
            benefitWeightMg: preview.benefitWeightMg,
            benefitRatePerGramPaise: preview.benefitRatePerGramPaise,
            penaltyPaise: preview.penaltyPaise,
            settlementPaise: preview.settlementPaise,
            weightMg: preview.goldWeightMg + preview.benefitWeightMg,
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
      reject: [RedemptionStatus.PENDING_APPROVAL, RedemptionStatus.REQUESTED],
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
      const scheme = await Scheme.findById(row.schemeId).session(session);
      const freshPreview = await settlementPreview(
        {
          params: { schemeId: row.schemeId },
          auth: req.auth,
          scope: req.scope,
        },
        row.closureType,
      );
      if (!freshPreview.eligible) {
        throw errors.business(
          freshPreview.blockers[0]?.code ?? "NOT_ELIGIBLE",
          freshPreview.blockers[0]?.message ?? "This scheme is no longer eligible for redemption.",
        );
      }
      if (Number(freshPreview.settlementPaise) !== Number(row.settlementPaise)) {
        throw errors.business(
          "SETTLEMENT_VALUE_CHANGED",
          "The settlement amount changed since this request was submitted. Refresh and try again.",
        );
      }
      row.principalPaise = freshPreview.principalPaise;
      row.benefitPaise = freshPreview.benefitPaise;
      row.benefitWeightMg = freshPreview.benefitWeightMg;
      row.benefitRatePerGramPaise = freshPreview.benefitRatePerGramPaise;
      row.penaltyPaise = freshPreview.penaltyPaise;
      row.settlementPaise = freshPreview.settlementPaise;
      row.weightMg = (freshPreview.goldWeightMg ?? 0) + (freshPreview.benefitWeightMg ?? 0);
      const completeDate = today();
      let ledgerDebitAmountPaise;
      let ledgerDebitWeightMg;
      let ledgerDebitRatePaise = 0;

      if (
        row.mode === RedemptionMode.GOLD_HANDOVER &&
        scheme.valueBasis === ValueBasis.GOLD_WEIGHT
      ) {
        const rate = await latestGoldRateOnOrBefore(
          { tenantId: row.tenantId, branchId: row.branchId },
          completeDate,
        );
        if (!rate) {
          throw errors.business(
            "GOLD_RATE_NOT_SET",
            "Set today's gold rate before completing a gold handover.",
          );
        }
        row.handoverRatePerGramPaise = rate.ratePerGramPaise;
        row.handoverRateEffectiveDate = rate.effectiveDate;
        row.handoverValuePaise = weightMgToMoneyPaise(
          row.weightMg ?? 0,
          rate.ratePerGramPaise,
        );
        row.cashOutPaise = 0;
        ledgerDebitAmountPaise = row.handoverValuePaise;
        ledgerDebitWeightMg = row.weightMg ?? 0;
        ledgerDebitRatePaise = rate.ratePerGramPaise;
      } else if (row.mode === RedemptionMode.GOLD_HANDOVER) {
        row.cashOutPaise = 0;
        row.handoverValuePaise = row.settlementPaise ?? 0;
        ledgerDebitAmountPaise = row.settlementPaise ?? 0;
        ledgerDebitWeightMg = 0;
      } else {
        row.cashOutPaise = row.settlementPaise ?? 0;
        row.handoverValuePaise = 0;
        row.handoverRatePerGramPaise = undefined;
        row.handoverRateEffectiveDate = undefined;
        ledgerDebitAmountPaise = row.settlementPaise ?? 0;
        ledgerDebitWeightMg =
          scheme.valueBasis === ValueBasis.GOLD_WEIGHT ? (row.weightMg ?? 0) : 0;
      }

      let sequence =
        (await LedgerEntry.countDocuments({ schemeId: scheme._id }).session(
          session,
        )) + 1;
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
        sequence += 1;
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
              actorType: "USER",
              actorId: req.auth.id,
              description: "Premature closure penalty",
            },
          ],
          { session },
        );
        sequence += 1;
      }
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
            description:
              row.mode === RedemptionMode.GOLD_HANDOVER
                ? "Gold handover completed"
                : "Cash redemption completed",
          },
        ],
        { session },
      );
      const schemeBefore = scheme.toObject();
      scheme.status =
        row.closureType === ClosureType.PREMATURE_CLOSURE
          ? SchemeStatus.CLOSED_PREMATURE
          : SchemeStatus.REDEEMED;
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
        "_id enrollmentNumber status maturityDate valueBasis planSnapshot.name customerId",
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
        }
      : undefined,
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
