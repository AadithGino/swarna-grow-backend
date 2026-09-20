import { AuditEntityType, PaymentPattern, PaymentStatus, SchemePlanStatus } from "../constants/enums.js";
import { Payment, Scheme, SchemePlan, Tenant } from "../models/index.js";
import { assertFeatureEntitled, assertWithinLimit } from "../lib/tenant-limits.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { writeAudit } from "./audit.service.js";
import { paginate } from "../lib/pagination.js";
import { effectiveScope, searchRegex } from "../lib/query-filters.js";
import { addMonthsClamped, today } from "../lib/date.js";
import { iteratePeriodBuckets } from "../lib/analytics-period.js";
import { moneyRef, weightRef } from "../lib/money.js";
import { computeFlexibleCycleCapPaise } from "../lib/flexible-cap.js";
import { buildAmountSummary } from "../lib/plan-amount-summary.js";
import { normalizePlanFinancialRules } from "../lib/plan-amount-normalize.js";
import { mergePlanPatch, validateCompletePlan } from "../lib/plan-merge.js";
import {
  buildCalendarMonthCycles,
  maturityDateFromCalendarCycles,
} from "../lib/calendar-cycle.js";
import { buildSchedulePreview, resolveFixedSchemeMaturityDate } from "./schedule.service.js";

const ACTIVE_SCHEME_STATUSES = ["ACTIVE", "LOCKED", "DEFAULTED"];

function schemeListScope(req) {
  return effectiveScope(req);
}

function projectedInstallmentPaiseExpr() {
  return {
    $ifNull: [
      "$installmentAmountPaise",
      { $ifNull: ["$lockedAveragePaise", 0] },
    ],
  };
}

async function planListAggregates(req, planIds) {
  const schemeScope = {
    ...schemeListScope(req),
    status: { $in: ACTIVE_SCHEME_STATUSES },
  };
  const projectedSum = { $sum: projectedInstallmentPaiseExpr() };

  const aggregations = [
    Scheme.aggregate([
      { $match: schemeScope },
      {
        $group: {
          _id: null,
          activeEnrollments: { $sum: 1 },
          projectedMonthlyPaise: projectedSum,
        },
      },
    ]),
    SchemePlan.aggregate([
      { $match: { tenantId: req.auth.tenantId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ];
  if (planIds.length) {
    aggregations.push(
      Scheme.aggregate([
        { $match: { ...schemeScope, planId: { $in: planIds } } },
        {
          $group: {
            _id: "$planId",
            activeSchemes: { $sum: 1 },
            collectedThisMonth: projectedSum,
          },
        },
      ]),
    );
  }

  const [tenantRows, planStatusRows, enrollmentByPlanRows = []] =
    await Promise.all(aggregations);

  const byPlanId = new Map(
    enrollmentByPlanRows.map((row) => [
      row._id,
      {
        activeSchemes: row.activeSchemes,
        collectedThisMonth: row.collectedThisMonth,
      },
    ]),
  );

  const statusCounts = Object.fromEntries(
    planStatusRows.map((row) => [row._id, row.count]),
  );
  const tenantTotals = tenantRows[0] ?? {
    activeEnrollments: 0,
    projectedMonthlyPaise: 0,
  };

  return { byPlanId, statusCounts, tenantTotals };
}

async function findPlanRaw(req) {
  const plan = await SchemePlan.findOne({
    _id: req.params.planId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!plan) throw errors.notFound("Scheme plan");
  return plan;
}

async function planEnrolmentCounts(tenantId, planId) {
  const base = { tenantId, planId };
  const [active, locked, defaulted, matured, redeemed, closedPremature, total] =
    await Promise.all([
      Scheme.countDocuments({ ...base, status: "ACTIVE" }),
      Scheme.countDocuments({ ...base, status: "LOCKED" }),
      Scheme.countDocuments({ ...base, status: "DEFAULTED" }),
      Scheme.countDocuments({ ...base, status: "MATURED" }),
      Scheme.countDocuments({ ...base, status: "REDEEMED" }),
      Scheme.countDocuments({ ...base, status: "CLOSED_PREMATURE" }),
      Scheme.countDocuments(base),
    ]);
  const activeSchemes = active + locked + defaulted;
  return {
    active,
    locked,
    defaulted,
    activeSchemes,
    matured,
    redeemed,
    closedPremature,
    total,
  };
}

async function planProjectedMonthlyPaise(tenantId, planId) {
  const rows = await Scheme.aggregate([
    {
      $match: {
        tenantId,
        planId,
        status: { $in: ACTIVE_SCHEME_STATUSES },
      },
    },
    { $group: { _id: null, total: { $sum: projectedInstallmentPaiseExpr() } } },
  ]);
  return rows[0]?.total ?? 0;
}

async function planCollectedPaise(tenantId, planId) {
  const schemeIds = await Scheme.find({ tenantId, planId }).select("_id").lean();
  if (!schemeIds.length) return 0;
  const rows = await Payment.aggregate([
    {
      $match: {
        tenantId,
        schemeId: { $in: schemeIds.map((row) => row._id) },
        status: PaymentStatus.SUCCESS,
      },
    },
    { $group: { _id: null, total: { $sum: "$amountPaise" } } },
  ]);
  return rows[0]?.total ?? 0;
}

function defaultTermsText(plan) {
  if (String(plan.termsText ?? "").trim()) return plan.termsText;
  const name = plan.displayName ?? plan.name ?? "this plan";
  if (plan.paymentPattern === PaymentPattern.FLEXIBLE) {
    return `Terms for ${name}:\n1. Free-phase and capped-phase rules apply as shown at enrolment.\n2. Benefit and redemption follow the plan configuration in the app and store policy.\n3. Contact your branch for clarifications before enrolling.`;
  }
  return `Terms for ${name}:\n1. Pay instalments by the due dates shown in your passbook.\n2. Benefits apply only when eligibility rules are met.\n3. Contact your branch for clarifications before enrolling.`;
}

async function presentPlanDetail(tenantId, plan) {
  normalizePlanFinancialRules(plan);
  const counts = await planEnrolmentCounts(tenantId, plan._id);
  const projectedPaise = await planProjectedMonthlyPaise(tenantId, plan._id);
  return {
    ...plan,
    id: plan._id,
    termsText: defaultTermsText(plan),
    amountSummary: buildAmountSummary(plan),
    stats: {
      activeSchemes: counts.activeSchemes,
      totalEnrolments: counts.total,
      collectedThisMonth: moneyRef(projectedPaise),
    },
    editLocked: counts.activeSchemes > 0,
  };
}

function formatMonthBucket(ym) {
  const [year, month] = String(ym).split("-");
  if (!year || !month) return ym;
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
}

function countChartPoint(x, y) {
  return { x, y, yDisplay: String(y) };
}

async function buildPlanStatsPayload(tenantId, plan) {
  const counts = await planEnrolmentCounts(tenantId, plan._id);
  const [collectedPaise, trendRows] = await Promise.all([
    planCollectedPaise(tenantId, plan._id),
    Scheme.aggregate([
      { $match: { tenantId, planId: plan._id } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "Asia/Kolkata" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 12 },
    ]),
  ]);
  let benefitLiabilityPaise = 0;
  if (plan.benefit?.type === "ONE_FREE_INSTALLMENT") {
    benefitLiabilityPaise =
      counts.activeSchemes *
      (plan.amountRules?.fixedAmountPaise ??
        plan.amountRules?.minInstallmentPaise ??
        0);
  } else if (plan.benefit?.type === "FIXED_BONUS_AMOUNT") {
    if (plan.benefit.bonusBasis === "PERCENT_OF_PAID") {
      benefitLiabilityPaise = Math.floor(
        (collectedPaise * (plan.benefit.bonusValue ?? 0)) / 100,
      );
      if (plan.benefit.maxBonusPaise != null) {
        benefitLiabilityPaise = Math.min(
          benefitLiabilityPaise,
          plan.benefit.maxBonusPaise * Math.max(counts.activeSchemes, 1),
        );
      }
    } else {
      benefitLiabilityPaise =
        (plan.benefit.bonusValue ?? 0) * counts.activeSchemes;
    }
  }
  const trendEnd = today();
  const trendStart = addMonthsClamped(trendEnd, -11)
    .startOf("month")
    .format("YYYY-MM-DD");
  const monthMap = new Map(trendRows.map((row) => [row._id, row.count]));
  const trendData = [...iteratePeriodBuckets(trendStart, trendEnd, "MONTH")].map(
    (key) => countChartPoint(formatMonthBucket(key), monthMap.get(key) ?? 0),
  );
  const statusData = [
    { x: "Active", y: counts.activeSchemes },
    { x: "Matured", y: counts.matured },
    { x: "Redeemed", y: counts.redeemed },
    { x: "Closed early", y: counts.closedPremature },
    { x: "Defaulted", y: counts.defaulted },
  ]
    .filter((row) => row.y > 0)
    .map((row) => countChartPoint(row.x, row.y));
  return {
    enrolments: {
      total: counts.total,
      active: counts.activeSchemes,
      locked: counts.locked,
      matured: counts.matured,
      redeemed: counts.redeemed,
      closedPremature: counts.closedPremature,
      defaulted: counts.defaulted,
    },
    financials: {
      totalCollected: moneyRef(collectedPaise),
      outstandingExpected: moneyRef(0),
      goldLiability:
        plan.valueBasis === "GOLD_WEIGHT"
          ? weightRef(0)
          : weightRef(0),
      benefitLiability: moneyRef(benefitLiabilityPaise),
    },
    charts: {
      enrolmentTrend: {
        chartType: "line",
        title: "New enrolments by month",
        yAxis: { type: "count", label: "Enrolments" },
        series: [
          {
            key: "enrolments",
            name: "Enrolments",
            data: trendData,
          },
        ],
      },
      statusDistribution: {
        chartType: "donut",
        title: "Enrolment status",
        yAxis: { type: "count", label: "Schemes" },
        series: [
          {
            key: "status",
            name: "Schemes",
            data: statusData,
          },
        ],
      },
    },
  };
}

function computeIllustrativeFlexibleCap(installmentAmountPaise, flexRules) {
  const free = flexRules.flexiblePhaseCycles ?? 6;
  const illustrativeFreeTotalPaise = installmentAmountPaise * free;
  const illustrativePaymentCount = free;
  const capPaise = computeFlexibleCycleCapPaise({
    totalPaise: illustrativeFreeTotalPaise,
    freeWindowPaymentCount: illustrativePaymentCount,
    flexibleRules: flexRules,
  });
  return { illustrativeFreeTotalPaise, capPaise };
}

/** Enrolment preview for flexible-then-capped plans (not fixed × installment count). */
export function buildFlexibleEnrolPreview(
  plan,
  installmentAmountPaise,
  startDate,
  firstInstallmentMode,
) {
  const flex = plan.flexibleRules ?? {};
  const freeMonths = flex.flexiblePhaseCycles ?? 6;
  const cappedCycles = flex.cappedPhaseCycles ?? 5;
  const firstInstallmentRequired = firstInstallmentMode === "COLLECT_NOW";
  const { illustrativeFreeTotalPaise, capPaise } = computeIllustrativeFlexibleCap(
    installmentAmountPaise,
    flex,
  );
  const cappedTotalPaise = capPaise * cappedCycles;
  const calendarCycles = buildCalendarMonthCycles({
    startDate,
    cycleCount: plan.durationMonths,
    firstInstallmentMode,
  });
  const schedulePreview = [];
  for (let i = 0; i < freeMonths && i < calendarCycles.length; i += 1) {
    schedulePreview.push({
      installmentNumber: i + 1,
      dueDate: calendarCycles[i].expiresAt,
      amount: moneyRef(installmentAmountPaise),
      note:
        i === 0 && firstInstallmentRequired
          ? "Optional · may collect at enrolment"
          : "Free window (optional)",
    });
  }
  for (let i = 0; i < cappedCycles && freeMonths + i < calendarCycles.length; i += 1) {
    schedulePreview.push({
      installmentNumber: freeMonths + i + 1,
      dueDate: calendarCycles[freeMonths + i].expiresAt,
      amount: moneyRef(capPaise),
      note: "Capped cycle (illustrative)",
    });
  }
  const benefit = plan.benefit ?? {};
  return {
    paymentPattern: "FLEXIBLE",
    referencePaymentAmount: moneyRef(installmentAmountPaise),
    installmentAmount: moneyRef(installmentAmountPaise),
    phaseSummary: `${freeMonths} free months · ${cappedCycles} capped cycles`,
    illustrativeCapPerCycle: moneyRef(capPaise),
    totalPayable: moneyRef(illustrativeFreeTotalPaise + cappedTotalPaise),
    totalPayableNote:
      "Illustrative maximum if the reference amount is paid each free month. Actual cap is based on total free-phase contributions.",
    firstDueDate: calendarCycles[0]?.expiresAt ?? startDate,
    maturityDate: maturityDateFromCalendarCycles(calendarCycles),
    benefit: benefit.displayLabel || benefit.type
      ? { type: benefit.type, displayLabel: benefit.displayLabel ?? benefit.type }
      : undefined,
    schedulePreview: schedulePreview.slice(0, 12),
  };
}

function buildFlexiblePreviewSummary(body, startDate, firstInstallmentMode = "START_NEXT_CYCLE") {
  const flex = body.flexibleRules ?? {};
  const flexPhase = flex.flexiblePhase ?? {};
  const freeMonths = flex.flexiblePhaseCycles ?? 6;
  const cappedCycles = flex.cappedPhaseCycles ?? 5;
  const benefit = body.benefit ?? {};
  const calendarCycles = buildCalendarMonthCycles({
    startDate,
    cycleCount: body.durationMonths,
    firstInstallmentMode,
  });
  const freeCal = calendarCycles.slice(0, freeMonths);
  const cappedCal = calendarCycles.slice(freeMonths, freeMonths + cappedCycles);
  return {
    freeWindow: {
      months: freeMonths,
      from: startDate,
      to: freeCal.length ? freeCal[freeCal.length - 1].cycleEnd : startDate,
      minPerPayment: moneyRef(Number(flexPhase.minimumPaymentPaise ?? 0)),
      maxPerPayment: moneyRef(Number(flexPhase.maximumPaymentPaise ?? 0)),
    },
    cappedPhase: {
      cycles: cappedCycles,
      from: cappedCal.length ? cappedCal[0].cycleStart : startDate,
      to: cappedCal.length ? cappedCal[cappedCal.length - 1].cycleEnd : startDate,
      note: `Each of these ${cappedCycles} cycles is capped at the average of your first ${freeMonths} cycles' payments.`,
    },
    maturityDate: maturityDateFromCalendarCycles(calendarCycles),
    benefit: {
      type: benefit.type,
      displayLabel: benefit.displayLabel,
    },
  };
}

function buildFixedPreviewResponse(body) {
  const startDate = body.startDate ?? today();
  const amountRules = body.amountRules ?? {};
  const installmentAmountPaise = Number(
    body.installmentAmountPaise
      ?? amountRules.fixedAmountPaise
      ?? amountRules.minInstallmentPaise
      ?? 0,
  );
  const count = Number(body.installmentCount ?? body.durationMonths ?? 0);
  const scheduleRules = body.scheduleRules ?? {};
  const firstInstallmentMode =
    body.firstInstallmentMode
    ?? scheduleRules.firstInstallmentModeDefault
    ?? "START_NEXT_CYCLE";
  const benefit = body.benefit ?? {};
  const rows = buildSchedulePreview({
    startDate,
    installmentAmountPaise,
    durationMonths: body.durationMonths,
    installmentCount: count,
    scheduleRules,
    firstInstallmentMode,
  });
  const schedule = rows.map((row, index) => ({
    installmentNumber: row.number,
    dueDate: row.dueDate,
    amount: moneyRef(row.amountPaise),
    note:
      index === 0 && firstInstallmentMode === "COLLECT_NOW"
        ? "Collected at enrolment"
        : null,
  }));
  const totalPaise = installmentAmountPaise * count;
  const benefitPaise =
    benefit.type === "ONE_FREE_INSTALLMENT" ? installmentAmountPaise : 0;
  return {
    summary: {
      installmentCount: count,
      installmentAmount: moneyRef(installmentAmountPaise),
      totalPayable: moneyRef(totalPaise),
      firstDueDate: schedule[0]?.dueDate,
      maturityDate:
        resolveFixedSchemeMaturityDate({
          startDate,
          durationMonths: body.durationMonths,
          firstInstallmentMode,
        })
        ?? null,
      benefit: {
        type: benefit.type,
        displayLabel: benefit.displayLabel,
        ...(benefitPaise ? { estimatedValue: moneyRef(benefitPaise) } : {}),
      },
      estimatedMaturityValue: moneyRef(totalPaise + benefitPaise),
      estimatedGoldAtCurrentRate: null,
    },
    schedule,
  };
}

function planCustomerAppVisibilityFilter() {
  return {
    $or: [
      { "availability.visibleInCustomerApp": true },
      { "availability.visibleInCustomerApp": { $exists: false } },
    ],
  };
}

function planCustomerSelfEnrolFilter() {
  return {
    $or: [
      { "availability.customerSelfEnrolAllowed": true },
      { "availability.customerSelfEnrolAllowed": { $exists: false } },
    ],
  };
}

function planBranchAvailabilityFilter(branchId) {
  return {
    $or: [
      { "availability.allBranches": { $ne: false } },
      { "availability.branchIds": branchId },
    ],
  };
}

function isPlanEnrolmentWindowOpen(plan, ymd = today()) {
  const fromYmd = plan.availability?.enrolmentOpenFrom
    ? String(plan.availability.enrolmentOpenFrom).slice(0, 10)
    : null;
  const toYmd = plan.availability?.enrolmentOpenTo
    ? String(plan.availability.enrolmentOpenTo).slice(0, 10)
    : null;
  if (fromYmd && ymd < fromYmd) return false;
  if (toYmd && ymd > toYmd) return false;
  return true;
}

export async function listPlans(req, consumer = "admin") {
  const filters = consumer === "admin" ? {} : { status: SchemePlanStatus.ACTIVE };
  const appAnd = [];
  if (consumer === "app") {
    appAnd.push(planCustomerAppVisibilityFilter(), planCustomerSelfEnrolFilter());
  }
  if (consumer === "admin") {
    if (req.query.status) filters.status = req.query.status;
    if (req.query.valueBasis) filters.valueBasis = req.query.valueBasis;
    if (req.query.paymentPattern) filters.paymentPattern = req.query.paymentPattern;
    const pattern = searchRegex(req.query.q);
    if (pattern) filters.$or = [{ name: pattern }, { code: pattern }];
  }
  if (req.scope?.branchId) {
    const branchOr = planBranchAvailabilityFilter(req.scope.branchId);
    if (filters.$or) {
      filters.$and = [{ $or: filters.$or }, branchOr];
      delete filters.$or;
    } else if (appAnd.length) {
      appAnd.push(branchOr);
    } else {
      Object.assign(filters, branchOr);
    }
  }
  if (appAnd.length) {
    filters.$and = [...(filters.$and ?? []), ...appAnd];
  }
  const result = await paginate(SchemePlan, {
    scope: { tenantId: req.auth.tenantId },
    filters,
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: req.query.sort ?? "createdAt:desc",
  });

  if (consumer === "app") {
    const openToday = result.data.filter((plan) => isPlanEnrolmentWindowOpen(plan));
    return { ...result, data: openToday };
  }

  if (consumer !== "admin") return result;

  const planIds = result.data.map((plan) => plan._id);
  const { byPlanId, statusCounts, tenantTotals } = await planListAggregates(
    req,
    planIds,
  );

  const data = result.data.map((plan) => {
    const stats = byPlanId.get(plan._id) ?? {
      activeSchemes: 0,
      collectedThisMonth: 0,
    };
    return {
      ...plan,
      stats,
      editLocked: stats.activeSchemes > 0,
    };
  });

  return {
    data,
    meta: {
      ...result.meta,
      summary: {
        activePlans: statusCounts.ACTIVE ?? 0,
        draftPlans: statusCounts.DRAFT ?? 0,
        activeEnrollments: tenantTotals.activeEnrollments,
        projectedMonthlyPaise: tenantTotals.projectedMonthlyPaise,
      },
    },
  };
}
export async function getPlan(req) {
  const plan = await findPlanRaw(req);
  return presentPlanDetail(req.auth.tenantId, plan);
}
function rejectUnsupportedPlan(body) { if (body.flexibleRules?.extensionMode === "EXTEND_FLEXIBLE_PHASE") throw errors.business("UNSUPPORTED_PLAN_CONFIGURATION", "Flexible-phase extension is not supported and cannot be saved."); }
export async function createPlan(req) {
  rejectUnsupportedPlan(req.body);
  normalizePlanFinancialRules(req.body);
  const tenant = req.tenant ?? await Tenant.findById(req.auth.tenantId).lean();
  if (req.body.paymentPattern === "FLEXIBLE") {
    assertFeatureEntitled(tenant, "flexibleScheme", "Flexible schemes are not included in your plan.");
  }
  if (req.body.valueBasis === "GOLD_WEIGHT") {
    assertFeatureEntitled(tenant, "goldWeightScheme", "Gold-weight schemes are not included in your plan.");
  }
  return withTransaction(async (session) => {
    const tenantRow = await Tenant.findById(req.auth.tenantId).session(session);
    const used = await SchemePlan.countDocuments({ tenantId: tenantRow._id, status: SchemePlanStatus.ACTIVE }).session(session);
    await assertWithinLimit({ tenant: tenantRow, limitKey: "schemePlans", used, errorCode: "LIMIT_SCHEME_PLANS", label: "active scheme plans" });
    const plan = (await SchemePlan.create([{ _id: createId("plan"), tenantId: req.auth.tenantId, ...req.body, createdBy: req.auth.id }], { session }))[0];
    const auditEventId = await writeAudit({ req, action: "PLAN_CREATED", entityType: AuditEntityType.PLAN, entityId: plan._id, after: plan.toObject(), session });
    return { ...plan.toObject(), auditEventId };
  });
}
export async function updatePlan(req) {
  rejectUnsupportedPlan(req.body);
  return withTransaction(async (session) => {
    const plan = await SchemePlan.findOne({ _id: req.params.planId, tenantId: req.auth.tenantId }).session(session); if (!plan) throw errors.notFound("Scheme plan");
    if (req.body.expectedVersion !== plan.version) throw new AppError("VERSION_CONFLICT", "This plan changed. Refresh and try again.", 409);
    const { ENROLMENT_CAPACITY_STATUSES } = await import("../lib/scheme-enrollment-status.js");
    const activeCount = await Scheme.countDocuments({
      tenantId: plan.tenantId,
      planId: plan._id,
      status: { $in: ENROLMENT_CAPACITY_STATUSES },
    }).session(session);
    const immutable = ["valueBasis", "paymentPattern", "durationMonths", "installmentCount", "amountRules", "scheduleRules", "paymentRules", "flexibleRules", "benefit", "redemptionRules"];
    if (activeCount && immutable.some((key) => req.body[key] !== undefined)) throw new AppError("PLAN_HAS_ACTIVE_ENROLMENTS", "Financial rules cannot be changed while the plan has active enrolments.", 409);
    const before = plan.toObject();
    const patch = { ...req.body };
    delete patch.expectedVersion;
    if (patch.status === undefined) delete patch.status;
    normalizePlanFinancialRules(patch);
    const merged = mergePlanPatch(before, patch);
    normalizePlanFinancialRules(merged);
    rejectUnsupportedPlan(merged);
    const tenantRow = req.tenant ?? await Tenant.findById(req.auth.tenantId).session(session);
    if (merged.paymentPattern === PaymentPattern.FLEXIBLE) {
      assertFeatureEntitled(tenantRow, "flexibleScheme", "Flexible schemes are not included in your plan.");
    }
    if (merged.valueBasis === "GOLD_WEIGHT") {
      assertFeatureEntitled(tenantRow, "goldWeightScheme", "Gold-weight schemes are not included in your plan.");
    }
    const validated = validateCompletePlan(merged);
    for (const key of Object.keys(validated)) {
      plan.set(key, validated[key]);
    }
    plan.version += 1;
    await plan.save({ session });
    const auditEventId = await writeAudit({ req, action: "PLAN_UPDATED", entityType: AuditEntityType.PLAN, entityId: plan._id, before, after: plan.toObject(), session }); return { ...plan.toObject(), auditEventId };
  });
}
export async function setPlanStatus(req, status) { return withTransaction(async (session) => { const plan = await SchemePlan.findOneAndUpdate({ _id: req.params.planId, tenantId: req.auth.tenantId }, { $set: { status }, $inc: { version: 1 } }, { new: true, session }); if (!plan) throw errors.notFound("Scheme plan"); const auditEventId = await writeAudit({ req, action: status === SchemePlanStatus.ACTIVE ? "PLAN_ACTIVATED" : "PLAN_DEACTIVATED", entityType: AuditEntityType.PLAN, entityId: plan._id, after: plan.toObject(), session }); return { id: plan._id, status, version: plan.version, auditEventId }; }); }
function duplicatePlanCode(code) {
  const root = String(code ?? "PLAN")
    .replace(/_COPY_[A-Z0-9]+$/i, "")
    .replace(/-[A-Z0-9]{4,}$/i, "")
    .replace(/[^A-Z0-9_-]/gi, "")
    .slice(0, 11)
    .toUpperCase();
  const suffix = Date.now().toString(36).slice(-4).toUpperCase();
  const candidate = `${root}-${suffix}`;
  return candidate.length <= 20
    ? candidate
    : `${root.slice(0, Math.max(2, 20 - suffix.length - 1))}-${suffix}`.slice(
        0,
        20,
      );
}

function pickPlanDuplicateBody(source) {
  return {
    name: `${source.name} Copy`.slice(0, 120),
    code: duplicatePlanCode(source.code),
    displayName: source.displayName,
    description: source.description,
    termsText: source.termsText,
    valueBasis: source.valueBasis,
    paymentPattern: source.paymentPattern,
    durationMonths: source.durationMonths,
    installmentCount: source.installmentCount,
    amountRules: source.amountRules,
    scheduleRules: source.scheduleRules,
    paymentRules: source.paymentRules,
    flexibleRules: source.flexibleRules ?? null,
    goldRules: source.goldRules ?? null,
    benefit: source.benefit,
    redemptionRules: source.redemptionRules,
    availability: source.availability,
    status: SchemePlanStatus.DRAFT,
  };
}

export async function duplicatePlan(req) {
  const source = await findPlanRaw(req);
  req.body = pickPlanDuplicateBody(source);
  const created = await createPlan(req);
  return { id: created._id, ...created };
}
export async function planStats(req) {
  const plan = await findPlanRaw(req);
  return buildPlanStatsPayload(req.auth.tenantId, plan);
}
export async function previewSchedule(body, tenantId) {
  let merged = { ...body };
  if (body.planId && tenantId) {
    const saved = await SchemePlan.findOne({ _id: body.planId, tenantId }).lean();
    if (saved) {
      merged = {
        ...saved,
        ...body,
        scheduleRules: { ...saved.scheduleRules, ...body.scheduleRules },
        amountRules: { ...saved.amountRules, ...body.amountRules },
        flexibleRules: body.flexibleRules ?? saved.flexibleRules,
        benefit: body.benefit ?? saved.benefit,
      };
    }
  }
  const startDate = merged.startDate ?? today();
  if (merged.paymentPattern === PaymentPattern.FLEXIBLE) {
    return {
      summary: buildFlexiblePreviewSummary(merged, startDate),
      schedule: [],
    };
  }
  return buildFixedPreviewResponse({ ...merged, startDate });
}
