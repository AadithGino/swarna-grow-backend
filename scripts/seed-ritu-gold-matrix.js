/**
 * Ritu Gold demo — enrollments across fixed & flexible gold plans (all major states).
 */
import dayjs from "dayjs";
import {
  ClosureType,
  FlexiblePhase,
  PaymentStatus,
  RedemptionMode,
  SchemeStatus,
} from "../src/constants/enums.js";
import { addMonthsClamped, monthKey, today } from "../src/lib/date.js";
import { createId } from "../src/lib/ids.js";
import { LedgerEntry, Payment, Scheme } from "../src/models/index.js";
import { recordPayment } from "../src/services/payment.service.js";
import { buildSchedulePreview } from "../src/services/schedule.service.js";
import {
  applyFlexibleLock,
  enrol,
  rebuildSchemeProjection,
} from "../src/services/scheme.service.js";
import {
  initiateRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { nextSequence } from "../src/services/sequence.service.js";

function daysFromToday(offsetDays) {
  return dayjs(today()).add(offsetDays, "day").format("YYYY-MM-DD");
}

function logStep(label) {
  console.log(`[ritu-gold seed] ${label}…`);
}

function paymentReq(ctx, schemeId, { amountPaise, mode = "CASH", expectedVersion }) {
  return {
    ...ctx,
    body: { schemeId, amountPaise, mode, expectedVersion },
  };
}

async function recomputeSchemeStatuses(schemeId) {
  const scheme = await Scheme.findById(schemeId);
  if (!scheme) return;
  const entries = await LedgerEntry.find({ tenantId: scheme.tenantId, schemeId: scheme._id })
    .sort({ sequence: 1 })
    .lean();
  rebuildSchemeProjection(scheme, entries);
  scheme.version += 1;
  await scheme.save();
}

async function createFixedScheme(ctx, { customer, plan, branchId, startDate }) {
  const installmentAmountPaise = plan.amountRules.fixedAmountPaise;
  const installments = buildSchedulePreview({
    startDate,
    installmentAmountPaise,
    durationMonths: plan.durationMonths,
    installmentCount: plan.installmentCount,
    scheduleRules: plan.scheduleRules,
    firstInstallmentMode: "START_NEXT_CYCLE",
  });
  const maturityDate = installments.at(-1).dueDate;
  const enrolNo = await nextSequence(ctx.auth.tenantId, "scheme");
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: ctx.auth.tenantId,
    branchId,
    customerId: customer._id,
    planId: plan._id,
    enrollmentNumber: `ENR-${String(enrolNo).padStart(7, "0")}`,
    planSnapshot: plan.toObject(),
    valueBasis: plan.valueBasis,
    paymentPattern: plan.paymentPattern,
    status: SchemeStatus.ACTIVE,
    startDate,
    maturityDate,
    installmentAmountPaise,
    installments,
    version: 1,
    createdBy: ctx.auth.id,
  });
  return scheme;
}

async function payInstallments(ctx, scheme, count, { mode = "CASH", amountPaise, backdateFrom, useAdvance = true } = {}) {
  let doc = await Scheme.findById(scheme._id);
  const unit = amountPaise ?? doc.installmentAmountPaise;
  let remaining = count;
  while (remaining > 0) {
    const chunk = useAdvance && remaining >= 2 ? Math.min(remaining, 2) : 1;
    const payPaise = unit * chunk;
    await recordPayment(
      paymentReq(ctx, doc._id, { amountPaise: payPaise, mode, expectedVersion: doc.version }),
    );
    doc = await Scheme.findById(scheme._id);
    remaining -= chunk;
  }
  if (backdateFrom) {
    const payments = await Payment.find({
      schemeId: scheme._id,
      status: PaymentStatus.SUCCESS,
    }).sort({ createdAt: 1 });
    for (let i = 0; i < payments.length; i += 1) {
      const paidAt = dayjs(backdateFrom).add(i, "month").hour(11).minute(30).toDate();
      await Payment.updateOne({ _id: payments[i]._id }, { $set: { paidAt } });
    }
  }
  await recomputeSchemeStatuses(scheme._id);
  return Scheme.findById(scheme._id);
}

async function markMatured(schemeId) {
  await Scheme.updateOne(
    { _id: schemeId },
    { $set: { status: SchemeStatus.MATURED, maturityDate: daysFromToday(-7) } },
  );
}

function redemptionCtx(ctx, schemeId, body = {}) {
  return { ...ctx, params: { schemeId }, body };
}

async function openRedemption(ctx, schemeId, closureType, mode) {
  const scheme = await Scheme.findById(schemeId);
  const preview = await settlementPreview(
    redemptionCtx(ctx, scheme._id, { mode }),
    closureType,
  );
  if (!preview.eligible) {
    throw new Error(
      `Redemption blocked ${scheme.enrollmentNumber}: ${preview.blockers[0]?.message ?? "not eligible"}`,
    );
  }
  const body = {
    mode,
    expectedVersion: scheme.version,
    modeDetails: {
      expectedFinalValuePaise: preview.settlementPaise,
      ...(mode === RedemptionMode.PURCHASE_ADJUSTMENT
        ? { billNumber: `RITU-${scheme.enrollmentNumber}` }
        : {}),
      ...(closureType === ClosureType.PREMATURE_CLOSURE
        ? {
            acknowledgePenalty: preview.penaltyPaise > 0,
            acknowledgeBenefitForfeit: preview.penalty?.benefitTreatment === "FORFEIT",
          }
        : {}),
    },
  };
  return initiateRedemption(redemptionCtx(ctx, scheme._id, body), closureType, false);
}

async function createFlexibleScheme(ctx, { customer, plan, branchId, startDate }) {
  const installmentCount = plan.installmentCount ?? plan.durationMonths;
  const cycles = buildSchedulePreview({
    startDate,
    durationMonths: plan.durationMonths,
    installmentCount,
    scheduleRules: plan.scheduleRules ?? {},
    firstInstallmentMode: "START_NEXT_CYCLE",
  }).map((row) => ({
    cycle: row.dueDate.slice(0, 7),
    capPaise: 0,
    paidPaise: 0,
    remainingPaise: 0,
    status: "UPCOMING",
    expiresAt: row.graceEndsAt,
  }));
  const maturityDate = cycles.at(-1).expiresAt.slice(0, 10);
  const enrolNo = await nextSequence(ctx.auth.tenantId, "scheme");
  return Scheme.create({
    _id: createId("scheme"),
    tenantId: ctx.auth.tenantId,
    branchId,
    customerId: customer._id,
    planId: plan._id,
    enrollmentNumber: `ENR-${String(enrolNo).padStart(7, "0")}`,
    planSnapshot: plan.toObject(),
    valueBasis: plan.valueBasis,
    paymentPattern: plan.paymentPattern,
    status: SchemeStatus.ACTIVE,
    startDate,
    maturityDate,
    cycles,
    flexiblePhase: FlexiblePhase.FLEXIBLE,
    positionVersion: 0,
    version: 1,
    createdBy: ctx.auth.id,
  });
}

function flexCycleKeys(scheme, count) {
  return scheme.cycles.slice(0, count).map((row) => row.cycle);
}

function flexPaymentReq(ctx, schemeId, { amountPaise, expectedPositionVersion, mode = "CASH", targetCycle }) {
  const cycle = targetCycle ?? monthKey();
  return {
    ...ctx,
    body: {
      schemeId,
      amountPaise,
      mode,
      targetCycle: cycle,
      expectedPositionVersion,
    },
    query: { targetCycle: cycle },
  };
}

async function recordFlexPayment(ctx, schemeId, amountPaise, targetCycle, mode = "CASH") {
  let doc = await Scheme.findById(schemeId);
  const cycle = targetCycle ?? monthKey();
  await recordPayment(
    flexPaymentReq(ctx, doc._id, {
      amountPaise,
      expectedPositionVersion: doc.positionVersion ?? 0,
      mode,
      targetCycle: cycle,
    }),
    {
      referenceDate: `${cycle}-15`,
      internalReferenceDateOverride: true,
    },
  );
  return Scheme.findById(schemeId);
}

async function seedMatureFixedGold(ctx, { customer, plan, branchId, startDate, label }) {
  if (label) process.stdout.write(`[ritu-gold seed]   mature fixed: ${label}\n`);
  const scheme = await createFixedScheme(ctx, { customer, plan, branchId, startDate });
  const n = plan.installmentCount ?? 18;
  await payInstallments(ctx, scheme, n, { mode: "CASH", backdateFrom: startDate, useAdvance: true });
  await markMatured(scheme._id);
  return Scheme.findById(scheme._id);
}

function flexLockReferenceDate(scheme, freeCycleCount) {
  const lastFree = scheme.cycles[freeCycleCount - 1];
  return dayjs(lastFree.expiresAt).add(1, "day").format("YYYY-MM-DD");
}

function firstCappedCycleKey(scheme, freeCycleCount) {
  return scheme.cycles[freeCycleCount]?.cycle ?? monthKey();
}

async function payCappedCycle(ctx, schemeId, amountPaise, cycleKey, referenceDate) {
  let doc = await Scheme.findById(schemeId);
  await recordPayment(
    flexPaymentReq(ctx, doc._id, {
      amountPaise,
      expectedPositionVersion: doc.positionVersion ?? 0,
      mode: "CASH",
      targetCycle: cycleKey,
    }),
    {
      referenceDate,
      internalReferenceDateOverride: true,
    },
  );
  return Scheme.findById(schemeId);
}

/** Flex free phase complete → lock → optional capped-cycle payment. */
async function seedFlexLocked(ctx, { customer, plan, branchId, startDate, perCyclePaise, capPayPaise = 0 }) {
  const freeCycles = plan.flexibleRules.flexiblePhaseCycles;
  let flex = await createFlexibleScheme(ctx, { customer, plan, branchId, startDate });
  const keys = flexCycleKeys(flex, freeCycles);
  for (let idx = 0; idx < keys.length; idx += 1) {
    if (idx > 0 && idx % 6 === 0) {
      process.stdout.write(`[ritu-gold seed]   flex cycles ${idx}/${keys.length} (${flex.enrollmentNumber})\n`);
    }
    flex = await recordFlexPayment(ctx, flex._id, perCyclePaise, keys[idx]);
  }
  const lockRef = flexLockReferenceDate(flex, freeCycles);
  await applyFlexibleLock({ ...ctx, params: { schemeId: flex._id } }, { referenceDate: lockRef });
  flex = await Scheme.findById(flex._id);
  const cappedCycle = firstCappedCycleKey(flex, freeCycles);
  const capRef = `${cappedCycle}-15`;
  if (capPayPaise > 0) {
    flex = await payCappedCycle(ctx, flex._id, capPayPaise, cappedCycle, capRef);
  }
  return Scheme.findById(flex._id);
}

/**
 * @param {object} ctx
 * @param {{ fixedPlan: object, flexPlan: object, branchId: string, customers: object[] }} deps
 */
export async function seedRituDemoMatrix(ctx, { fixedPlan, flexPlan, branchId, customers }) {
  const summary = [];
  const fixedCount = plan => plan.installmentCount ?? 18;
  let i = 0;
  const nextCustomer = () => customers[i++];

  logStep("fixed schemes (enrolment → defaulted)");
  // —— Fixed gold (RITU18FIX) ——
  const pendingCust = nextCustomer();
  await enrol({
    ...ctx,
    body: {
      customerId: pendingCust._id,
      planId: fixedPlan._id,
      branchId,
      startDate: today(),
      installmentAmountPaise: 500_000,
      firstInstallmentMode: "COLLECT_NOW",
    },
  });
  summary.push({ customer: pendingCust.name, story: "FIX · PENDING_PAYMENT (first instalment not collected)" });

  const freshCust = nextCustomer();
  const freshStart = today();
  await enrol({
    ...ctx,
    body: {
      customerId: freshCust._id,
      planId: fixedPlan._id,
      branchId,
      startDate: freshStart,
      installmentAmountPaise: 500_000,
      firstInstallmentMode: "START_NEXT_CYCLE",
    },
  });
  summary.push({ customer: freshCust.name, story: "FIX · ACTIVE · just enrolled · 0 paid" });

  const startedCust = nextCustomer();
  const start2 = addMonthsClamped(today(), -2).format("YYYY-MM-DD");
  let s = await createFixedScheme(ctx, {
    customer: startedCust,
    plan: fixedPlan,
    branchId,
    startDate: start2,
  });
  s = await payInstallments(ctx, s, 2, { backdateFrom: start2 });
  summary.push({ customer: startedCust.name, enrollment: s.enrollmentNumber, story: "FIX · ACTIVE · 2 instalments paid" });

  const midCust = nextCustomer();
  const startMid = addMonthsClamped(today(), -10).format("YYYY-MM-DD");
  s = await createFixedScheme(ctx, { customer: midCust, plan: fixedPlan, branchId, startDate: startMid });
  s = await payInstallments(ctx, s, 9, { backdateFrom: startMid });
  summary.push({ customer: midCust.name, enrollment: s.enrollmentNumber, story: "FIX · ACTIVE · mid progress (9/18)" });

  const advanceCust = nextCustomer();
  const startAdvance = addMonthsClamped(today(), -3).format("YYYY-MM-DD");
  s = await createFixedScheme(ctx, { customer: advanceCust, plan: fixedPlan, branchId, startDate: startAdvance });
  let doc = await Scheme.findById(s._id);
  await recordPayment(
    paymentReq(ctx, doc._id, {
      amountPaise: 1_000_000,
      mode: "CASH",
      expectedVersion: doc.version,
    }),
  );
  await Payment.updateMany(
    { schemeId: s._id },
    { $set: { paidAt: dayjs(startAdvance).add(1, "month").toDate() } },
  );
  await recomputeSchemeStatuses(s._id);
  s = await Scheme.findById(s._id);
  summary.push({
    customer: advanceCust.name,
    enrollment: s.enrollmentNumber,
    story: "FIX · ACTIVE · advance (2 instalments in one receipt)",
  });

  const overdueCust = nextCustomer();
  const startOd = addMonthsClamped(today(), -6).format("YYYY-MM-DD");
  s = await createFixedScheme(ctx, { customer: overdueCust, plan: fixedPlan, branchId, startDate: startOd });
  s = await payInstallments(ctx, s, 1, { backdateFrom: startOd });
  summary.push({ customer: overdueCust.name, enrollment: s.enrollmentNumber, story: "FIX · OVERDUE / dues workboard" });

  const defaultedCust = nextCustomer();
  const defStart = addMonthsClamped(today(), -9).format("YYYY-MM-DD");
  s = await createFixedScheme(ctx, { customer: defaultedCust, plan: fixedPlan, branchId, startDate: defStart });
  s = await payInstallments(ctx, s, 1, { backdateFrom: defStart });
  await recomputeSchemeStatuses(s._id);
  await Scheme.updateOne({ _id: s._id }, { $set: { status: SchemeStatus.DEFAULTED } });
  s = await Scheme.findById(s._id);
  summary.push({
    customer: defaultedCust.name,
    enrollment: s.enrollmentNumber,
    story: "FIX · DEFAULTED · multiple overdue instalments",
  });

  const nearDoneCust = nextCustomer();
  const startNear = addMonthsClamped(today(), -17).format("YYYY-MM-DD");
  s = await createFixedScheme(ctx, { customer: nearDoneCust, plan: fixedPlan, branchId, startDate: startNear });
  s = await payInstallments(ctx, s, 16, { backdateFrom: startNear });
  summary.push({
    customer: nearDoneCust.name,
    enrollment: s.enrollmentNumber,
    story: "FIX · ACTIVE · near maturity (16/18 paid)",
  });

  logStep("fixed matured + redemption queue (5×18 payments — ~2 min)");
  const matureCust = nextCustomer();
  const matureStart = addMonthsClamped(today(), -(fixedCount(fixedPlan) + 2)).format("YYYY-MM-DD");
  s = await seedMatureFixedGold(ctx, {
    customer: matureCust,
    plan: fixedPlan,
    branchId,
    startDate: matureStart,
    label: "ready to redeem",
  });
  summary.push({ customer: matureCust.name, enrollment: s.enrollmentNumber, story: "FIX · MATURED · ready to redeem" });

  const redPendingCust = nextCustomer();
  s = await seedMatureFixedGold(ctx, {
    customer: redPendingCust,
    plan: fixedPlan,
    branchId,
    startDate: matureStart,
    label: "redemption pending",
  });
  const redP = await openRedemption(ctx, s._id, ClosureType.MATURITY_REDEMPTION, RedemptionMode.GOLD_HANDOVER);
  summary.push({
    customer: redPendingCust.name,
    enrollment: s.enrollmentNumber,
    story: `FIX · MATURED · redemption ${redP.status} (approve in queue)`,
  });

  const redApprovedCust = nextCustomer();
  s = await seedMatureFixedGold(ctx, {
    customer: redApprovedCust,
    plan: fixedPlan,
    branchId,
    startDate: matureStart,
    label: "redemption approved",
  });
  const redA = await openRedemption(ctx, s._id, ClosureType.MATURITY_REDEMPTION, RedemptionMode.PURCHASE_ADJUSTMENT);
  await transitionRedemption({ ...ctx, params: { redemptionId: redA._id }, body: {} }, "approve");
  summary.push({
    customer: redApprovedCust.name,
    enrollment: s.enrollmentNumber,
    story: "FIX · redemption APPROVED · complete handover",
  });

  const redeemedCust = nextCustomer();
  s = await seedMatureFixedGold(ctx, {
    customer: redeemedCust,
    plan: fixedPlan,
    branchId,
    startDate: matureStart,
    label: "redeemed",
  });
  const redC = await openRedemption(ctx, s._id, ClosureType.MATURITY_REDEMPTION, RedemptionMode.GOLD_HANDOVER);
  await transitionRedemption({ ...ctx, params: { redemptionId: redC._id }, body: {} }, "approve");
  await transitionRedemption({ ...ctx, params: { redemptionId: redC._id }, body: {} }, "complete");
  summary.push({
    customer: redeemedCust.name,
    enrollment: s.enrollmentNumber,
    story: "FIX · REDEEMED (maturity gold handover completed)",
  });

  const preCloseCust = nextCustomer();
  const preStart = addMonthsClamped(today(), -8).format("YYYY-MM-DD");
  s = await createFixedScheme(ctx, { customer: preCloseCust, plan: fixedPlan, branchId, startDate: preStart });
  s = await payInstallments(ctx, s, 6, { backdateFrom: preStart });
  const preRed = await openRedemption(
    ctx,
    s._id,
    ClosureType.PREMATURE_CLOSURE,
    RedemptionMode.PURCHASE_ADJUSTMENT,
  );
  await transitionRedemption({ ...ctx, params: { redemptionId: preRed._id }, body: {} }, "approve");
  await transitionRedemption({ ...ctx, params: { redemptionId: preRed._id }, body: {} }, "complete");
  summary.push({
    customer: preCloseCust.name,
    enrollment: s.enrollmentNumber,
    story: "FIX · CLOSED_PREMATURE (early purchase adjustment)",
  });

  const preWaitCust = nextCustomer();
  s = await createFixedScheme(ctx, { customer: preWaitCust, plan: fixedPlan, branchId, startDate: preStart });
  s = await payInstallments(ctx, s, 5, { backdateFrom: preStart });
  const preWait = await openRedemption(ctx, s._id, ClosureType.PREMATURE_CLOSURE, RedemptionMode.GOLD_HANDOVER);
  await transitionRedemption({ ...ctx, params: { redemptionId: preWait._id }, body: {} }, "approve");
  summary.push({
    customer: preWaitCust.name,
    enrollment: s.enrollmentNumber,
    story: "FIX · PREMATURE · approved · awaiting completion",
  });

  const rejectedCust = nextCustomer();
  s = await seedMatureFixedGold(ctx, {
    customer: rejectedCust,
    plan: fixedPlan,
    branchId,
    startDate: matureStart,
    label: "redemption rejected",
  });
  const rej = await openRedemption(
    ctx,
    s._id,
    ClosureType.MATURITY_REDEMPTION,
    RedemptionMode.PURCHASE_ADJUSTMENT,
  );
  await transitionRedemption(
    { ...ctx, params: { redemptionId: rej._id }, body: { reason: "Customer postponed visit" } },
    "reject",
  );
  summary.push({
    customer: rejectedCust.name,
    enrollment: s.enrollmentNumber,
    story: "FIX · MATURED · redemption rejected · can retry",
  });

  logStep("flexible schemes (free phase → lock → mature)");
  // —— Flexible gold (RITU18FLEX) ——
  const flexNewCust = nextCustomer();
  await enrol({
    ...ctx,
    body: {
      customerId: flexNewCust._id,
      planId: flexPlan._id,
      branchId,
      startDate: today(),
      installmentAmountPaise: 100_000,
      firstInstallmentMode: "START_NEXT_CYCLE",
    },
  });
  summary.push({ customer: flexNewCust.name, story: "FLEX · ACTIVE · free phase · 0 contributions" });

  const flexEarlyCust = nextCustomer();
  const flexEarlyStart = addMonthsClamped(today(), -2).format("YYYY-MM-DD");
  let flex = await createFlexibleScheme(ctx, {
    customer: flexEarlyCust,
    plan: flexPlan,
    branchId,
    startDate: flexEarlyStart,
  });
  const [c1] = flexCycleKeys(flex, 1);
  flex = await recordFlexPayment(ctx, flex._id, 150_000, c1);
  flex = await recordFlexPayment(ctx, flex._id, 100_000, c1);
  summary.push({
    customer: flexEarlyCust.name,
    enrollment: flex.enrollmentNumber,
    story: "FLEX · free phase started · multiple payments",
  });

  const flexMidCust = nextCustomer();
  const flexMidStart = addMonthsClamped(today(), -9).format("YYYY-MM-DD");
  flex = await createFlexibleScheme(ctx, {
    customer: flexMidCust,
    plan: flexPlan,
    branchId,
    startDate: flexMidStart,
  });
  for (const cycle of flexCycleKeys(flex, 6)) {
    flex = await recordFlexPayment(ctx, flex._id, 200_000, cycle);
  }
  summary.push({
    customer: flexMidCust.name,
    enrollment: flex.enrollmentNumber,
    story: "FLEX · free phase mid · savings across 6 cycles",
  });

  // Long enough back that all 18 free cycles (incl. grace) have ended before lock.
  const flexLockStart = addMonthsClamped(today(), -22).format("YYYY-MM-DD");
  const flexLockCust = nextCustomer();
  flex = await seedFlexLocked(ctx, {
    customer: flexLockCust,
    plan: flexPlan,
    branchId,
    startDate: flexLockStart,
    perCyclePaise: 100_000,
    capPayPaise: 50_000,
  });
  summary.push({
    customer: flexLockCust.name,
    enrollment: flex.enrollmentNumber,
    story: "FLEX · LOCKED capped phase · partial cap payment",
  });

  const flexCapDoneCust = nextCustomer();
  flex = await seedFlexLocked(ctx, {
    customer: flexCapDoneCust,
    plan: flexPlan,
    branchId,
    startDate: flexLockStart,
    perCyclePaise: 120_000,
    capPayPaise: 0,
  });
  const freeCycles = flexPlan.flexibleRules.flexiblePhaseCycles;
  const cappedCycle = firstCappedCycleKey(flex, freeCycles);
  const capRow = flex.cycles.find((row) => row.cycle === cappedCycle);
  if (capRow && capRow.capPaise > capRow.paidPaise) {
    flex = await payCappedCycle(
      ctx,
      flex._id,
      capRow.capPaise - capRow.paidPaise,
      cappedCycle,
      `${cappedCycle}-15`,
    );
  }
  await recomputeSchemeStatuses(flex._id);
  flex = await Scheme.findById(flex._id);
  if (flex.status !== SchemeStatus.MATURED) {
    await markMatured(flex._id);
    flex = await Scheme.findById(flex._id);
  }
  summary.push({
    customer: flexCapDoneCust.name,
    enrollment: flex.enrollmentNumber,
    story: "FLEX · capped complete · MATURED",
  });

  const flexRedCust = nextCustomer();
  flex = await seedFlexLocked(ctx, {
    customer: flexRedCust,
    plan: flexPlan,
    branchId,
    startDate: flexLockStart,
    perCyclePaise: 100_000,
    capPayPaise: 0,
  });
  const cap2 = flex.cycles.find((row) => row.cycle === cappedCycle);
  if (cap2 && cap2.capPaise > cap2.paidPaise) {
    await payCappedCycle(ctx, flex._id, cap2.capPaise - cap2.paidPaise, cappedCycle, `${cappedCycle}-15`);
  }
  await recomputeSchemeStatuses(flex._id);
  await markMatured(flex._id);
  flex = await Scheme.findById(flex._id);
  const flexRed = await openRedemption(
    ctx,
    flex._id,
    ClosureType.MATURITY_REDEMPTION,
    RedemptionMode.GOLD_HANDOVER,
  );
  summary.push({
    customer: flexRedCust.name,
    enrollment: flex.enrollmentNumber,
    story: `FLEX · MATURED · redemption ${flexRed.status}`,
  });

  const flexPreCust = nextCustomer();
  flex = await createFlexibleScheme(ctx, {
    customer: flexPreCust,
    plan: flexPlan,
    branchId,
    startDate: addMonthsClamped(today(), -12).format("YYYY-MM-DD"),
  });
  for (const cycle of flexCycleKeys(flex, 4)) {
    flex = await recordFlexPayment(ctx, flex._id, 180_000, cycle);
  }
  const flexPre = await openRedemption(
    ctx,
    flex._id,
    ClosureType.PREMATURE_CLOSURE,
    RedemptionMode.PURCHASE_ADJUSTMENT,
  );
  await transitionRedemption({ ...ctx, params: { redemptionId: flexPre._id }, body: {} }, "approve");
  summary.push({
    customer: flexPreCust.name,
    enrollment: flex.enrollmentNumber,
    story: "FLEX · PREMATURE · approved closure (still in free phase)",
  });

  return summary;
}
