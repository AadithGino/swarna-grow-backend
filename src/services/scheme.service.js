import {
  AuditEntityType,
  FirstInstallmentMode,
  FlexiblePhase,
  PaymentPattern,
  RedemptionStatus,
  SchemePlanStatus,
  SchemeStatus,
} from "../constants/enums.js";
import {
  Branch,
  Customer,
  LedgerEntry,
  Payment,
  Redemption,
  Scheme,
  SchemePlan,
} from "../models/index.js";
import { errors, AppError } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import { withTransaction } from "../lib/transaction.js";
import { calendarDateMatch, effectiveScope, searchRegex } from "../lib/query-filters.js";
import { buildFlexibleEnrolPreview } from "./plan.service.js";
import { buildSchedulePreview } from "./schedule.service.js";
import { writeAudit } from "./audit.service.js";
import { today, addMonthsClamped, monthKey } from "../lib/date.js";
import { nextSequence } from "./sequence.service.js";

function validateAmount(plan, amount) {
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
  return req.body.branchId ?? req.scope?.branchId ?? customer?.branchId ?? null;
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
    req.body.customerId = req.auth.id;
    delete req.body.branchId;
    delete req.body.firstInstallmentMode;
    if (req.body.firstInstallmentAction || req.body.payment) {
      throw errors.business("MANUAL_PAYMENT_NOT_ALLOWED", "Customers cannot record manual payments during enrolment.");
    }
  }
  const [customer, plan] = await Promise.all([Customer.findOne({ _id: req.body.customerId, ...req.scope }).lean(), SchemePlan.findOne({ _id: req.body.planId, tenantId: req.auth.tenantId }).lean()]);
  if (!customer) throw errors.notFound("Customer"); if (!plan) throw errors.notFound("Scheme plan");
  if (plan.status !== SchemePlanStatus.ACTIVE) throw errors.business("PLAN_ENROLMENT_CLOSED", "This plan is not accepting enrolments.");
  if (plan.flexibleRules?.extensionMode === "EXTEND_FLEXIBLE_PHASE") throw errors.business("UNSUPPORTED_PLAN_CONFIGURATION", "Flexible-phase extension is not supported and cannot be used in a plan.");
  if (customer.status !== "ACTIVE") throw errors.business("CUSTOMER_NOT_ACTIVE", "This customer is not active.");
  if (req.tenant.settings?.requireKycForEnrolment && customer.kyc?.status !== "VERIFIED") throw errors.business("KYC_REQUIRED", "Verified KYC is required before enrolment.");
  if (req.tenant.settings?.oneActiveSchemePerCustomer && await Scheme.exists({ tenantId: req.auth.tenantId, customerId: customer._id, status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] } })) throw errors.business("ONE_SCHEME_POLICY", "This customer already has an active scheme.");
  assertPlanAvailableAtBranch(plan, resolveEnrolBranchId(req, customer));
  const amount = defaultInstallmentAmountPaise(plan, req.body.installmentAmountPaise);
  if (amount == null) throw errors.business("INVALID_INSTALLMENT_AMOUNT", "Choose an installment amount for this plan.");
  validateAmount(plan, amount);
  const schedule = plan.scheduleRules ?? {};
  const firstInstallmentMode = schedule.firstInstallmentModeEditable === false
    ? (schedule.firstInstallmentModeDefault ?? FirstInstallmentMode.COLLECT_NOW)
    : (req.body.firstInstallmentMode ?? schedule.firstInstallmentModeDefault ?? FirstInstallmentMode.COLLECT_NOW);
  return { customer, plan, installmentAmountPaise: amount, firstInstallmentMode, firstInstallmentRequired: firstInstallmentMode === FirstInstallmentMode.COLLECT_NOW };
}

export async function validateEnrolmentResponse(req) {
  try {
    const result = await validateEnrolment(req);
    const { plan, installmentAmountPaise, firstInstallmentMode, firstInstallmentRequired } = result;
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
    const maturityDate = scheduleRows.length
      ? scheduleRows[scheduleRows.length - 1].dueDate
      : addMonthsClamped(startDate, plan.durationMonths).format("YYYY-MM-DD");
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
  return withTransaction(async (session) => {
    const number = await nextSequence(req.auth.tenantId, "scheme", session); const startDate = today(); const maturityDate = addMonthsClamped(startDate, validation.plan.durationMonths).format("YYYY-MM-DD");
    const isFlexible = validation.plan.paymentPattern === PaymentPattern.FLEXIBLE;
    const schedulePreviewArgs = {
      startDate,
      installmentAmountPaise: validation.installmentAmountPaise,
      durationMonths: validation.plan.durationMonths,
      installmentCount: validation.plan.installmentCount,
      scheduleRules: validation.plan.scheduleRules ?? {},
      firstInstallmentMode: validation.firstInstallmentMode,
    };
    const fixedInstallments = isFlexible ? [] : buildSchedulePreview(schedulePreviewArgs);
    const maturityFromSchedule = fixedInstallments.length ? fixedInstallments[fixedInstallments.length - 1].dueDate : maturityDate;
    const scheme = (await Scheme.create([{ _id: createId("scheme"), tenantId: req.auth.tenantId, branchId: req.scope.branchId ?? validation.customer.branchId, customerId: validation.customer._id, planId: validation.plan._id, enrollmentNumber: `ENR-${String(number).padStart(7, "0")}`, planSnapshot: validation.plan, valueBasis: validation.plan.valueBasis, paymentPattern: validation.plan.paymentPattern, startDate, maturityDate: maturityFromSchedule, installmentAmountPaise: validation.installmentAmountPaise, installments: fixedInstallments, cycles: isFlexible ? buildSchedulePreview({ startDate, durationMonths: validation.plan.durationMonths, installmentCount: validation.plan.durationMonths }).map((row) => ({ cycle: row.dueDate.slice(0, 7), capPaise: 0, paidPaise: 0, remainingPaise: 0, status: "UPCOMING", expiresAt: row.graceEndsAt })) : [], flexiblePhase: isFlexible ? FlexiblePhase.FLEXIBLE : undefined, positionVersion: 0, createdBy: req.auth.id }], { session }))[0];
    const auditEventId = await writeAudit({ req, action: "SCHEME_ENROLLED", entityType: AuditEntityType.SCHEME, entityId: scheme._id, after: scheme.toObject(), session }); return { ...scheme.toObject(), auditEventId, firstInstallmentRequired: validation.firstInstallmentRequired };
  });
}
export async function getScheme(req) {
  const id = req.params.schemeId ?? req.params.id;
  const scope = req.auth.type === "CUSTOMER" ? { tenantId: req.auth.tenantId, customerId: req.auth.id } : req.scope;
  const scheme = await Scheme.findOne({ _id: id, ...scope }).lean();
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
      payment: { id: pay._id, receiptNumber: pay.receiptNumber },
    })),
    totals: { paid: moneyField(payments.reduce((s, p) => s + p.amountPaise, 0)), paymentCount: payments.length },
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
export async function getLedger(req) { const scheme = await getScheme(req); return paginate(LedgerEntry, { scope: { tenantId: scheme.tenantId, schemeId: scheme._id }, filters: {}, cursor: req.query.cursor, limit: req.query.limit, sort: "sequence:asc" }); }
export async function payableRange(req, schemeInput) {
  const scheme = schemeInput ?? await getScheme(req); if (![SchemeStatus.ACTIVE, SchemeStatus.LOCKED, SchemeStatus.DEFAULTED].includes(scheme.status)) throw new AppError("SCHEME_NOT_ACTIVE", "This scheme is not active.", 409);
  const plan = scheme.planSnapshot; const targetCycle = req.query.targetCycle ?? req.body?.targetCycle;
  if (scheme.paymentPattern === PaymentPattern.FIXED) {
    const due = scheme.installments.find((row) => row.status !== "PAID" && row.status !== "WAIVED"); if (!due) return { minPayablePaise: 0, maxPayablePaise: 0, payable: false };
    const remaining = due.amountPaise - due.paidPaise; const advance = plan.paymentRules?.advancePaymentAllowed ? Math.max(1, plan.paymentRules.maxAdvanceInstallments ?? 1) : 1;
    return { model: "FIXED", installmentNumber: due.number, minPayablePaise: plan.paymentRules?.partialPaymentAllowed ? Math.min(plan.paymentRules.minPaymentPaise || remaining, remaining) : remaining, maxPayablePaise: remaining + scheme.installments.filter((row) => row.number > due.number && row.status === "PENDING").slice(0, advance - 1).reduce((sum, row) => sum + row.amountPaise, 0), expectedVersion: scheme.version, payable: true };
  }
  if (scheme.flexiblePhase === FlexiblePhase.FLEXIBLE) { const rules = plan.flexibleRules.flexiblePhase; return { model: "FLEXIBLE", phase: "FLEXIBLE", contributionIsOptional: true, targetCycle: targetCycle ?? monthKey(), minPayablePaise: rules.minimumPaymentPaise, maxPayablePaise: rules.maximumPaymentPaise, paymentIncrementPaise: 1, unusedAllowanceCarriesForward: false, positionVersion: scheme.positionVersion ?? 0, payable: true }; }
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
export async function applyFlexibleLock(req) { return withTransaction(async (session) => { const scheme = await Scheme.findOne({ _id: req.params.schemeId, ...req.scope }).session(session); if (!scheme) throw errors.notFound("Scheme"); if (scheme.flexiblePhase !== FlexiblePhase.FLEXIBLE) throw new AppError("LOCK_ALREADY_APPLIED", "The flexible lock has already been applied.", 409); const entries = await LedgerEntry.find({ tenantId: scheme.tenantId, schemeId: scheme._id, type: "FREE_WINDOW_PAYMENT" }).session(session).lean(); const rules = scheme.planSnapshot.flexibleRules; const total = entries.reduce((sum, row) => sum + row.amountPaise, 0); if (total === 0 && rules.capComputation.onZeroFlexiblePhaseTotal === "CLOSE_SCHEME") { scheme.status = SchemeStatus.CLOSED_PREMATURE; scheme.version += 1; await scheme.save({ session }); return { ...scheme.toObject(), closeReason: "ZERO_FLEXIBLE_PHASE_TOTAL" }; } const nearest = rules.capComputation.roundToNearestPaise; let cap = Math.ceil((total / rules.averagingDivisor) / nearest) * nearest; if (total < rules.flexiblePhase.minTotalPaise && rules.capComputation.onBelowMinimumTotal === "USE_MINIMUM") cap = rules.capComputation.minCycleCapPaise; cap = Math.min(rules.capComputation.maxCycleCapPaise, Math.max(rules.capComputation.minCycleCapPaise, cap)); scheme.lockedAveragePaise = cap; scheme.flexiblePhase = FlexiblePhase.CAPPED; scheme.status = SchemeStatus.LOCKED; scheme.lockedAt = new Date(); scheme.positionVersion += 1; scheme.version += 1; scheme.cycles.slice(rules.flexiblePhaseCycles).forEach((cycle) => { cycle.capPaise = cap; cycle.remainingPaise = cap; }); await scheme.save({ session }); const auditEventId = await writeAudit({ req, action: "FLEXIBLE_LOCK_APPLIED", entityType: AuditEntityType.SCHEME, entityId: scheme._id, after: scheme.toObject(), session }); return { ...scheme.toObject(), auditEventId }; }); }
