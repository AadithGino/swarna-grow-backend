import { buildOneTimeGoldSchedule } from "../lib/one-time-gold-schedule.js";
import { AuditEntityType, PaymentPattern, SchemePlanStatus } from "../constants/enums.js";
import { Branch, LedgerEntry, Payment, Scheme, SchemePlan, Tenant } from "../models/index.js";
import { assertFeatureEntitled, assertWithinLimit } from "../lib/tenant-limits.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { writeAudit } from "./audit.service.js";
import { paginate } from "../lib/pagination.js";
import { effectiveScope, searchRegex } from "../lib/query-filters.js";
import { addMonthsClamped, today } from "../lib/date.js";
import { iteratePeriodBuckets } from "../lib/analytics-period.js";
import { moneyPaiseFromWeightMg, moneyRef, weightRef } from "../lib/money.js";
import { maturityGoldRules, maturityGoldLabel } from "../lib/maturity-gold-benefit.js";
import { collectionBonusWeight, postedCollectionBonusWeight } from "../lib/collection-maturity-bonus.js";
import { latestGoldRate22KOnOrBefore, currentGoldRate22K } from "../lib/gold-rate-lookup.js";
import { computeConfiguredBenefitPaise } from "../lib/scheme-benefit.js";
import {
  buildIllustrativeFreeWindowNetSummary,
  computeFlexibleLockCapDetails,
} from "../lib/flexible-cap.js";
import { buildAmountSummary } from "../lib/plan-amount-summary.js";
import { normalizePlanFinancialRules } from "../lib/plan-amount-normalize.js";
import { mergePlanPatch, validateCompletePlan } from "../lib/plan-merge.js";
import {
  buildCalendarMonthCycles,
  maturityDateFromCalendarCycles,
} from "../lib/calendar-cycle.js";
import { assertCollectionAmountsAtRate, buildCollectionSchedule } from "../lib/collection-schedule.js";
import { buildSchedulePreview, resolveFixedSchemeMaturityDate } from "./schedule.service.js";
import {
  netCollectionStatusFilter,
  sumNetAmountPaise,
} from "../lib/payment-net-aggregation.js";

const ACTIVE_SCHEME_STATUSES = ["ACTIVE", "LOCKED", "DEFAULTED"];
const PLAN_BENEFIT_LIABILITY_STATUSES = ["ACTIVE", "LOCKED", "DEFAULTED", "MATURED"];

async function computeCollectionPlanLiability(tenantId, plan) {
  const schemes = await Scheme.find({
    tenantId, planId: plan._id,
    status: { $in: PLAN_BENEFIT_LIABILITY_STATUSES },
  }).select("_id tenantId branchId collectionFrequency collectionBonus maturityDate planSnapshot").lean();
  const entries = schemes.length ? await LedgerEntry.find({
    tenantId, schemeId: { $in: schemes.map((scheme) => scheme._id) },
  }).select("schemeId type amountPaise weightMg").lean() : [];
  const byScheme = new Map();
  for (const entry of entries) {
    const group = byScheme.get(entry.schemeId) ?? [];
    group.push(entry);
    byScheme.set(entry.schemeId, group);
  }
  const { schemeLedgerTotals } = await import("./scheme.service.js");
  const asOf = today();
  const rateCache = new Map();
  function getRate(scheme, date) {
    const key = JSON.stringify([scheme.branchId, date]);
    if (!rateCache.has(key)) rateCache.set(key, latestGoldRate22KOnOrBefore(scheme, date));
    return rateCache.get(key);
  }
  let valuePaise = 0;
  let weightMg = 0;
  let awaitingRate = 0;
  for (const scheme of schemes) {
    const rules = maturityGoldRules(scheme.planSnapshot);
    if (!rules) continue;
    const group = byScheme.get(scheme._id) ?? [];
    const totals = schemeLedgerTotals(scheme, group);
    const currentRate = await getRate(scheme, asOf);
    let bonusMg = postedCollectionBonusWeight(group);
    if (!scheme.collectionBonus?.ledgerEntryId && scheme.collectionBonus?.status !== "INELIGIBLE" && totals.amountPaidPaise > 0) {
      const rateDate = scheme.maturityDate < asOf ? scheme.maturityDate : asOf;
      const awardRate = rules.bonusBasis === "NET_PAID_AT_MATURITY_RATE" ? await getRate(scheme, rateDate) : null;
      if (rules.bonusBasis === "NET_PAID_AT_MATURITY_RATE" && !awardRate?.ratePerGramPaise) awaitingRate += 1;
      else bonusMg = collectionBonusWeight(rules, totals, scheme.planSnapshot.goldRules, awardRate?.ratePerGramPaise);
    }
    weightMg += bonusMg;
    if (bonusMg && !currentRate?.ratePerGramPaise) awaitingRate += 1;
    if (currentRate?.ratePerGramPaise) valuePaise += moneyPaiseFromWeightMg(bonusMg, currentRate.ratePerGramPaise);
  }
  return { weightMg, valuePaise, awaitingRate };
}

/** Outstanding configured benefit across live and matured-unredeemed schemes (per-scheme cap, net paid). */
export async function computePlanBenefitLiabilityPaise(tenantId, plan) {
  if (maturityGoldRules(plan)) return (await computeCollectionPlanLiability(tenantId, plan)).valuePaise;
  const benefit = plan.benefit;
  if (!benefit || benefit.type === "TEXT_ONLY") return 0;
  const schemes = await Scheme.find({
    tenantId,
    planId: plan._id,
    status: { $in: PLAN_BENEFIT_LIABILITY_STATUSES },
  })
    .select("_id installmentAmountPaise paymentPattern lockedAveragePaise planSnapshot")
    .lean();
  if (!schemes.length) return 0;
  const schemeIds = schemes.map((row) => row._id);
  const ledgerRows = await LedgerEntry.find({
    tenantId,
    schemeId: { $in: schemeIds },
  })
    .sort({ sequence: 1 })
    .lean();
  const entriesByScheme = new Map();
  for (const entry of ledgerRows) {
    const bucket = entriesByScheme.get(entry.schemeId) ?? [];
    bucket.push(entry);
    entriesByScheme.set(entry.schemeId, bucket);
  }
  const { ledgerTotals } = await import("./scheme.service.js");
  let total = 0;
  for (const scheme of schemes) {
    const totals = ledgerTotals(entriesByScheme.get(scheme._id) ?? []);
    total += computeConfiguredBenefitPaise(scheme, totals, benefit);
  }
  return Math.max(0, total);
}

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
        ...netCollectionStatusFilter(),
      },
    },
    { $group: { _id: null, total: sumNetAmountPaise() } },
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
  const collectionLiability = maturityGoldRules(plan) ? await computeCollectionPlanLiability(tenantId, plan) : null;
  const benefitLiabilityPaise = collectionLiability?.valuePaise ?? await computePlanBenefitLiabilityPaise(tenantId, plan);
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
      benefitLiability: collectionLiability?.awaitingRate ? null : moneyRef(benefitLiabilityPaise),
      ...(collectionLiability ? {
        benefitLiabilityGold: weightRef(collectionLiability.weightMg),
        benefitLiabilityAwaitingRate: collectionLiability.awaitingRate,
      } : {}),
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
  const netSummary = buildIllustrativeFreeWindowNetSummary({
    installmentAmountPaise,
    flexiblePhaseCycles: free,
  });
  const { capPaise, audit } = computeFlexibleLockCapDetails({
    netSummary,
    flexibleRules: flexRules,
  });
  return {
    illustrativeFreeTotalPaise: netSummary.netFreeTotalPaise,
    capPaise,
    capAudit: audit,
  };
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
  const capDivisor = flex.capComputation?.formula === "FLEXIBLE_PHASE_TOTAL_DIV_PAYMENT_COUNT"
    ? "number of payments in the free phase"
    : String(flex.averagingDivisor ?? freeMonths);
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
      from: firstInstallmentMode === "COLLECT_NOW" ? startDate : freeCal[0]?.cycleStart ?? startDate,
      to: freeCal.length ? freeCal[freeCal.length - 1].cycleEnd : startDate,
      minPerPayment: moneyRef(Number(flexPhase.minimumPaymentPaise ?? 0)),
      maxPerPayment: moneyRef(Number(flexPhase.maximumPaymentPaise ?? 0)),
    },
    cappedPhase: {
      cycles: cappedCycles,
      from: cappedCal.length ? cappedCal[0].cycleStart : startDate,
      to: cappedCal.length ? cappedCal[cappedCal.length - 1].cycleEnd : startDate,
      note: `Monthly cap is based on free-phase contributions divided by ${capDivisor}, then adjusted by the plan’s rounding and limits.`,
    },
    maturityDate: maturityDateFromCalendarCycles(calendarCycles),
    benefit: {
      type: benefit.type,
      displayLabel: maturityGoldRules(body) ? maturityGoldLabel(maturityGoldRules(body)) : benefit.displayLabel,
    },
  };
}

function buildFixedPreviewResponse(body, rate) {
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
    (body.oneTimeRules ? "COLLECT_NOW" : body.firstInstallmentMode)
    ?? scheduleRules.firstInstallmentModeDefault
    ?? "START_NEXT_CYCLE";
  const benefit = body.benefit ?? {};
  const oneTimeSchedule = body.oneTimeRules ? buildOneTimeGoldSchedule(body, startDate) : null;
  const collection = body.collectionRules ? buildCollectionSchedule({
    plan: body, startDate, collectionFrequency: body.collectionFrequency ?? body.collectionRules.frequencies[0],
    collectionAmountPaise: installmentAmountPaise, firstInstallmentMode,
  }) : null;
  if (collection && rate) assertCollectionAmountsAtRate(collection.installments, rate, body.goldRules);
  const rows = collection?.installments ?? buildSchedulePreview({
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
  const totalPaise = collection?.totalPaise ?? installmentAmountPaise * count;
  const benefitPaise = computeConfiguredBenefitPaise(
    { paymentPattern: body.paymentPattern, installmentAmountPaise },
    { amountPaidPaise: totalPaise },
    benefit,
  );
  return {
    summary: {
      installmentCount: rows.length,
      installmentAmount: moneyRef(rows[0]?.amountPaise ?? installmentAmountPaise),
      ...(collection ? { collectionFrequency: collection.collectionFrequency, collectionRules: body.collectionRules } : {}),
      totalPayable: moneyRef(totalPaise),
      firstDueDate: schedule[0]?.dueDate,
      maturityDate:
        oneTimeSchedule?.at(-1)?.dueDate ?? collection?.maturityDate ?? resolveFixedSchemeMaturityDate({
          startDate,
          durationMonths: body.durationMonths,
          firstInstallmentMode,
        })
        ?? null,
      benefit: {
        type: benefit.type,
        displayLabel: maturityGoldRules(body) ? maturityGoldLabel(maturityGoldRules(body)) : benefit.displayLabel,
        ...(benefitPaise ? { estimatedValue: moneyRef(benefitPaise) } : {}),
      },
      ...(oneTimeSchedule ? { oneTimeSchedule, oneTimeRules: body.oneTimeRules } : {}),
      estimatedMaturityValue: body.valueBasis === "GOLD_WEIGHT" ? null : moneyRef(totalPaise + benefitPaise),
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

async function assertPlanBranchIdsBelongToTenant(tenantId, availability) {
  if (!availability || availability.allBranches !== false) return;
  const branchIds = [...new Set(availability.branchIds ?? [])];
  if (!branchIds.length) return;
  const rows = await Branch.find({ tenantId, _id: { $in: branchIds } })
    .select("_id active")
    .lean();
  const byId = new Map(rows.map((row) => [String(row._id), row]));
  for (const branchId of branchIds) {
    const row = byId.get(String(branchId));
    if (!row) {
      throw errors.validation([{
        field: "availability.branchIds",
        message: "Each selected branch must belong to this tenant.",
      }]);
    }
    if (!row.active) {
      throw errors.validation([{
        field: "availability.branchIds",
        message: "Each selected branch must be active.",
      }]);
    }
  }
}
export async function createPlan(req) {
  rejectUnsupportedPlan(req.body);
  normalizePlanFinancialRules(req.body);
  const validatedBody = validateCompletePlan(req.body);
  await assertPlanBranchIdsBelongToTenant(req.auth.tenantId, validatedBody.availability);
  const tenant = req.tenant ?? await Tenant.findById(req.auth.tenantId).lean();
  if (validatedBody.paymentPattern === "FLEXIBLE") {
    assertFeatureEntitled(tenant, "flexibleScheme", "Flexible schemes are not included in your plan.");
  }
  if (validatedBody.valueBasis === "GOLD_WEIGHT") {
    assertFeatureEntitled(tenant, "goldWeightScheme", "Gold-weight schemes are not included in your plan.");
  }
  return withTransaction(async (session) => {
    const tenantRow = await Tenant.findById(req.auth.tenantId).session(session);
    const used = await SchemePlan.countDocuments({ tenantId: tenantRow._id, status: SchemePlanStatus.ACTIVE }).session(session);
    await assertWithinLimit({ tenant: tenantRow, limitKey: "schemePlans", used, errorCode: "LIMIT_SCHEME_PLANS", label: "active scheme plans" });
    const plan = (await SchemePlan.create([{ _id: createId("plan"), tenantId: req.auth.tenantId, ...validatedBody, createdBy: req.auth.id }], { session }))[0];
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
    const immutable = ["valueBasis", "paymentPattern", "durationMonths", "installmentCount", "collectionRules", "oneTimeRules", "amountRules", "scheduleRules", "paymentRules", "flexibleRules", "benefit", "redemptionRules"];
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
    await assertPlanBranchIdsBelongToTenant(req.auth.tenantId, validated.availability);
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
    collectionRules: source.collectionRules,
    oneTimeRules: source.oneTimeRules,
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
export async function previewSchedule(body, tenantId, branchId) {
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
    } else {
      throw errors.notFound("Scheme plan");
    }
  }
  const startDate = merged.startDate ?? today();
  if (merged.paymentPattern === PaymentPattern.FLEXIBLE) {
    return {
      summary: buildFlexiblePreviewSummary(merged, startDate, merged.firstInstallmentMode ?? merged.scheduleRules?.firstInstallmentModeDefault),
      schedule: [],
    };
  }
  const rate = merged.collectionRules && tenantId
    ? await currentGoldRate22K({ tenantId, branchId }, today())
    : null;
  return buildFixedPreviewResponse({ ...merged, startDate }, rate);
}
