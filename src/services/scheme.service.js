import {
  AuditEntityType,
  FirstInstallmentMode,
  FlexiblePhase,
  PaymentIntentStatus,
  PaymentPattern,
  PaymentStatus,
  RedemptionStatus,
  SchemePlanStatus,
  SchemeStatus,
} from "../constants/enums.js";
import {
  Branch,
  Customer,
  LedgerEntry,
  Payment,
  PaymentIntent,
  Redemption,
  Scheme,
  SchemePlan,
} from "../models/index.js";
import { errors, AppError } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import { computeFlexibleLockCapDetails } from "../lib/flexible-cap.js";
import {
  ENROLMENT_CAPACITY_STATUSES,
  ONE_ACTIVE_SCHEME_CONFLICT_STATUSES,
  OPEN_ENROLLMENT_STATUSES,
} from "../lib/scheme-enrollment-status.js";
import { computeFixedPaymentQuote } from "../lib/fixed-payment-policy.js";
import { analyzeFreeWindowLedgerForCap } from "../lib/flexible-free-window-net.js";
import { applySystemFlexLockClosure } from "../lib/flexible-lock-settlement.js";
import { withTransaction, withTransientTransactionRetry } from "../lib/transaction.js";
import {
  assertAnalyticsPeriod,
  buildAnalyticsScope,
  formatPeriodLabel,
  formatTrendBucketLabel,
  inferTrendGroupBy,
  percentChange,
  previousPeriod,
  rollupDailyRegistrationCounts,
} from "../lib/analytics-period.js";
import { dateMatch, calendarDateMatch, effectiveScope, searchRegex } from "../lib/query-filters.js";
import { moneyRef } from "../lib/money.js";
import { generatedAtIst } from "./report-builders/report-envelope.js";
import { buildFlexibleEnrolPreview } from "./plan.service.js";
import {
  buildCalendarMonthCycles,
  buildFlexibleSchemeCycleRows,
  isFlexibleLockDueAfterFreePhase,
  maturityDateFromCalendarCycles,
  resolveAuthoritativeFreePhaseTargetCycle,
} from "../lib/calendar-cycle.js";
import { buildSchedulePreview, resolveFixedSchemeMaturityDate } from "./schedule.service.js";
import { writeAudit } from "./audit.service.js";
import { today, addMonthsClamped, monthKey } from "../lib/date.js";
import { mapAdminLedgerEntry, paymentGoldAccrualDto } from "../lib/payment-gold-dto.js";
import { normalizePlanFinancialRules } from "../lib/plan-amount-normalize.js";
import { nextSequence } from "./sequence.service.js";
import { assertFeatureEntitled } from "../lib/tenant-limits.js";
import { serializeCustomerEnrolment } from "../lib/enrolment-customer-serialization.js";
import {
  assertOneActiveSchemePolicy,
  revalidateLockedPlanForEnrolment,
} from "../lib/enrolment-in-transaction-validation.js";

function validateAmount(plan, amount) {
  normalizePlanFinancialRules(plan);
  const rules = plan.amountRules ?? {};
  if (plan.paymentPattern === PaymentPattern.FLEXIBLE) {
    const fp = plan.flexibleRules?.flexiblePhase ?? {};
    if (fp.minimumPaymentPaise != null && amount < fp.minimumPaymentPaise) {
      throw errors.business("AMOUNT_BELOW_MINIMUM", "The amount is below the free-window minimum.");
    }
    if (fp.maximumPaymentPaise != null && amount > fp.maximumPaymentPaise) {
      throw errors.business("AMOUNT_ABOVE_MAXIMUM", "The amount is above the free-window maximum.");
    }
    return;
  }
  if (rules.amountMode === "JEWELLER_FIXED" && amount !== rules.fixedAmountPaise) throw errors.business("INVALID_INSTALLMENT_AMOUNT", "The installment must match the fixed plan amount.");
  if (rules.amountMode === "JEWELLER_SLABS" && !rules.slabsPaise.includes(amount)) throw errors.business("INVALID_INSTALLMENT_AMOUNT", "Choose one of the plan's installment slabs.");
  if (rules.minInstallmentPaise != null && amount < rules.minInstallmentPaise) throw errors.business("AMOUNT_BELOW_MINIMUM", "The amount is below the plan minimum.");
  if (rules.maxInstallmentPaise && amount > rules.maxInstallmentPaise) throw errors.business("AMOUNT_ABOVE_MAXIMUM", "The amount is above the plan maximum.");
  if (rules.multipleOfPaise && amount % rules.multipleOfPaise !== 0) throw errors.business("AMOUNT_NOT_MULTIPLE", `The amount must be a multiple of ${rules.multipleOfPaise} paise.`);
}

const OPEN_REDEMPTION_STATUSES = [
  RedemptionStatus.REQUESTED,
  RedemptionStatus.PENDING_APPROVAL,
  RedemptionStatus.APPROVED,
];

async function schemePresentationExtras(scheme) {
  const [open, completed] = await Promise.all([
    Redemption.findOne({
      tenantId: scheme.tenantId,
      schemeId: scheme._id,
      status: { $in: OPEN_REDEMPTION_STATUSES },
    })
      .select("_id status closureType settlementPaise mode requestedAt")
      .lean(),
    [SchemeStatus.REDEEMED, SchemeStatus.CLOSED_PREMATURE].includes(
      scheme.status,
    )
      ? Redemption.findOne({
          tenantId: scheme.tenantId,
          schemeId: scheme._id,
          status: RedemptionStatus.COMPLETED,
        })
          .sort({ completedAt: -1 })
          .select(
            "_id status closureType settlementPaise mode completedAt requestedAt",
          )
          .lean()
      : null,
  ]);
  const canRecordPayment =
    !open &&
    [SchemeStatus.ACTIVE, SchemeStatus.LOCKED, SchemeStatus.DEFAULTED].includes(
      scheme.status,
    );
  const canRedeem = !open && scheme.status === SchemeStatus.MATURED;
  return {
    uiStatus: open ? "REDEMPTION_PENDING" : scheme.status,
    actions: { canRecordPayment, canRedeem },
    pendingRedemption: open
      ? {
          id: open._id,
          status: open.status,
          closureType: open.closureType,
          settlementPaise: open.settlementPaise,
          mode: open.mode,
          requestedAt: open.requestedAt,
        }
      : null,
    completedRedemption: completed
      ? {
          id: completed._id,
          status: completed.status,
          closureType: completed.closureType,
          settlementPaise: completed.settlementPaise,
          mode: completed.mode,
          completedAt: completed.completedAt,
          requestedAt: completed.requestedAt,
        }
      : null,
  };
}

function moneyField(paise) {
  return {
    amountPaise: paise,
    amountDisplay: new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100),
  };
}

/** Map successful payments to installments using the same FIFO allocation as recording. */
function assignPaymentsToInstallments(installments, payments) {
  const links = new Map();
  const sortedPay = [...payments]
    .filter((row) => row.status === "SUCCESS")
    .sort((a, b) => new Date(a.paidAt).getTime() - new Date(b.paidAt).getTime());
  const insts = [...installments].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  let index = 0;
  let available = 0;
  let current = null;
  for (const inst of insts) {
    let required = inst.amountPaise ?? 0;
    if (required <= 0) continue;
    while (required > 0 && index < sortedPay.length) {
      if (available <= 0) {
        current = sortedPay[index++];
        available = current.amountPaise ?? 0;
      }
      const applied = Math.min(required, available);
      available -= applied;
      required -= applied;
    }
    if (required <= 0 && current) links.set(inst.number, current);
  }
  return links;
}

function buildFixedPassbook(scheme, payments) {
  const installments = scheme.installments ?? [];
  if (!installments.length) return null;
  const links = assignPaymentsToInstallments(installments, payments);
  const rows = installments.map((inst) => {
    const pay = links.get(inst.number);
    return {
      installmentNumber: inst.number,
      dueDate: inst.dueDate,
      amountDue: moneyField(inst.amountPaise ?? 0),
      status: inst.status,
      payment: pay
        ? {
          id: pay._id,
          _id: pay._id,
          receiptNumber: pay.receiptNumber,
          paidAt: pay.paidAt,
          amountPaid: moneyField(pay.amountPaise),
          mode: pay.mode,
          goldAccrual: paymentGoldAccrualDto(pay),
        }
        : null,
    };
  });
  const paidPaise = installments.reduce((sum, row) => sum + (row.paidPaise ?? 0), 0);
  const pendingPaise = installments.reduce((sum, row) => {
    if (["PAID", "WAIVED"].includes(row.status)) return sum;
    return sum + Math.max(0, (row.amountPaise ?? 0) - (row.paidPaise ?? 0));
  }, 0);
  return {
    rows,
    totals: {
      paid: moneyField(paidPaise),
      pending: moneyField(pendingPaise),
      installmentsPaid: installments.filter((row) => ["PAID", "WAIVED"].includes(row.status)).length,
      installmentsTotal: installments.length,
    },
  };
}

function enrolBlockerActionPath(code, customerId) {
  if (code === "KYC_REQUIRED" && customerId) return `/customers/${customerId}/kyc`;
  return undefined;
}

function resolveEnrolBranchId(req, customer) {
  if (req.auth?.type === "CUSTOMER") return customer?.branchId ?? null;
  if (req.scope?.branchId) return req.scope.branchId;
  return req.body.branchId ?? customer?.branchId ?? null;
}

async function assertActiveEnrolBranch(tenantId, branchId) {
  if (!branchId) throw errors.business("BRANCH_REQUIRED", "An active enrolment branch is required.");
  const branch = await Branch.findOne({ _id: branchId, tenantId, active: true }).select("_id").lean();
  if (!branch) throw errors.business("BRANCH_NOT_ACTIVE", "The selected branch is not active for this jewellery.");
}

function assertPlanAvailableAtBranch(plan, branchId) {
  if (!branchId || plan.availability?.allBranches !== false) return;
  const allowed = plan.availability?.branchIds ?? [];
  if (!allowed.includes(branchId)) {
    throw errors.business("PLAN_NOT_AVAILABLE_AT_BRANCH", "This plan is not available at the customer's branch.");
  }
}

function defaultInstallmentAmountPaise(plan, requested) {
  const rules = plan.amountRules ?? {};
  if (requested != null) return requested;
  if (rules.amountMode === "JEWELLER_FIXED") return rules.fixedAmountPaise;
  if (rules.amountMode === "JEWELLER_SLABS" && rules.slabsPaise?.length === 1) return rules.slabsPaise[0];
  return rules.minInstallmentPaise ?? rules.fixedAmountPaise;
}

export async function validateEnrolment(req) {
  if (req.auth?.type === "CUSTOMER") {
    if (req.tenant?.operations?.customerSelfEnrolEnabled === false) {
      throw errors.business(
        "SELF_ENROL_DISABLED",
        "Self-enrolment is not available. Contact your branch to join a scheme.",
      );
    }
    assertFeatureEntitled(req.tenant, "customerSelfEnrol", "Your jewellery plan does not include customer self-enrolment.");
    req.body.customerId = req.auth.id;
    delete req.body.branchId;
    if (req.body.firstInstallmentAction || req.body.payment) {
      throw errors.business("MANUAL_PAYMENT_NOT_ALLOWED", "Customers cannot record manual payments during enrolment.");
    }
  }
  const [customer, plan] = await Promise.all([Customer.findOne({ _id: req.body.customerId, ...req.scope }).lean(), SchemePlan.findOne({ _id: req.body.planId, tenantId: req.auth.tenantId }).lean()]);
  if (!customer) throw errors.notFound("Customer"); if (!plan) throw errors.notFound("Scheme plan");
  if (plan.status !== SchemePlanStatus.ACTIVE) throw errors.business("PLAN_ENROLMENT_CLOSED", "This plan is not accepting enrolments.");
  const availability = plan.availability ?? {};
  const calendarToday = today();
  if (availability.enrolmentOpenFrom && calendarToday < availability.enrolmentOpenFrom) throw errors.business("PLAN_ENROLMENT_NOT_OPEN", `Enrolment opens on ${availability.enrolmentOpenFrom}.`);
  if (availability.enrolmentOpenTo && calendarToday > availability.enrolmentOpenTo) throw errors.business("PLAN_ENROLMENT_CLOSED", "The enrolment window for this plan has closed.");
  if (req.auth?.type === "CUSTOMER" && availability.customerSelfEnrolAllowed !== true) throw errors.business("PLAN_SELF_ENROL_DISABLED", "This plan requires branch-assisted enrolment.");
  if (availability.maxEnrolments != null) {
    const enrolled = await Scheme.countDocuments({
      tenantId: req.auth.tenantId,
      planId: plan._id,
      status: { $in: ENROLMENT_CAPACITY_STATUSES },
    });
    if (enrolled >= availability.maxEnrolments) throw errors.business("PLAN_ENROLMENT_LIMIT_REACHED", "This plan has reached its enrolment limit.");
  }
  if (plan.flexibleRules?.extensionMode === "EXTEND_FLEXIBLE_PHASE") throw errors.business("UNSUPPORTED_PLAN_CONFIGURATION", "Flexible-phase extension is not supported and cannot be used in a plan.");
  if (customer.status !== "ACTIVE") throw errors.business("CUSTOMER_NOT_ACTIVE", "This customer is not active.");
  if (req.tenant.settings?.requireKycForEnrolment && customer.kyc?.status !== "VERIFIED") throw errors.business("KYC_REQUIRED", "Verified KYC is required before enrolment.");
  if (
    req.tenant.settings?.oneActiveSchemePerCustomer
    && await Scheme.exists({
      tenantId: req.auth.tenantId,
      customerId: customer._id,
      status: { $in: ONE_ACTIVE_SCHEME_CONFLICT_STATUSES },
    })
  ) {
    throw errors.business("ONE_SCHEME_POLICY", "This customer already has an active scheme.");
  }
  const branchId = resolveEnrolBranchId(req, customer);
  await assertActiveEnrolBranch(req.auth.tenantId, branchId);
  assertPlanAvailableAtBranch(plan, branchId);
  const amount = defaultInstallmentAmountPaise(plan, req.body.installmentAmountPaise);
  if (amount != null) validateAmount(plan, amount);
  const schedule = plan.scheduleRules ?? {};
  let firstInstallmentMode;
  if (schedule.firstInstallmentModeEditable === false) {
    firstInstallmentMode =
      schedule.firstInstallmentModeDefault ?? FirstInstallmentMode.COLLECT_NOW;
  } else if (req.auth?.type === "CUSTOMER") {
    if (req.body.payNow === false) {
      firstInstallmentMode = FirstInstallmentMode.START_NEXT_CYCLE;
    } else if (req.body.payNow === true) {
      firstInstallmentMode = FirstInstallmentMode.COLLECT_NOW;
    } else {
      firstInstallmentMode =
        schedule.firstInstallmentModeDefault ?? FirstInstallmentMode.COLLECT_NOW;
    }
  } else {
    firstInstallmentMode =
      req.body.firstInstallmentMode ??
      schedule.firstInstallmentModeDefault ??
      FirstInstallmentMode.COLLECT_NOW;
  }
  return { customer, plan, branchId, installmentAmountPaise: amount, firstInstallmentMode, firstInstallmentRequired: firstInstallmentMode === FirstInstallmentMode.COLLECT_NOW };
}

export async function validateEnrolmentResponse(req) {
  try {
    const result = await validateEnrolment(req);
    const { plan, installmentAmountPaise, firstInstallmentMode, firstInstallmentRequired } = result;
    if (installmentAmountPaise == null) {
      return {
        canEnrol: true,
        valid: false,
        blockers: [],
        warnings: [{
          code: "INSTALLMENT_AMOUNT_REQUIRED",
          message: "Choose an installment amount for this plan.",
          resolvable: true,
        }],
        installmentAmountPaise: null,
        firstInstallmentRequired,
        preview: null,
      };
    }
    const startDate = req.body.startDate ?? today();
    const installmentCount = plan.installmentCount ?? plan.durationMonths;
    if (plan.paymentPattern === PaymentPattern.FLEXIBLE) {
      return {
        canEnrol: true,
        valid: true,
        blockers: [],
        warnings: [],
        installmentAmountPaise,
        firstInstallmentRequired,
        preview: buildFlexibleEnrolPreview(
          plan,
          installmentAmountPaise,
          startDate,
          firstInstallmentMode,
        ),
      };
    }
    const scheduleRows = buildSchedulePreview({
      startDate,
      installmentAmountPaise,
      durationMonths: plan.durationMonths,
      installmentCount,
      scheduleRules: plan.scheduleRules ?? {},
      firstInstallmentMode,
    });
    const maturityDate =
      resolveFixedSchemeMaturityDate({
        startDate,
        durationMonths: plan.durationMonths,
        firstInstallmentMode,
      })
      ?? addMonthsClamped(startDate, plan.durationMonths).format("YYYY-MM-DD");
    const benefit = plan.benefit ?? {};
    return {
      canEnrol: true,
      valid: true,
      blockers: [],
      warnings: [],
      installmentAmountPaise,
      firstInstallmentRequired,
      preview: {
        installmentAmount: moneyField(installmentAmountPaise),
        installmentCount,
        totalPayable: moneyField(installmentAmountPaise * installmentCount),
        firstDueDate: scheduleRows[0]?.dueDate ?? startDate,
        maturityDate,
        benefit: benefit.displayLabel || benefit.type
          ? { type: benefit.type, displayLabel: benefit.displayLabel ?? benefit.type }
          : undefined,
        schedulePreview: scheduleRows.slice(0, 12).map((row) => ({
          installmentNumber: row.number,
          dueDate: row.dueDate,
          amount: moneyField(row.amountPaise),
          note: row.number === 1 && firstInstallmentRequired ? "Collected at enrolment" : null,
        })),
      },
    };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return {
      canEnrol: false,
      valid: false,
      blockers: [{
        code: error.code,
        message: error.message,
        resolvable: true,
        actionPath: enrolBlockerActionPath(error.code, req.body.customerId),
      }],
      warnings: [],
      preview: null,
    };
  }
}
export async function enrol(req) {
  const validation = await validateEnrolment(req);
  if (validation.installmentAmountPaise == null) {
    throw errors.business("INVALID_INSTALLMENT_AMOUNT", "Choose an installment amount for this plan.");
  }
  return withTransientTransactionRetry(async (session) =>
    createEnrolmentInSession(req, validation, session),
  );
}

async function lockPlanForEnrolment(session, tenantId, planId) {
  const planRow = await SchemePlan.findOne({ _id: planId, tenantId }).session(session);
  if (!planRow) throw errors.notFound("Scheme plan");
  const locked = await SchemePlan.findOneAndUpdate(
    { _id: planId, tenantId, version: planRow.version },
    { $inc: { version: 1 } },
    { session, new: true },
  );
  if (!locked) {
    throw errors.business(
      "PLAN_VERSION_CONFLICT",
      "This plan was updated during enrolment. Refresh and try again.",
    );
  }
  return locked;
}

export async function createEnrolmentInSession(req, validation, session) {
    const oneActivePolicy = req.tenant.settings?.oneActiveSchemePerCustomer === true;
    if (oneActivePolicy) {
      await serializeCustomerEnrolment(
        session,
        req.auth.tenantId,
        validation.customer._id,
      );
      await assertOneActiveSchemePolicy(
        session,
        req.auth.tenantId,
        validation.customer._id,
      );
    }
    const lockedPlan = await lockPlanForEnrolment(
      session,
      req.auth.tenantId,
      validation.plan._id,
    );
    const plan = lockedPlan.toObject();
    const txValidation = await revalidateLockedPlanForEnrolment(req, session, {
      plan,
      customer: validation.customer,
      branchId: validation.branchId,
      installmentAmountPaise: validation.installmentAmountPaise,
      firstInstallmentMode: validation.firstInstallmentMode,
      validateAmount,
      assertPlanAvailableAtBranch,
      assertActiveEnrolBranch,
    });
    const number = await nextSequence(req.auth.tenantId, "scheme", session); const startDate = today(); const maturityDate = addMonthsClamped(startDate, txValidation.plan.durationMonths).format("YYYY-MM-DD");
    const isFlexible = txValidation.plan.paymentPattern === PaymentPattern.FLEXIBLE;
    const schedulePreviewArgs = {
      startDate,
      installmentAmountPaise: txValidation.installmentAmountPaise,
      durationMonths: txValidation.plan.durationMonths,
      installmentCount: txValidation.plan.installmentCount,
      scheduleRules: txValidation.plan.scheduleRules ?? {},
      firstInstallmentMode: txValidation.firstInstallmentMode,
    };
    const fixedInstallments = isFlexible ? [] : buildSchedulePreview(schedulePreviewArgs);
    let persistedMaturityDate = maturityDate;
    if (isFlexible) {
      persistedMaturityDate = maturityDateFromCalendarCycles(buildCalendarMonthCycles({
        startDate,
        cycleCount: txValidation.plan.durationMonths,
        firstInstallmentMode: txValidation.firstInstallmentMode,
      })) ?? maturityDate;
    } else if (fixedInstallments.length) {
      persistedMaturityDate =
        resolveFixedSchemeMaturityDate({
          startDate,
          durationMonths: txValidation.plan.durationMonths,
          firstInstallmentMode: txValidation.firstInstallmentMode,
        })
        ?? maturityDate;
    }
    const flexibleCycles = isFlexible
      ? buildFlexibleSchemeCycleRows({
        startDate,
        durationMonths: txValidation.plan.durationMonths,
        firstInstallmentMode: txValidation.firstInstallmentMode,
      })
      : [];
    const initialStatus = validation.firstInstallmentRequired
      ? SchemeStatus.PENDING_PAYMENT
      : SchemeStatus.ACTIVE;
    const scheme = (await Scheme.create([{
      _id: createId("scheme"),
      tenantId: req.auth.tenantId,
      branchId: txValidation.branchId,
      customerId: txValidation.customer._id,
      planId: txValidation.plan._id,
      enrollmentNumber: `ENR-${String(number).padStart(7, "0")}`,
      planSnapshot: txValidation.plan,
      valueBasis: txValidation.plan.valueBasis,
      paymentPattern: txValidation.plan.paymentPattern,
      status: initialStatus,
      startDate,
      maturityDate: persistedMaturityDate,
      installmentAmountPaise: txValidation.installmentAmountPaise,
      installments: fixedInstallments,
      cycles: flexibleCycles,
      flexiblePhase: isFlexible ? FlexiblePhase.FLEXIBLE : undefined,
      positionVersion: 0,
      createdBy: req.auth.id,
    }], { session }))[0];
    const auditEventId = await writeAudit({
      req,
      action: "SCHEME_ENROLLED",
      entityType: AuditEntityType.SCHEME,
      entityId: scheme._id,
      after: scheme.toObject(),
      session,
    });
    let activationPayment = null;
    if (
      req.body.firstInstallmentAction === "RECORD_MANUAL_PAYMENT"
      && validation.firstInstallmentRequired
      && req.body.payment
    ) {
      const { recordPayment } = await import("./payment.service.js");
      activationPayment = await recordPayment(
        {
          ...req,
          body: {
            ...req.body.payment,
            schemeId: scheme._id,
            amountPaise: req.body.payment.amountPaise ?? txValidation.installmentAmountPaise,
            expectedVersion: scheme.version,
          },
        },
        { session, skipActivation: false },
      );
    }
    const persistedScheme = activationPayment
      ? await Scheme.findById(scheme._id).session(session).lean()
      : scheme.toObject();
    return {
      ...persistedScheme,
      auditEventId,
      firstInstallmentRequired: validation.firstInstallmentRequired,
      activationPayment,
    };
}

/** Re-use pending self-enrol checkout when PhonePe initiation failed after the local transaction committed. */
async function tryResumeCustomerPendingEnrolCheckout(req) {
  if (req.auth?.type !== "CUSTOMER" || req.body.payNow === false || !req.body.planId) return null;
  const scheme = await Scheme.findOne({
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
    planId: req.body.planId,
    status: SchemeStatus.PENDING_PAYMENT,
  }).lean();
  if (!scheme) return null;
  if (
    req.body.installmentAmountPaise != null
    && req.body.installmentAmountPaise !== scheme.installmentAmountPaise
  ) {
    return null;
  }
  const planActive = await SchemePlan.exists({
    _id: req.body.planId,
    tenantId: req.auth.tenantId,
    status: SchemePlanStatus.ACTIVE,
  });
  if (!planActive) return null;

  if (scheme.paymentPattern !== PaymentPattern.FLEXIBLE) return null;

  const intent = await PaymentIntent.findOne({
    tenantId: req.auth.tenantId,
    schemeId: scheme._id,
    customerId: req.auth.id,
    status: PaymentIntentStatus.PENDING,
    reservationExpiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 }).lean();
  if (!intent?.paymentId) return null;
  const paymentPending = await Payment.exists({
    _id: intent.paymentId,
    tenantId: req.auth.tenantId,
    status: PaymentStatus.PENDING,
  });
  if (!paymentPending) return null;

  const { initiateProviderForReservedIntent } = await import("./payment.service.js");
  const checkout = await initiateProviderForReservedIntent(
    {
      auth: req.auth,
      tenant: req.tenant,
      body: { redirectUrl: req.body.redirectUrl },
    },
    { intent, paymentId: intent.paymentId, tenantId: req.auth.tenantId },
  );
  return { enrolled: scheme, checkout, checkoutKind: "FLEXIBLE_PAYMENT_INTENT" };
}

/** Customer self-enrol: scheme + local checkout reservation in one transaction; PhonePe only after commit. */
export async function customerEnrolWithCheckout(req) {
  const resumed = await tryResumeCustomerPendingEnrolCheckout(req);
  if (resumed) return resumed;

  const validation = await validateEnrolment(req);
  if (validation.installmentAmountPaise == null) {
    throw errors.business("INVALID_INSTALLMENT_AMOUNT", "Choose an installment amount for this plan.");
  }
  const needsCheckout =
    req.body.payNow !== false && validation.firstInstallmentRequired;
  let reservedIntent = null;
  let reservedLink = null;
  const enrolled = await withTransientTransactionRetry(async (session) => {
    const scheme = await createEnrolmentInSession(req, validation, session);
    if (!needsCheckout) return scheme;
    const schemeId = scheme._id ?? scheme.id;
    const targetCycle = req.query?.targetCycle ?? req.body?.targetCycle ?? monthKey();
    const payReq = {
      auth: req.auth,
      tenant: req.tenant,
      baseUrl: req.baseUrl,
      scope: { tenantId: req.auth.tenantId, customerId: req.auth.id },
      params: { schemeId },
      query: { ...(req.query ?? {}), targetCycle },
      body: {
        amountPaise: validation.installmentAmountPaise,
        redirectUrl: req.body.redirectUrl,
        schemeId,
        targetCycle,
        expectedPositionVersion: scheme.positionVersion ?? 0,
      },
    };
    const {
      reservePaymentIntentInSession,
      reservePaymentLinkInSession,
    } = await import("./payment.service.js");
    if (scheme.paymentPattern === PaymentPattern.FLEXIBLE) {
      reservedIntent = await reservePaymentIntentInSession(session, payReq);
    } else {
      reservedLink = await reservePaymentLinkInSession(session, payReq);
    }
    return scheme;
  });
  if (reservedIntent) {
    const { initiateProviderForReservedIntent } = await import("./payment.service.js");
    const checkout = await initiateProviderForReservedIntent(
      {
        auth: req.auth,
        tenant: req.tenant,
        body: { redirectUrl: req.body.redirectUrl },
      },
      reservedIntent,
    );
    return { enrolled, checkout, checkoutKind: "FLEXIBLE_PAYMENT_INTENT" };
  }
  if (reservedLink) {
    return { enrolled, checkout: reservedLink, checkoutKind: "FIXED_PAYMENT_LINK" };
  }
  return { enrolled, checkout: null, checkoutKind: null };
}

/** Branch staff/collection agents: scheme is accessible when the customer belongs to their branch (scheme.branchId may differ). */
export async function assertStaffCanAccessScheme(req, scheme, session) {
  if (req.auth.type === "CUSTOMER" || !req.scope?.branchId) return;
  const existsQuery = Customer.exists({
    _id: scheme.customerId,
    tenantId: req.auth.tenantId,
    branchId: req.scope.branchId,
  });
  if (session) existsQuery.session(session);
  if (!(await existsQuery)) throw errors.notFound("Scheme");
}

export async function getScheme(req) {
  const id = req.params.schemeId ?? req.params.id;
  let scheme;
  if (req.auth.type === "CUSTOMER") {
    scheme = await Scheme.findOne({ _id: id, tenantId: req.auth.tenantId, customerId: req.auth.id }).lean();
  } else {
    scheme = await Scheme.findOne({ _id: id, tenantId: req.auth.tenantId }).lean();
    if (scheme) await assertStaffCanAccessScheme(req, scheme);
  }
  if (!scheme) throw errors.notFound("Scheme");
  const [customer, ledger, payments] = await Promise.all([
    Customer.findOne({ _id: scheme.customerId, tenantId: scheme.tenantId }).select("_id name mobile branchId").lean(),
    LedgerEntry.find({ tenantId: scheme.tenantId, schemeId: scheme._id }).sort({ sequence: 1 }).lean(),
    Payment.find({ tenantId: scheme.tenantId, schemeId: scheme._id, status: "SUCCESS" }).sort({ paidAt: 1 }).lean(),
  ]);
  const effectiveBranchId = scheme.branchId ?? customer?.branchId;
  const branch = effectiveBranchId
    ? await Branch.findOne({ _id: effectiveBranchId, tenantId: scheme.tenantId }).select("_id name code").lean()
    : null;
  const passbook = scheme.paymentPattern === PaymentPattern.FIXED
    ? buildFixedPassbook(scheme, payments)
    : null;
  const presentation = await schemePresentationExtras(scheme);
  return {
    ...scheme,
    customer: customer ? { _id: customer._id, id: customer._id, name: customer.name, mobile: customer.mobile } : undefined,
    branch: branch ? { _id: branch._id, id: branch._id, name: branch.name, code: branch.code } : undefined,
    totals: ledgerTotals(ledger),
    passbook,
    payments,
    displayMode: scheme.paymentPattern === "FIXED" ? "FIXED" : scheme.flexiblePhase === "FLEXIBLE" ? "FLEXIBLE_FREE_WINDOW" : "FLEXIBLE_LOCK_WINDOW",
    uiStatus: presentation.uiStatus,
    actions: presentation.actions,
    pendingRedemption: presentation.pendingRedemption,
    completedRedemption: presentation.completedRedemption,
  };
}

export async function getPassbook(req) {
  const scheme = await getScheme(req);
  const displayMode = scheme.displayMode;
  if (scheme.passbook?.rows) {
    return {
      scheme: {
        id: scheme._id,
        schemeNumber: scheme.enrollmentNumber,
        displayMode,
      },
      rows: scheme.passbook.rows,
      totals: scheme.passbook.totals,
    };
  }
  const payments = await Payment.find({ tenantId: scheme.tenantId, schemeId: scheme._id, status: "SUCCESS" }).sort({ paidAt: 1 }).lean();
  return {
    scheme: { id: scheme._id, schemeNumber: scheme.enrollmentNumber, displayMode },
    rows: payments.map((pay, index) => ({
      entryNumber: index + 1,
      paidAt: pay.paidAt,
      amountPaid: moneyField(pay.amountPaise),
      mode: pay.mode,
      receiptNumber: pay.receiptNumber,
      goldAccrual: paymentGoldAccrualDto(pay),
      payment: {
        id: pay._id,
        receiptNumber: pay.receiptNumber,
        goldAccrual: paymentGoldAccrualDto(pay),
      },
    })),
    totals: { paid: moneyField(payments.reduce((s, p) => s + p.amountPaise, 0)), paymentCount: payments.length },
  };
}
const SCHEME_STATUS_LABELS = {
  ACTIVE: "Active",
  LOCKED: "Locked / capped",
  DEFAULTED: "Defaulted",
  MATURED: "Matured",
  REDEEMED: "Redeemed",
  CLOSED_PREMATURE: "Closed premature",
};

function schemeCommittedPaise(scheme) {
  const instAmt =
    scheme.installmentAmountPaise ?? scheme.installments?.[0]?.amountPaise ?? 0;
  const tenure =
    scheme.installments?.length ??
    scheme.planSnapshot?.installmentCount ??
    scheme.planSnapshot?.durationMonths ??
    0;
  return instAmt * (tenure || 1);
}

function sumCommittedPaise(schemes) {
  return schemes.reduce((sum, scheme) => sum + schemeCommittedPaise(scheme), 0);
}

export async function schemeAnalytics(req) {
  const scope = effectiveScope(req);
  const match = { ...scope };
  const periodRange = assertAnalyticsPeriod(req.query);
  const comparedTo = previousPeriod(periodRange.from, periodRange.to);
  const groupBy = inferTrendGroupBy(
    periodRange.from,
    periodRange.to,
    req.query.groupBy,
  );
  const periodCreatedFilter = dateMatch("createdAt", periodRange);
  const priorCreatedFilter = dateMatch("createdAt", comparedTo);

  const [
    total,
    activeOnly,
    locked,
    defaulted,
    matured,
    redeemed,
    closedPremature,
    byStatus,
    byPattern,
    byPlan,
    dailyEnrolments,
    newInPeriod,
    newInPriorPeriod,
    periodSchemes,
    scopeBlock,
  ] = await Promise.all([
    Scheme.countDocuments(match),
    Scheme.countDocuments({ ...match, status: SchemeStatus.ACTIVE }),
    Scheme.countDocuments({ ...match, status: SchemeStatus.LOCKED }),
    Scheme.countDocuments({ ...match, status: SchemeStatus.DEFAULTED }),
    Scheme.countDocuments({ ...match, status: SchemeStatus.MATURED }),
    Scheme.countDocuments({ ...match, status: SchemeStatus.REDEEMED }),
    Scheme.countDocuments({ ...match, status: SchemeStatus.CLOSED_PREMATURE }),
    Scheme.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Scheme.aggregate([
      { $match: match },
      { $group: { _id: "$paymentPattern", count: { $sum: 1 } } },
    ]),
    scope.branchId
      ? Promise.resolve([])
      : Scheme.aggregate([
          { $match: match },
          {
            $group: {
              _id: "$planId",
              count: { $sum: 1 },
              label: {
                $first: {
                  $ifNull: [
                    "$planSnapshot.displayName",
                    "$planSnapshot.name",
                  ],
                },
              },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 12 },
        ]),
    Scheme.aggregate([
      { $match: { ...match, ...periodCreatedFilter } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt",
              timezone: "Asia/Kolkata",
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Scheme.countDocuments({ ...match, ...periodCreatedFilter }),
    Scheme.countDocuments({ ...match, ...priorCreatedFilter }),
    Scheme.find({ ...match, ...periodCreatedFilter })
      .select("installmentAmountPaise installments planSnapshot")
      .lean(),
    buildAnalyticsScope(scope),
  ]);

  const [allSchemesForCommitted] = await Promise.all([
    Scheme.find(match)
      .select("installmentAmountPaise installments planSnapshot")
      .lean(),
  ]);

  const enrolmentBuckets = rollupDailyRegistrationCounts(
    dailyEnrolments,
    periodRange.from,
    periodRange.to,
    groupBy,
  );
  const newEnrolmentChange = percentChange(newInPeriod, newInPriorPeriod);
  const periodKey = String(req.query.period ?? "THIS_MONTH").toUpperCase();
  const periodLabel = formatPeriodLabel(periodRange.from, periodRange.to);
  const activeEnrolments = activeOnly + locked;
  const redeemedOrClosed = redeemed + closedPremature;
  const totalCommittedPaise = sumCommittedPaise(allSchemesForCommitted);
  const periodCommittedPaise = sumCommittedPaise(periodSchemes);
  const avgInstallmentPaise = newInPeriod
    ? Math.round(
        periodSchemes.reduce(
          (sum, scheme) =>
            sum +
            (scheme.installmentAmountPaise ??
              scheme.installments?.[0]?.amountPaise ??
              0),
          0,
        ) / newInPeriod,
      )
    : 0;

  const summary = [
    {
      key: "TOTAL_ENROLLMENTS",
      label: "Total enrollments",
      value: total,
      valueType: "count",
      note: "Current snapshot",
    },
    {
      key: "ACTIVE_ENROLLMENTS",
      label: "Active & capped enrollments",
      value: activeEnrolments,
      valueType: "count",
      note: "Current snapshot",
    },
    {
      key: "NEW_ENROLLMENTS",
      label: "New enrollments",
      value: newInPeriod,
      valueType: "count",
      ...(newEnrolmentChange ? { change: newEnrolmentChange } : {}),
    },
    {
      key: "DEFAULTED",
      label: "Defaulted",
      value: defaulted,
      valueType: "count",
      severity: defaulted > 0 ? "WARNING" : undefined,
      note: "Current snapshot",
    },
    {
      key: "MATURED",
      label: "Matured",
      value: matured,
      valueType: "count",
      note: "Current snapshot",
    },
    {
      key: "TOTAL_COMMITTED",
      label: "Total committed",
      value: moneyRef(totalCommittedPaise),
      valueType: "currency",
      note: "Current snapshot",
    },
  ];

  const charts = {
    schemeStatusDistribution: {
      chartType: "donut",
      title: "Enrollment status",
      yAxis: { type: "count", label: "Enrollments" },
      series: [{
        key: "STATUS",
        name: "Enrollments",
        data: byStatus.map((row) => ({
          x: SCHEME_STATUS_LABELS[row._id] ?? row._id ?? "Unknown",
          y: row.count,
          yDisplay: String(row.count),
          modeKey: row._id,
        })),
      }],
      summary: { total, centreLabel: `${total} enrollments` },
    },
    paymentPatternDistribution: {
      chartType: "donut",
      title: "Payment pattern",
      yAxis: { type: "count", label: "Enrollments" },
      series: [{
        key: "PATTERN",
        name: "Enrollments",
        data: byPattern.map((row) => ({
          x: row._id === PaymentPattern.FLEXIBLE ? "Flexible" : "Fixed",
          y: row.count,
          yDisplay: String(row.count),
          modeKey: row._id,
        })),
      }],
      summary: { total, centreLabel: `${total} enrollments` },
    },
    enrollmentTrend: {
      chartType: "line",
      title: "New enrollments",
      subtitle: "Enrollments created during the selected period",
      xAxis: {
        type: "category",
        label: "Date",
        format:
          groupBy === "YEAR"
            ? "YYYY"
            : groupBy === "MONTH"
              ? "MMM YYYY"
              : groupBy === "WEEK"
                ? "[Week of] D MMM"
                : "D MMM",
      },
      yAxis: { type: "count", label: "Enrollments", min: 0 },
      series: [{
        key: "NEW_ENROLLMENTS",
        name: "New enrollments",
        data: enrolmentBuckets.map((row) => ({
          x: row.key,
          xDisplay: formatTrendBucketLabel(row.key, groupBy),
          y: row.count,
          yDisplay: String(row.count),
        })),
      }],
      summary: {
        total: newInPeriod,
        ...(newEnrolmentChange?.percent != null
          ? {
              changePercent: newEnrolmentChange.percent,
              changeDirection: newEnrolmentChange.direction,
            }
          : {}),
      },
    },
  };

  if (!scope.branchId) {
    charts.enrollmentsByPlan = {
      chartType: "horizontalBar",
      title: "Enrollments by plan",
      yAxis: { type: "count", label: "Enrollments" },
      series: [{
        key: "PLAN",
        name: "Enrollments",
        data: byPlan.map((row) => ({
          x: row.label ?? row._id ?? "Unknown plan",
          y: row.count,
          yDisplay: String(row.count),
        })),
      }],
    };
  }

  return {
    scope: scopeBlock,
    period: {
      key: periodKey,
      from: periodRange.from,
      to: periodRange.to,
      label: periodLabel,
      comparedTo: {
        from: comparedTo.from,
        to: comparedTo.to,
        label: formatPeriodLabel(comparedTo.from, comparedTo.to),
      },
      groupBy,
    },
    total,
    active: activeEnrolments,
    locked,
    defaulted,
    matured,
    redeemed: redeemedOrClosed,
    newEnrollmentsInPeriod: newInPeriod,
    totals: {
      allEnrollments: total,
      activeEnrollments: activeEnrolments,
      activeAndLockedEnrollments: activeEnrolments,
      openEnrollments: activeEnrolments + defaulted,
      lockedEnrollments: locked,
      defaultedEnrollments: defaulted,
      maturedEnrollments: matured,
      redeemedOrClosedEnrollments: redeemedOrClosed,
      newEnrollmentsInPeriod: newInPeriod,
      periodCommittedPaise,
      totalCommittedPaise,
      averageInstallmentPaise: avgInstallmentPaise,
    },
    summary,
    charts,
    generatedAt: generatedAtIst(),
  };
}

export async function listSchemes(req) {
  const scope =
    req.auth.type === "CUSTOMER"
      ? { tenantId: req.auth.tenantId, customerId: req.auth.id }
      : effectiveScope(req);
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.group === "PAST") filters.status = { $in: [SchemeStatus.REDEEMED, SchemeStatus.CLOSED_PREMATURE] };
  else if (req.query.group === "OPEN") filters.status = { $in: OPEN_ENROLLMENT_STATUSES };
  else if (req.auth.type === "CUSTOMER" && !req.query.status) {
    filters.status = {
      $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED, SchemeStatus.DEFAULTED, SchemeStatus.MATURED],
    };
  }
  if (req.query.customerId) filters.customerId = req.query.customerId;
  if (req.query.planId) filters.planId = req.query.planId;
  if (req.query.paymentPattern) filters.paymentPattern = req.query.paymentPattern;
  Object.assign(filters, calendarDateMatch("maturityDate", req.query));
  Object.assign(filters, calendarDateMatch("startDate", { from: req.query.enrolledFrom, to: req.query.enrolledTo }));

  const pattern = searchRegex(req.query.q);
  if (pattern && req.auth.type !== "CUSTOMER") {
    const matchedCustomers = await Customer.find({
      tenantId: req.auth.tenantId,
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
      $or: [{ name: pattern }, { mobile: pattern }, { customerNumber: pattern }],
    }).select("_id").lean();
    filters.$or = [
      { enrollmentNumber: pattern },
      { customerId: { $in: matchedCustomers.map((row) => row._id) } },
    ];
  }

  const result = await paginate(Scheme, { scope, filters, cursor: req.query.cursor, limit: req.query.limit, sort: req.query.sort ?? "createdAt:desc" });
  if (req.auth.type !== "CUSTOMER") {
    const { schemePortfolioSummary } = await import("./admin-summary.service.js");
    result.meta = {
      ...result.meta,
      summary: await schemePortfolioSummary(req, filters),
    };
  }
  if (!result.data.length) return result;
  const customerIds = [...new Set(result.data.map((row) => row.customerId).filter(Boolean))];
  const customers = await Customer.find({ _id: { $in: customerIds } }).select("_id name mobile branchId").lean();
  const customerMap = new Map(customers.map((row) => [row._id, row]));
  const branchIds = [
    ...new Set(
      result.data.flatMap((scheme) => {
        const customer = customerMap.get(scheme.customerId);
        const id = scheme.branchId ?? customer?.branchId;
        return id ? [id] : [];
      }),
    ),
  ];
  const branches = branchIds.length
    ? await Branch.find({ _id: { $in: branchIds }, tenantId: req.auth.tenantId }).select("_id name code").lean()
    : [];
  const branchMap = new Map(branches.map((row) => [row._id, row]));
  result.data = result.data.map((scheme) => {
    const customer = customerMap.get(scheme.customerId);
    const effectiveBranchId = scheme.branchId ?? customer?.branchId;
    const branch = effectiveBranchId ? branchMap.get(effectiveBranchId) : null;
    const installments = scheme.installments ?? [];
    const paidInstallments = installments.filter((row) => ["PAID", "WAIVED"].includes(row.status)).length;
    const amountPaidPaise =
      scheme.paymentPattern === PaymentPattern.FIXED
        ? installments.reduce((sum, row) => sum + (row.paidPaise ?? 0), 0)
        : (scheme.cycles ?? []).reduce((sum, row) => sum + (row.paidPaise ?? 0), 0);
    const nextDueRow = installments.find((row) => ["DUE", "PARTIALLY_PAID", "OVERDUE", "PENDING"].includes(row.status));
    return {
      ...scheme,
      customer: customer ? { _id: customer._id, id: customer._id, name: customer.name, mobile: customer.mobile } : undefined,
      branch: branch ? { _id: branch._id, id: branch._id, name: branch.name, code: branch.code } : undefined,
      nextDue: nextDueRow
        ? {
            installmentNumber: nextDueRow.number,
            dueDate: nextDueRow.dueDate,
            amountPaise: nextDueRow.amountPaise,
            paidPaise: nextDueRow.paidPaise ?? 0,
            remainingPaise: Math.max(0, (nextDueRow.amountPaise ?? 0) - (nextDueRow.paidPaise ?? 0)),
            status: nextDueRow.status,
          }
        : null,
      plan: scheme.planSnapshot ? { _id: scheme.planId, id: scheme.planId, name: scheme.planSnapshot.name, durationMonths: scheme.planSnapshot.durationMonths, valueBasis: scheme.planSnapshot.valueBasis, paymentPattern: scheme.planSnapshot.paymentPattern } : undefined,
      progress: { installmentsPaid: paidInstallments, installmentsTotal: installments.length || scheme.planSnapshot?.installmentCount || scheme.planSnapshot?.durationMonths || 0, amountPaid: { amountPaise: amountPaidPaise } },
      totals: { amountPaidPaise, totalPaid: { amountPaise: amountPaidPaise } },
      displayMode: scheme.paymentPattern === "FIXED" ? "FIXED" : scheme.flexiblePhase === "FLEXIBLE" ? "FLEXIBLE_FREE_WINDOW" : "FLEXIBLE_LOCK_WINDOW",
    };
  });
  return result;
}
export function ledgerTotals(entries) { const credits = new Set(["INSTALLMENT_PAYMENT", "FREE_WINDOW_PAYMENT", "BENEFIT_CREDIT"]); const debits = new Set(["REVERSAL", "CLOSURE_PENALTY", "REDEMPTION_DEBIT"]); return entries.reduce((totals, entry) => { const direction = credits.has(entry.type) ? 1 : debits.has(entry.type) ? -1 : 0; return { amountPaidPaise: totals.amountPaidPaise + direction * entry.amountPaise, goldWeightMg: totals.goldWeightMg + direction * entry.weightMg }; }, { amountPaidPaise: 0, goldWeightMg: 0 }); }

/** Staff/agent scheme card: ledger totals + suggested collect amount (aligned with payable-range rules). */
export function schemeAgentCollectPreview(scheme) {
  const snap = scheme.planSnapshot ?? {};
  const planName = snap.displayName ?? snap.name ?? "Savings scheme";
  const totals = scheme.totals ?? {};
  const totalPaidPaise = Number(totals.amountPaidPaise ?? totals.totalPaid?.amountPaise ?? 0);
  const goldWeightMg = Number(totals.goldWeightMg ?? 0);
  const installments = scheme.installments ?? [];
  const paidInstallments = installments.filter((row) => ["PAID", "WAIVED"].includes(row.status)).length;

  let payablePaise = null;
  let payableMaxPaise = null;
  let payableLabel = "Active";
  let payable = false;

  if (["ACTIVE", "LOCKED", "DEFAULTED"].includes(scheme.status)) {
    if (scheme.paymentPattern === PaymentPattern.FIXED) {
      const due = installments.find((row) => row.status !== "PAID" && row.status !== "WAIVED");
      if (due) {
        const remaining = Math.max(0, Number(due.amountPaise ?? 0) - Number(due.paidPaise ?? 0));
        payablePaise = remaining;
        payableMaxPaise = remaining;
        payable = remaining > 0;
        payableLabel = due.status === "OVERDUE" ? "Overdue instalment" : "Instalment due";
      } else {
        payableLabel = "Fully paid";
      }
    } else if (scheme.flexiblePhase === FlexiblePhase.FLEXIBLE) {
      const rules = snap.flexibleRules?.flexiblePhase;
      if (rules) {
        payablePaise = Number(rules.minimumPaymentPaise ?? 0);
        payableMaxPaise = Number(rules.maximumPaymentPaise ?? payablePaise);
        payable = true;
        payableLabel = "Optional contribution";
      }
    } else {
      const currentCycle = monthKey();
      const cycle =
        (scheme.cycles ?? []).find((row) => row.cycle === currentCycle) ??
        (scheme.cycles ?? []).find((row) => Math.max(0, Number(row.capPaise ?? 0) - Number(row.paidPaise ?? 0)) > 0);
      if (cycle) {
        const remaining = Math.max(0, Number(cycle.capPaise ?? 0) - Number(cycle.paidPaise ?? 0));
        payablePaise = remaining;
        payableMaxPaise = remaining;
        payable = remaining > 0;
        payableLabel = remaining > 0 ? "Cycle due" : "Cycle complete";
      }
    }
  }

  const flex = scheme.flexiblePhase;
  return {
    _id: scheme._id,
    id: scheme._id,
    enrollmentNumber: scheme.enrollmentNumber,
    planName,
    status: scheme.status,
    paymentPattern: scheme.paymentPattern,
    valueBasis: scheme.valueBasis,
    phase: flex === FlexiblePhase.FLEXIBLE ? "FREE" : flex === FlexiblePhase.CAPPED ? "CAPPED" : undefined,
    maturityDate: scheme.maturityDate,
    installmentAmountPaise: scheme.installmentAmountPaise,
    totalPaidPaise,
    goldBalanceMg: goldWeightMg,
    nextAmountPaise: payablePaise ?? undefined,
    payableMaxPaise: payableMaxPaise ?? undefined,
    payableLabel,
    payable,
    progressLabel:
      scheme.paymentPattern === PaymentPattern.FIXED && installments.length
        ? `${paidInstallments}/${installments.length} instalments`
        : payableLabel,
  };
}
/** Attach ledger-backed totals for customer scheme cards (list/home). */
export async function attachLedgerTotals(tenantId, schemeRows) {
  if (!schemeRows?.length) return schemeRows ?? [];
  const schemeIds = schemeRows.map((row) => row._id);
  const entries = await LedgerEntry.find({ tenantId, schemeId: { $in: schemeIds } })
    .sort({ sequence: 1 })
    .lean();
  const bySchemeId = new Map();
  for (const entry of entries) {
    const bucket = bySchemeId.get(entry.schemeId) ?? [];
    bucket.push(entry);
    bySchemeId.set(entry.schemeId, bucket);
  }
  return schemeRows.map((scheme) => {
    const ledger = ledgerTotals(bySchemeId.get(scheme._id) ?? []);
    return {
      ...scheme,
      totals: {
        ...(scheme.totals ?? {}),
        amountPaidPaise: ledger.amountPaidPaise,
        goldWeightMg: ledger.goldWeightMg,
        totalPaid: { amountPaise: ledger.amountPaidPaise },
      },
    };
  });
}
export function rebuildSchemeProjection(scheme, entries) { const businessEntries = entries.filter((entry) => ["INSTALLMENT_PAYMENT", "FREE_WINDOW_PAYMENT", "REVERSAL"].includes(entry.type)); if (scheme.paymentPattern === PaymentPattern.FIXED) { let remaining = businessEntries.reduce((sum, entry) => sum + (entry.type === "REVERSAL" ? -entry.amountPaise : entry.amountPaise), 0); const current = today(); for (const row of scheme.installments) { row.paidPaise = Math.max(0, Math.min(row.amountPaise, remaining)); remaining = Math.max(0, remaining - row.paidPaise); row.status = row.paidPaise >= row.amountPaise ? "PAID" : row.graceEndsAt < current ? "OVERDUE" : row.paidPaise > 0 ? "PARTIALLY_PAID" : row.dueDate <= current ? "DUE" : "PENDING"; } } else { const amounts = new Map(); for (const entry of businessEntries) if (entry.cycle) amounts.set(entry.cycle, (amounts.get(entry.cycle) ?? 0) + (entry.type === "REVERSAL" ? -entry.amountPaise : entry.amountPaise)); for (const row of scheme.cycles) { row.paidPaise = Math.max(0, amounts.get(row.cycle) ?? 0); const closed = row.status === "EXPIRED" || row.expiresAt < today(); row.remainingPaise = closed ? 0 : Math.max(0, row.capPaise - row.paidPaise); row.status = closed ? "EXPIRED" : row.capPaise > 0 && row.paidPaise >= row.capPaise ? "PAID" : row.paidPaise > 0 ? "PARTIALLY_PAID" : "UPCOMING"; } scheme.positionVersion += 1; } return scheme; }
export async function recomputeScheme(req) { return withTransaction(async (session) => { const scheme = await Scheme.findOne({ _id: req.params.schemeId, ...req.scope }).session(session); if (!scheme) throw errors.notFound("Scheme"); const entries = await LedgerEntry.find({ tenantId: scheme.tenantId, schemeId: scheme._id }).sort({ sequence: 1 }).session(session).lean(); rebuildSchemeProjection(scheme, entries); scheme.version += 1; await scheme.save({ session }); const auditEventId = await writeAudit({ req, action: "SCHEME_PROJECTION_RECOMPUTED", entityType: AuditEntityType.SCHEME, entityId: scheme._id, after: scheme.toObject(), session }); return { ...scheme.toObject(), auditEventId }; }); }
export async function getLedger(req) {
  const scheme = await getScheme(req);
  const result = await paginate(LedgerEntry, {
    scope: { tenantId: scheme.tenantId, schemeId: scheme._id },
    filters: {},
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: "sequence:asc",
  });
  if (!result.data.length) return result;
  const paymentIds = [...new Set(result.data.map((row) => row.paymentId).filter(Boolean))];
  const payments = paymentIds.length
    ? await Payment.find({ _id: { $in: paymentIds }, tenantId: scheme.tenantId }).lean()
    : [];
  const paymentMap = new Map(payments.map((row) => [String(row._id), row]));
  result.data = result.data.map((entry) =>
    mapAdminLedgerEntry(entry, paymentMap.get(String(entry.paymentId))),
  );
  return result;
}
export async function payableRange(req, schemeInput) {
  const scheme = schemeInput ?? await getScheme(req);
  const payableStatuses = [
    SchemeStatus.PENDING_PAYMENT,
    SchemeStatus.ACTIVE,
    SchemeStatus.LOCKED,
    SchemeStatus.DEFAULTED,
  ];
  if (!payableStatuses.includes(scheme.status)) {
    throw new AppError("SCHEME_NOT_ACTIVE", "This scheme is not active.", 409);
  }
  const plan = scheme.planSnapshot;
  const targetCycle = req.query?.targetCycle ?? req.body?.targetCycle;
  if (scheme.paymentPattern === PaymentPattern.FIXED) {
    const quote = computeFixedPaymentQuote(scheme, plan.paymentRules ?? {});
    return {
      model: "FIXED",
      installmentNumber: quote.installmentNumber,
      minPayablePaise: quote.minPayablePaise,
      maxPayablePaise: quote.maxPayablePaise,
      allowedAmountsPaise: quote.allowedAmountsPaise ?? undefined,
      maxPaymentPerTransactionPaise: plan.paymentRules?.maxPaymentPerTransactionPaise ?? null,
      suggestedPaise: quote.suggestedPaise ?? quote.minPayablePaise,
      expectedVersion: scheme.version,
      payable: quote.payable,
    };
  }
  if (scheme.flexiblePhase === FlexiblePhase.FLEXIBLE) {
    const flexRules = plan.flexibleRules;
    const rules = flexRules?.flexiblePhase;
    if (!rules) throw errors.business("UNSUPPORTED_PLAN_CONFIGURATION", "This plan is missing flexible payment rules.");
    const authoritativeCycle = resolveAuthoritativeFreePhaseTargetCycle({
      cycles: scheme.cycles,
      freeCycleCount: flexRules.flexiblePhaseCycles,
      suppliedCycle: targetCycle,
    });
    return {
      model: "FLEXIBLE",
      phase: "FLEXIBLE",
      contributionIsOptional: true,
      targetCycle: authoritativeCycle,
      minPayablePaise: rules.minimumPaymentPaise,
      maxPayablePaise: rules.maximumPaymentPaise,
      paymentIncrementPaise: rules.paymentIncrementPaise ?? 1,
      unusedAllowanceCarriesForward: false,
      positionVersion: scheme.positionVersion ?? 0,
      payable: true,
    };
  }
  if (!targetCycle) throw errors.validation([{ field: "targetCycle", message: "targetCycle is required in the capped phase" }]);
  const cycle = scheme.cycles.find((row) => row.cycle === targetCycle); if (!cycle) throw errors.notFound("Payment cycle");
  const rules = plan.flexibleRules.cappedPhase; const currentCycle = monthKey();
  const monthDistanceBetween = (from, to) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
  const monthDistance = monthDistanceBetween(currentCycle, targetCycle);
  if (monthDistance < 0) throw errors.business("CYCLE_CLOSED", "Unused capacity from a closed cycle cannot be paid later.");
  if (monthDistance > 0) {
    if (!rules.allowFutureCyclePayment) throw errors.business("FUTURE_CYCLE_PAYMENT_NOT_ALLOWED", "Future-cycle payments are not enabled for this plan.");
    const current = scheme.cycles.find((row) => row.cycle === currentCycle);
    if ((current?.remainingPaise ?? 0) > 0) throw errors.business("CURRENT_CYCLE_INCOMPLETE", "The current cycle must be fully paid before advancing to a future cycle.");
    for (const row of scheme.cycles) {
      const distance = monthDistanceBetween(currentCycle, row.cycle);
      if (distance > 0 && distance < monthDistance && (row.remainingPaise ?? 0) > 0) throw errors.business("CYCLE_SEQUENCE_VIOLATION", "Future cycles must be paid in sequence without skipping incomplete cycles.");
    }
    if (monthDistance > rules.maxAdvanceCycles) throw errors.business("ADVANCE_CYCLE_LIMIT_EXCEEDED", "The selected future cycle is outside the allowed advance window.");
  }
  const remaining = cycle.capPaise - cycle.paidPaise;
  const finalRemainder = remaining > 0 && remaining < rules.minimumPaymentPaise && rules.allowFinalRemainderBelowMinimum;
  const remainingPaise = Math.max(0, remaining);
  let nextCycleAction = null;
  if (remainingPaise <= 0) nextCycleAction = "WAIT_NEXT_CYCLE";
  else if (monthDistance > 0) nextCycleAction = "PAY_FUTURE_CYCLE";
  else if (monthDistance === 0) nextCycleAction = "PAY_CURRENT_CYCLE";
  return {
    model: "FLEXIBLE",
    phase: "CAPPED",
    contributionIsOptional: true,
    targetCycle,
    minPayablePaise: finalRemainder ? remaining : rules.minimumPaymentPaise,
    maxPayablePaise: remainingPaise,
    suggestedPaise: remainingPaise,
    paymentIncrementPaise: rules.paymentIncrementPaise ?? 1,
    allowFinalRemainderBelowMinimum: rules.allowFinalRemainderBelowMinimum,
    unusedAllowanceCarriesForward: false,
    positionVersion: scheme.positionVersion ?? 0,
    payable: remainingPaise > 0,
    capPaise: cycle.capPaise,
    paidPaise: cycle.paidPaise,
    remainingPaise,
    maxReason: remainingPaise <= 0 ? "CYCLE_CAP_REACHED" : null,
    nextCycleAction,
  };
}
const FLEXIBLE_LOCK_ELIGIBLE_STATUSES = new Set([
  SchemeStatus.ACTIVE,
  SchemeStatus.LOCKED,
  SchemeStatus.DEFAULTED,
]);

export async function applyFlexibleLock(req, internal = {}) {
  return withTransaction(async (session) => {
    const scheme = await Scheme.findOne({ _id: req.params.schemeId, ...req.scope }).session(session);
    if (!scheme) throw errors.notFound("Scheme");
    if (!FLEXIBLE_LOCK_ELIGIBLE_STATUSES.has(scheme.status)) {
      throw errors.business(
        "FLEXIBLE_LOCK_NOT_APPLICABLE",
        "Flexible lock cannot be applied to this scheme in its current state.",
      );
    }
    if (scheme.flexiblePhase !== FlexiblePhase.FLEXIBLE) {
      throw new AppError("LOCK_ALREADY_APPLIED", "The flexible lock has already been applied.", 409);
    }
    const freeCycles = scheme.planSnapshot?.flexibleRules?.flexiblePhaseCycles ?? 0;
    const lockReferenceDate = internal.referenceDate ?? today();
    if (
      !isFlexibleLockDueAfterFreePhase(
        lockReferenceDate,
        scheme.cycles ?? [],
        freeCycles,
      )
    ) {
      throw new AppError(
        "FLEXIBLE_LOCK_NOT_DUE",
        "The flexible free phase has not ended yet.",
        422,
      );
    }
    const entries = await LedgerEntry.find({
      tenantId: scheme.tenantId,
      schemeId: scheme._id,
      type: { $in: ["FREE_WINDOW_PAYMENT", "REVERSAL"] },
    })
      .session(session)
      .lean();
    const rules = scheme.planSnapshot.flexibleRules;
    const flexPhase = rules.flexiblePhase ?? {};
    const minTotalPaise = Number(flexPhase.minTotalPaise ?? 0);
    const netSummary = analyzeFreeWindowLedgerForCap(entries);
    if (netSummary.anomalies.length) {
      throw errors.business(
        "FLEXIBLE_FREE_WINDOW_NET_NEGATIVE",
        "A free-window payment reversal exceeds the original payment amount.",
      );
    }
    const total = netSummary.netFreeTotalPaise;
    const freePhaseBoundary = scheme.cycles?.[freeCycles - 1]?.expiresAt ?? null;
    if (total === 0 && rules.capComputation.onZeroFlexiblePhaseTotal === "CLOSE_SCHEME") {
      return applySystemFlexLockClosure({
        session,
        req,
        scheme,
        closeReason: "ZERO_FLEXIBLE_PHASE_TOTAL",
        netFreeTotalPaise: total,
        minTotalPaise,
      });
    }
    if (total > 0 && total < minTotalPaise && rules.capComputation.onBelowMinimumTotal === "CLOSE_SCHEME") {
      return applySystemFlexLockClosure({
        session,
        req,
        scheme,
        closeReason: "BELOW_MINIMUM_FLEXIBLE_PHASE_TOTAL",
        netFreeTotalPaise: total,
        minTotalPaise,
      });
    }
    const lockTimestamp = new Date();
    const { capPaise: cap, audit: capAudit } = computeFlexibleLockCapDetails({
      netSummary,
      flexibleRules: rules,
      freePhaseBoundary,
      lockedAt: lockTimestamp,
    });
    scheme.lockedAveragePaise = cap;
    scheme.flexiblePhase = FlexiblePhase.CAPPED;
    scheme.status = SchemeStatus.LOCKED;
    scheme.lockedAt = lockTimestamp;
    scheme.positionVersion += 1;
    scheme.version += 1;
    scheme.cycles.slice(rules.flexiblePhaseCycles).forEach((cycle) => {
      cycle.capPaise = cap;
      cycle.remainingPaise = cap;
    });
    await scheme.save({ session });
    const auditEventId = await writeAudit({
      req,
      action: "FLEXIBLE_LOCK_APPLIED",
      entityType: AuditEntityType.SCHEME,
      entityId: scheme._id,
      after: { ...scheme.toObject(), flexibleLockComputation: capAudit },
      session,
    });
    return { ...scheme.toObject(), auditEventId, flexibleLockComputation: capAudit };
  });
}
