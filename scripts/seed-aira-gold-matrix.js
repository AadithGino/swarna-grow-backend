/**
 * Aira Gold — demo customers & enrollments across Swarna / Akshaya / Tritiya / upfront plans.
 */
import dayjs from "dayjs";
import {
  ClosureType,
  PaymentStatus,
  RedemptionMode,
  SchemeStatus,
} from "../src/constants/enums.js";
import { addMonthsClamped, today } from "../src/lib/date.js";
import { createId } from "../src/lib/ids.js";
import { LedgerEntry, Payment, Scheme } from "../src/models/index.js";
import { recordPayment } from "../src/services/payment.service.js";
import { buildSchedulePreview } from "../src/services/schedule.service.js";
import { enrol, rebuildSchemeProjection } from "../src/services/scheme.service.js";
import {
  initiateRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { nextSequence } from "../src/services/sequence.service.js";

const DEFAULT_INSTALLMENT_PAISE = 200_000;

function logStep(label) {
  console.log(`[aira-gold seed] ${label}…`);
}

function paymentReq(ctx, schemeId, { amountPaise, mode = "CASH", expectedVersion }) {
  return { ...ctx, body: { schemeId, amountPaise, mode, expectedVersion } };
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

async function createFixedScheme(
  ctx,
  { customer, plan, branchId, startDate, installmentAmountPaise = DEFAULT_INSTALLMENT_PAISE },
) {
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
    installmentAmountPaise,
    installments,
    version: 1,
    createdBy: ctx.auth.id,
  });
}

async function payInstallments(ctx, scheme, count, { mode = "CASH", amountPaise, backdateFrom, useAdvance = true } = {}) {
  let doc = await Scheme.findById(scheme._id);
  const unit = amountPaise ?? doc.installmentAmountPaise;
  let remaining = count;
  while (remaining > 0) {
    const chunk = useAdvance && remaining >= 2 ? Math.min(remaining, 2) : 1;
    await recordPayment(
      paymentReq(ctx, doc._id, {
        amountPaise: unit * chunk,
        mode,
        expectedVersion: doc.version,
      }),
    );
    doc = await Scheme.findById(scheme._id);
    remaining -= chunk;
  }
  if (backdateFrom) {
    const payments = await Payment.find({ schemeId: scheme._id, status: PaymentStatus.SUCCESS }).sort({
      createdAt: 1,
    });
    for (let i = 0; i < payments.length; i += 1) {
      await Payment.updateOne(
        { _id: payments[i]._id },
        { $set: { paidAt: dayjs(backdateFrom).add(i, "month").hour(11).toDate() } },
      );
    }
  }
  await recomputeSchemeStatuses(scheme._id);
  return Scheme.findById(scheme._id);
}

async function markMatured(schemeId) {
  await Scheme.updateOne(
    { _id: schemeId },
    { $set: { status: SchemeStatus.MATURED, maturityDate: dayjs(today()).subtract(7, "day").format("YYYY-MM-DD") } },
  );
}

function redemptionCtx(ctx, schemeId, body = {}) {
  return { ...ctx, params: { schemeId }, body };
}

async function openRedemption(ctx, schemeId, closureType, mode) {
  const scheme = await Scheme.findById(schemeId);
  const preview = await settlementPreview(redemptionCtx(ctx, scheme._id, { mode }), closureType);
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
        ? { billNumber: `AIRA-${scheme.enrollmentNumber}` }
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

async function seedMatureFixedGold(ctx, { customer, plan, branchId, startDate, installmentAmountPaise }) {
  const scheme = await createFixedScheme(ctx, {
    customer,
    plan,
    branchId,
    startDate,
    installmentAmountPaise,
  });
  const n = plan.installmentCount ?? plan.durationMonths;
  await payInstallments(ctx, scheme, n, { backdateFrom: startDate, useAdvance: true, amountPaise: installmentAmountPaise });
  await markMatured(scheme._id);
  return Scheme.findById(scheme._id);
}

/**
 * @param {object} ctx
 * @param {{ plan: object, planLabel: string, branchId: string, customers: object[], installmentAmountPaise?: number }} opts
 */
export async function seedCollectionPlanMatrix(ctx, { plan, planLabel, branchId, customers, installmentAmountPaise = DEFAULT_INSTALLMENT_PAISE }) {
  const summary = [];
  const n = plan.installmentCount ?? plan.durationMonths;
  let i = 0;
  const nextCustomer = () => customers[i++];

  const matureStart = addMonthsClamped(today(), -(n + 2)).format("YYYY-MM-DD");

  const pendingCust = nextCustomer();
  await enrol({
    ...ctx,
    body: {
      customerId: pendingCust._id,
      planId: plan._id,
      branchId,
      startDate: today(),
      installmentAmountPaise,
      firstInstallmentMode: "COLLECT_NOW",
    },
  });
  summary.push({ customer: pendingCust.name, story: `${planLabel} · PENDING_PAYMENT (first collection not paid)` });

  const freshCust = nextCustomer();
  await enrol({
    ...ctx,
    body: {
      customerId: freshCust._id,
      planId: plan._id,
      branchId,
      startDate: today(),
      installmentAmountPaise,
      firstInstallmentMode: "START_NEXT_CYCLE",
    },
  });
  summary.push({ customer: freshCust.name, story: `${planLabel} · ACTIVE · enrolled · 0 collections` });

  const startedCust = nextCustomer();
  const start2 = addMonthsClamped(today(), -Math.min(2, n - 1)).format("YYYY-MM-DD");
  let s = await createFixedScheme(ctx, {
    customer: startedCust,
    plan,
    branchId,
    startDate: start2,
    installmentAmountPaise,
  });
  s = await payInstallments(ctx, s, Math.min(1, n), { backdateFrom: start2, amountPaise: installmentAmountPaise });
  summary.push({
    customer: startedCust.name,
    enrollment: s.enrollmentNumber,
    story: `${planLabel} · ACTIVE · started · partial collections paid`,
  });

  const midCust = nextCustomer();
  const midPaid = Math.max(1, Math.floor(n / 2));
  const startMid = addMonthsClamped(today(), -(midPaid + 1)).format("YYYY-MM-DD");
  s = await createFixedScheme(ctx, { customer: midCust, plan, branchId, startDate: startMid, installmentAmountPaise });
  s = await payInstallments(ctx, s, midPaid, { backdateFrom: startMid, amountPaise: installmentAmountPaise });
  summary.push({
    customer: midCust.name,
    enrollment: s.enrollmentNumber,
    story: `${planLabel} · ACTIVE · mid progress (${midPaid}/${n})`,
  });

  const overdueCust = nextCustomer();
  const startOd = addMonthsClamped(today(), -Math.min(4, n + 1)).format("YYYY-MM-DD");
  s = await createFixedScheme(ctx, { customer: overdueCust, plan, branchId, startDate: startOd, installmentAmountPaise });
  s = await payInstallments(ctx, s, 1, { backdateFrom: startOd, amountPaise: installmentAmountPaise });
  summary.push({
    customer: overdueCust.name,
    enrollment: s.enrollmentNumber,
    story: `${planLabel} · OVERDUE · dues / reminders`,
  });

  const defaultedCust = nextCustomer();
  const defStart = addMonthsClamped(today(), -Math.min(n, 6)).format("YYYY-MM-DD");
  s = await createFixedScheme(ctx, { customer: defaultedCust, plan, branchId, startDate: defStart, installmentAmountPaise });
  s = await payInstallments(ctx, s, 1, { backdateFrom: defStart, amountPaise: installmentAmountPaise });
  await recomputeSchemeStatuses(s._id);
  await Scheme.updateOne({ _id: s._id }, { $set: { status: SchemeStatus.DEFAULTED } });
  s = await Scheme.findById(s._id);
  summary.push({
    customer: defaultedCust.name,
    enrollment: s.enrollmentNumber,
    story: `${planLabel} · DEFAULTED`,
  });

  const nearCust = nextCustomer();
  const nearPaid = Math.max(1, n - 1);
  const startNear = addMonthsClamped(today(), -(nearPaid + 1)).format("YYYY-MM-DD");
  s = await createFixedScheme(ctx, { customer: nearCust, plan, branchId, startDate: startNear, installmentAmountPaise });
  s = await payInstallments(ctx, s, nearPaid, { backdateFrom: startNear, amountPaise: installmentAmountPaise });
  summary.push({
    customer: nearCust.name,
    enrollment: s.enrollmentNumber,
    story: `${planLabel} · ACTIVE · near lock-in completion (${nearPaid}/${n})`,
  });

  const matureCust = nextCustomer();
  s = await seedMatureFixedGold(ctx, {
    customer: matureCust,
    plan,
    branchId,
    startDate: matureStart,
    installmentAmountPaise,
  });
  summary.push({
    customer: matureCust.name,
    enrollment: s.enrollmentNumber,
    story: `${planLabel} · MATURED · bonus pending redemption`,
  });

  const redPendingCust = nextCustomer();
  s = await seedMatureFixedGold(ctx, {
    customer: redPendingCust,
    plan,
    branchId,
    startDate: matureStart,
    installmentAmountPaise,
  });
  const redP = await openRedemption(ctx, s._id, ClosureType.MATURITY_REDEMPTION, RedemptionMode.GOLD_HANDOVER);
  summary.push({
    customer: redPendingCust.name,
    enrollment: s.enrollmentNumber,
    story: `${planLabel} · MATURED · redemption ${redP.status} (approval queue)`,
  });

  const redeemedCust = nextCustomer();
  s = await seedMatureFixedGold(ctx, {
    customer: redeemedCust,
    plan,
    branchId,
    startDate: matureStart,
    installmentAmountPaise,
  });
  const redC = await openRedemption(ctx, s._id, ClosureType.MATURITY_REDEMPTION, RedemptionMode.GOLD_HANDOVER);
  await transitionRedemption({ ...ctx, params: { redemptionId: redC._id }, body: {} }, "approve");
  await transitionRedemption({ ...ctx, params: { redemptionId: redC._id }, body: {} }, "complete");
  summary.push({
    customer: redeemedCust.name,
    enrollment: s.enrollmentNumber,
    story: `${planLabel} · REDEEMED (maturity completed)`,
  });

  const preCloseCust = nextCustomer();
  const lockInMonths = plan.redemptionRules?.lockInMonths ?? n;
  const preStart = addMonthsClamped(today(), -(lockInMonths + 2)).format("YYYY-MM-DD");
  const prePaid = Math.min(2, n - 1);
  s = await createFixedScheme(ctx, { customer: preCloseCust, plan, branchId, startDate: preStart, installmentAmountPaise });
  s = await payInstallments(ctx, s, prePaid, { backdateFrom: preStart, amountPaise: installmentAmountPaise });
  const preRed = await openRedemption(ctx, s._id, ClosureType.PREMATURE_CLOSURE, RedemptionMode.PURCHASE_ADJUSTMENT);
  await transitionRedemption({ ...ctx, params: { redemptionId: preRed._id }, body: {} }, "approve");
  await transitionRedemption({ ...ctx, params: { redemptionId: preRed._id }, body: {} }, "complete");
  summary.push({
    customer: preCloseCust.name,
    enrollment: s.enrollmentNumber,
    story: `${planLabel} · CLOSED_PREMATURE (before lock-in bonus)`,
  });

  const rejCust = nextCustomer();
  s = await seedMatureFixedGold(ctx, {
    customer: rejCust,
    plan,
    branchId,
    startDate: matureStart,
    installmentAmountPaise,
  });
  const rej = await openRedemption(ctx, s._id, ClosureType.MATURITY_REDEMPTION, RedemptionMode.PURCHASE_ADJUSTMENT);
  await transitionRedemption(
    { ...ctx, params: { redemptionId: rej._id }, body: { reason: "Customer postponed visit" } },
    "reject",
  );
  summary.push({
    customer: rejCust.name,
    enrollment: s.enrollmentNumber,
    story: `${planLabel} · MATURED · redemption rejected · can retry`,
  });

  if (i !== customers.length) {
    throw new Error(`${planLabel}: expected ${i} customers, pool had ${customers.length}`);
  }

  return summary;
}

async function seedUpfrontPlanMatrix(ctx, { plan, branchId, customers, installmentAmountPaise = 1_000_000 }) {
  const summary = [];
  let i = 0;
  const nextCustomer = () => customers[i++];

  const pendingCust = nextCustomer();
  await enrol({
    ...ctx,
    body: {
      customerId: pendingCust._id,
      planId: plan._id,
      branchId,
      startDate: today(),
      installmentAmountPaise,
      firstInstallmentMode: "COLLECT_NOW",
    },
  });
  summary.push({ customer: pendingCust.name, story: "UPFRONT · PENDING_PAYMENT (upfront not collected)" });

  const joinedCust = nextCustomer();
  await enrol({
    ...ctx,
    body: {
      customerId: joinedCust._id,
      planId: plan._id,
      branchId,
      startDate: today(),
      installmentAmountPaise,
      firstInstallmentMode: "START_NEXT_CYCLE",
    },
  });
  summary.push({ customer: joinedCust.name, story: "UPFRONT · ACTIVE · enrolled · awaiting upfront payment" });

  const partialCust = nextCustomer();
  const startP = addMonthsClamped(today(), -2).format("YYYY-MM-DD");
  let s = await createFixedScheme(ctx, {
    customer: partialCust,
    plan,
    branchId,
    startDate: startP,
    installmentAmountPaise,
  });
  s = await payInstallments(ctx, s, 1, { backdateFrom: startP, amountPaise: installmentAmountPaise });
  summary.push({
    customer: partialCust.name,
    enrollment: s.enrollmentNumber,
    story: "UPFRONT · ACTIVE · first tranche paid · monthly credits ongoing",
  });

  const advanceCust = nextCustomer();
  s = await createFixedScheme(ctx, {
    customer: advanceCust,
    plan,
    branchId,
    startDate: startP,
    installmentAmountPaise,
  });
  let doc = await Scheme.findById(s._id);
  await recordPayment(
    paymentReq(ctx, doc._id, {
      amountPaise: installmentAmountPaise * 12,
      mode: "CASH",
      expectedVersion: doc.version,
    }),
  );
  await recomputeSchemeStatuses(s._id);
  s = await Scheme.findById(s._id);
  summary.push({
    customer: advanceCust.name,
    enrollment: s.enrollmentNumber,
    story: "UPFRONT · ACTIVE · full year paid upfront (advance)",
  });

  const matureCust = nextCustomer();
  s = await seedMatureFixedGold(ctx, {
    customer: matureCust,
    plan,
    branchId,
    startDate: addMonthsClamped(today(), -14).format("YYYY-MM-DD"),
    installmentAmountPaise,
  });
  summary.push({
    customer: matureCust.name,
    enrollment: s.enrollmentNumber,
    story: "UPFRONT · MATURED · ready for closure / credits complete",
  });

  if (i !== customers.length) {
    throw new Error(`UPFRONT: expected ${i} customers, pool had ${customers.length}`);
  }

  return summary;
}

/**
 * @param {object} ctx
 * @param {{ swarna: object, akshaya: object, tritiya: object, upfront: object, branchId: string, customers: object[] }} deps
 */
export async function seedAiraGoldDemoMatrix(ctx, { swarna, akshaya, tritiya, upfront, branchId, customers }) {
  const perPlan = 12;
  const upfrontCount = 5;
  const need = perPlan * 3 + upfrontCount;
  if (customers.length < need) {
    throw new Error(`Need at least ${need} demo customers, got ${customers.length}`);
  }

  const summary = [];
  let offset = 0;

  logStep("Swarna (3m) lifecycle matrix");
  summary.push(
    ...(await seedCollectionPlanMatrix(ctx, {
      plan: swarna,
      planLabel: "SWARNA",
      branchId,
      customers: customers.slice(offset, offset + perPlan),
    })),
  );
  offset += perPlan;

  logStep("Akshaya (6m) lifecycle matrix");
  summary.push(
    ...(await seedCollectionPlanMatrix(ctx, {
      plan: akshaya,
      planLabel: "AKSHAYA",
      branchId,
      customers: customers.slice(offset, offset + perPlan),
    })),
  );
  offset += perPlan;

  logStep("Tritiya (12m) lifecycle matrix");
  summary.push(
    ...(await seedCollectionPlanMatrix(ctx, {
      plan: tritiya,
      planLabel: "TRITIYA",
      branchId,
      customers: customers.slice(offset, offset + perPlan),
    })),
  );
  offset += perPlan;

  logStep("Upfront investment plan matrix");
  summary.push(
    ...(await seedUpfrontPlanMatrix(ctx, {
      plan: upfront,
      branchId,
      customers: customers.slice(offset, offset + upfrontCount),
    })),
  );

  return summary;
}
