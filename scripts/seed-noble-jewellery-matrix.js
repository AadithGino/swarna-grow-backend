/**
 * Noble Jewellery — fixed gold collection plans only (Swarna / Akshaya / Tritiya).
 * Extends the standard 12-scenario lifecycle matrix with today's collections,
 * approved redemption queue, branch-2 samples, and pending cash handovers.
 */
import dayjs from "dayjs";
import { HandoverInitiator, PaymentStatus, ClosureType, RedemptionMode } from "../src/constants/enums.js";
import { addMonthsClamped, today } from "../src/lib/date.js";
import { Payment, Scheme } from "../src/models/index.js";
import { createHandover } from "../src/services/cash.service.js";
import { recordPayment } from "../src/services/payment.service.js";
import { transitionRedemption } from "../src/services/redemption.service.js";
import {
  createFixedScheme,
  openRedemption,
  payInstallments,
  paymentReq,
  recomputeSchemeStatuses,
  seedCollectionPlanMatrix,
  seedMatureFixedGold,
} from "./seed-aira-gold-matrix.js";

const PER_PLAN_MATRIX = 12;
const PLAN_COUNT = 3;
const EXTRA_COUNT = 14;

function logStep(label) {
  console.log(`[noble-jewellery seed] ${label}…`);
}

function installmentPaise(index) {
  const tiers = [200_000, 250_000, 300_000, 350_000, 500_000];
  return tiers[index % tiers.length];
}

async function stampLatestPaymentToday(schemeId, hourOffset = 0) {
  const payment = await Payment.findOne({ schemeId, status: PaymentStatus.SUCCESS }).sort({ createdAt: -1 });
  if (!payment) return;
  const at = dayjs().hour(9 + hourOffset).minute(20 + (hourOffset % 3) * 10).second(0);
  await Payment.updateOne({ _id: payment._id }, { $set: { paidAt: at.toDate() } });
}

async function seedTodaysCollections(ctx, { plans, branchId, customers }) {
  const summary = [];
  const modes = ["UPI", "CASH", "CARD", "UPI", "CASH", "UPI"];
  for (let i = 0; i < customers.length; i += 1) {
    const customer = customers[i];
    const plan = plans[i % plans.length];
    const n = plan.installmentCount ?? plan.durationMonths;
    const amount = installmentPaise(i + 40);
    const paidBefore = Math.max(1, Math.floor(n / 3) + (i % 2));
    const startDate = addMonthsClamped(today(), -(paidBefore + 1)).format("YYYY-MM-DD");
    let scheme = await createFixedScheme(ctx, {
      customer,
      plan,
      branchId,
      startDate,
      installmentAmountPaise: amount,
    });
    scheme = await payInstallments(ctx, scheme, paidBefore, {
      backdateFrom: startDate,
      amountPaise: amount,
      mode: i % 2 === 0 ? "CASH" : "UPI",
    });
    let doc = await Scheme.findById(scheme._id);
    await recordPayment(
      paymentReq(ctx, doc._id, {
        amountPaise: amount,
        mode: modes[i],
        expectedVersion: doc.version,
      }),
    );
    await stampLatestPaymentToday(scheme._id, i);
    await recomputeSchemeStatuses(scheme._id);
    doc = await Scheme.findById(scheme._id);
    summary.push({
      customer: customer.name,
      enrollment: doc.enrollmentNumber,
      story: `TODAY · ${plan.code} · collection via ${modes[i]} (${paidBefore + 1}/${n})`,
    });
  }
  return summary;
}

async function seedApprovedRedemptionQueue(ctx, { plan, branchId, customers }) {
  const summary = [];
  const matureStart = addMonthsClamped(today(), -(plan.durationMonths + 2)).format("YYYY-MM-DD");
  for (const customer of customers) {
    const amount = installmentPaise(customer.name.length);
    const scheme = await seedMatureFixedGold(ctx, {
      customer,
      plan,
      branchId,
      startDate: matureStart,
      installmentAmountPaise: amount,
    });
    const red = await openRedemption(ctx, scheme._id, ClosureType.MATURITY_REDEMPTION, RedemptionMode.GOLD_HANDOVER);
    await transitionRedemption({ ...ctx, params: { redemptionId: red._id }, body: {} }, "approve");
    summary.push({
      customer: customer.name,
      enrollment: scheme.enrollmentNumber,
      story: `${plan.code} · MATURED · redemption APPROVED (awaiting handover / complete)`,
    });
  }
  return summary;
}

async function seedBranchShowroomSamples(ctx, { plan, branchId, customers, branchLabel }) {
  const summary = [];
  const [activeCust, matureCust, overdueCust, nearCust] = customers;
  const amount = 300_000;

  let start = addMonthsClamped(today(), -3).format("YYYY-MM-DD");
  let s = await createFixedScheme(ctx, { customer: activeCust, plan, branchId, startDate: start, installmentAmountPaise: amount });
  s = await payInstallments(ctx, s, 2, { backdateFrom: start, amountPaise: amount, mode: "CASH" });
  summary.push({
    customer: activeCust.name,
    enrollment: s.enrollmentNumber,
    story: `${branchLabel} · ${plan.code} · ACTIVE · partial paid`,
  });

  s = await seedMatureFixedGold(ctx, {
    customer: matureCust,
    plan,
    branchId,
    startDate: addMonthsClamped(today(), -(plan.durationMonths + 2)).format("YYYY-MM-DD"),
    installmentAmountPaise: amount,
  });
  summary.push({
    customer: matureCust.name,
    enrollment: s.enrollmentNumber,
    story: `${branchLabel} · ${plan.code} · MATURED · redeemable`,
  });

  if (overdueCust) {
    start = addMonthsClamped(today(), -5).format("YYYY-MM-DD");
    s = await createFixedScheme(ctx, { customer: overdueCust, plan, branchId, startDate: start, installmentAmountPaise: amount });
    s = await payInstallments(ctx, s, 1, { backdateFrom: start, amountPaise: amount });
    summary.push({
      customer: overdueCust.name,
      enrollment: s.enrollmentNumber,
      story: `${branchLabel} · ${plan.code} · OVERDUE`,
    });
  }

  if (nearCust) {
    const n = plan.installmentCount ?? plan.durationMonths;
    const nearPaid = Math.max(1, n - 1);
    start = addMonthsClamped(today(), -(nearPaid + 1)).format("YYYY-MM-DD");
    s = await createFixedScheme(ctx, { customer: nearCust, plan, branchId, startDate: start, installmentAmountPaise: amount });
    s = await payInstallments(ctx, s, nearPaid, { backdateFrom: start, amountPaise: amount });
    summary.push({
      customer: nearCust.name,
      enrollment: s.enrollmentNumber,
      story: `${branchLabel} · ${plan.code} · near maturity (${nearPaid}/${n})`,
    });
  }

  return summary;
}

async function seedPurchaseAdjustmentCompleted(ctx, { plan, branchId, customer }) {
  const matureStart = addMonthsClamped(today(), -(plan.durationMonths + 2)).format("YYYY-MM-DD");
  const scheme = await seedMatureFixedGold(ctx, {
    customer,
    plan,
    branchId,
    startDate: matureStart,
    installmentAmountPaise: 400_000,
  });
  const red = await openRedemption(ctx, scheme._id, ClosureType.MATURITY_REDEMPTION, RedemptionMode.PURCHASE_ADJUSTMENT);
  await transitionRedemption({ ...ctx, params: { redemptionId: red._id }, body: {} }, "approve");
  await transitionRedemption({ ...ctx, params: { redemptionId: red._id }, body: {} }, "complete");
  return {
    customer: customer.name,
    enrollment: scheme.enrollmentNumber,
    story: `${plan.code} · REDEEMED · purchase adjustment (bill settled)`,
  };
}

async function seedPendingCashHandover(staffCtx, staffLabel) {
  const row = await createHandover(
    {
      ...staffCtx,
      body: { amountPaise: 45_000, remarks: "Morning counter collections — Noble Jewellery MG Road" },
    },
    HandoverInitiator.STAFF,
  );
  return `Cash control · ${staffLabel} · ₹45,000 handover PENDING (${row._id})`;
}

/**
 * @param {object} ctx
 * @param {{
 *   swarna: object,
 *   akshaya: object,
 *   tritiya: object,
 *   branchMain: object,
 *   branchKochi: object,
 *   customers: object[],
 *   staffCtx?: object,
 *   staffLabel?: string,
 * }} deps
 */
export async function seedNobleJewelleryDemoMatrix(ctx, deps) {
  const { swarna, akshaya, tritiya, branchMain, branchKochi, customers, staffCtx, staffLabel = "Staff" } = deps;
  const matrixNeed = PER_PLAN_MATRIX * PLAN_COUNT;
  const totalNeed = matrixNeed + EXTRA_COUNT;
  if (customers.length < totalNeed) {
    throw new Error(`Need at least ${totalNeed} customers, got ${customers.length}`);
  }

  const summary = [];
  const plans = [swarna, akshaya, tritiya];

  for (const [plan, label, sliceStart] of [
    [swarna, "SWARNA", 0],
    [akshaya, "AKSHAYA", PER_PLAN_MATRIX],
    [tritiya, "TRITIYA", PER_PLAN_MATRIX * 2],
  ]) {
    logStep(`${label} lifecycle matrix`);
    const t0 = Date.now();
    summary.push(
      ...(await seedCollectionPlanMatrix(ctx, {
        plan,
        planLabel: label,
        branchId: branchMain._id,
        customers: customers.slice(sliceStart, sliceStart + PER_PLAN_MATRIX),
        installmentAmountPaise: installmentPaise(sliceStart),
      })),
    );
    console.log(`[noble-jewellery seed] ${label} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  let offset = PER_PLAN_MATRIX * PLAN_COUNT;

  logStep("Today's collections (UPI / card / cash)");
  summary.push(
    ...(await seedTodaysCollections(ctx, {
      plans,
      branchId: branchMain._id,
      customers: customers.slice(offset, offset + 6),
    })),
  );
  offset += 6;

  logStep("Approved redemption queue (not yet completed)");
  summary.push(
    ...(await seedApprovedRedemptionQueue(ctx, {
      plan: akshaya,
      branchId: branchMain._id,
      customers: customers.slice(offset, offset + 2),
    })),
  );
  offset += 2;

  logStep("Purchase adjustment redemptions (completed)");
  summary.push(
    await seedPurchaseAdjustmentCompleted(ctx, {
      plan: swarna,
      branchId: branchMain._id,
      customer: customers[offset],
    }),
  );
  offset += 1;
  summary.push(
    await seedPurchaseAdjustmentCompleted(ctx, {
      plan: tritiya,
      branchId: branchMain._id,
      customer: customers[offset],
    }),
  );
  offset += 1;

  logStep("Kochi branch showroom samples");
  summary.push(
    ...(await seedBranchShowroomSamples(ctx, {
      plan: akshaya,
      branchId: branchKochi._id,
      branchLabel: "KOCHI",
      customers: customers.slice(offset, offset + 4),
    })),
  );
  offset += 4;

  if (offset !== totalNeed) {
    throw new Error(`Customer allocation mismatch: used ${offset}, expected ${totalNeed}`);
  }

  if (staffCtx) {
    logStep("Pending cash handover for Cash control demo");
    try {
      summary.push({ customer: "—", story: await seedPendingCashHandover(staffCtx, staffLabel) });
    } catch (err) {
      summary.push({
        customer: "—",
        story: `Cash handover skipped (${err?.message ?? "insufficient cash in hand"}); CASH collections still in today's rows`,
      });
    }
  }

  return summary;
}
