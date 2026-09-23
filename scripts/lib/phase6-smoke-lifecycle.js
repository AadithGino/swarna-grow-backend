/**
 * Phase 6 disposable DB — persisted lifecycle smoke (not preview-only).
 */
import { randomUUID } from "node:crypto";
import dayjs from "dayjs";
import request from "supertest";
import {
  ClosureType,
  FirstInstallmentAction,
  FirstInstallmentMode,
  FlexiblePhase,
  LedgerEntryType,
  LinkStatus,
  PaymentIntentStatus,
  PaymentMode,
  PaymentStatus,
  RedemptionMode,
  RedemptionStatus,
  SchemeStatus,
  ValueBasis,
} from "../../src/constants/enums.js";
import { buildFlexibleSchemeCycleRows } from "../../src/lib/calendar-cycle.js";
import { phonePeProvider } from "../../src/integrations/phonepe.provider.js";
import { createId } from "../../src/lib/ids.js";
import { today } from "../../src/lib/date.js";
import {
  AuditEvent,
  Alert,
  Customer,
  GoldRate,
  LedgerEntry,
  Message,
  OutboxEvent,
  Payment,
  PaymentIntent,
  PaymentLink,
  Redemption,
  Scheme,
} from "../../src/models/index.js";
import {
  finalizeGatewaySuccess,
  GatewayFinalizeOutcome,
} from "../../src/services/finalize-gateway-success.service.js";
import { createPlan } from "../../src/services/plan.service.js";
import { createPaymentLink, recordPayment } from "../../src/services/payment.service.js";
import {
  initiateRedemption,
  settlementPreview,
  transitionRedemption,
} from "../../src/services/redemption.service.js";
import { runMaturityTransitionBatch } from "../../src/services/scheme-maintenance.service.js";
import { applyFlexibleLock, enrol } from "../../src/services/scheme.service.js";
import { setGoldRate } from "../../src/services/tenant.service.js";

const FLEX_LOCK_RULES = {
  flexiblePhaseCycles: 2,
  cappedPhaseCycles: 3,
  averagingDivisor: 2,
  flexiblePhase: { minTotalPaise: 100_000 },
  capComputation: {
    formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
    roundToNearestPaise: 1000,
    minCycleCapPaise: 20_000,
    maxCycleCapPaise: 500_000,
    onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
    onBelowMinimumTotal: "CLOSE_SCHEME",
  },
};

const SYSTEM_CLOSE_RULES = {
  ...FLEX_LOCK_RULES,
  flexiblePhase: { minTotalPaise: 100_000 },
  capComputation: {
    ...FLEX_LOCK_RULES.capComputation,
    onBelowMinimumTotal: "CLOSE_SCHEME",
  },
};

const SYSTEM_PLAN_BENEFIT = {
  type: "FIXED_BONUS_AMOUNT",
  bonusBasis: "FLAT",
  bonusValue: 40_000,
  eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
};

const SYSTEM_PLAN_PENALTY_RULES = {
  prematureClosureAllowed: true,
  lockInMonths: 0,
  allowedModes: [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER, RedemptionMode.PURCHASE_ADJUSTMENT],
  prematurePenalty: { mode: "FLAT", flatPaise: 25_000, benefitTreatment: "FULL" },
};

function internalPayOverride(referenceDate) {
  return { referenceDate, internalReferenceDateOverride: true };
}

function staffRedemptionReq(ctx, schemeId, body = {}) {
  return {
    auth: { id: ctx.user._id, tenantId: ctx.tenant._id, type: "TENANT_USER" },
    tenant: ctx.tenant,
    scope: { tenantId: ctx.tenant._id, branchId: ctx.branch._id },
    params: { schemeId },
    body,
    query: body.mode ? { mode: body.mode } : {},
    headers: { "user-agent": "phase6-smoke" },
    ip: "127.0.0.1",
    baseUrl: "/api/v1/admin",
  };
}

async function createFlexScheme(ctx, { rules, startDate, suffix, redemptionRules, benefit }) {
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    customerNumber: `P6${suffix}${Date.now().toString().slice(-5)}`,
    name: `P6 ${suffix}`,
    mobile: `+9198${Date.now().toString().slice(-8)}`,
  });
  const duration = (rules.flexiblePhaseCycles ?? 2) + (rules.cappedPhaseCycles ?? 3);
  const cycles = buildFlexibleSchemeCycleRows({
    startDate,
    durationMonths: duration,
    firstInstallmentMode: "COLLECT_NOW",
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: `P6-${suffix}-${Date.now().toString().slice(-6)}`,
    planSnapshot: {
      paymentPattern: "FLEXIBLE",
      flexibleRules: rules,
      redemptionRules: redemptionRules ?? {
        prematureClosureAllowed: true,
        lockInMonths: 0,
        allowedModes: [RedemptionMode.CASH],
        prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      },
      benefit: benefit ?? { type: "TEXT_ONLY", displayLabel: "Smoke" },
    },
    valueBasis: ValueBasis.CASH,
    paymentPattern: "FLEXIBLE",
    flexiblePhase: FlexiblePhase.FLEXIBLE,
    status: SchemeStatus.ACTIVE,
    startDate,
    maturityDate: cycles.at(-1).expiresAt.slice(0, 10),
    cycles,
    positionVersion: 0,
    version: 1,
    createdBy: ctx.user._id,
  });
  return { scheme, customer, cycles };
}

async function payFlex(ctx, scheme, { cycle, amountPaise }) {
  const doc = await Scheme.findById(scheme._id).lean();
  await recordPayment(
    {
      auth: { id: ctx.user._id, tenantId: ctx.tenant._id, type: "TENANT_USER" },
      tenant: ctx.tenant,
      scope: { tenantId: ctx.tenant._id, branchId: ctx.branch._id },
      baseUrl: "/api/v1/admin",
      body: {
        schemeId: scheme._id,
        amountPaise,
        mode: PaymentMode.CASH,
        targetCycle: cycle,
        expectedPositionVersion: doc.positionVersion ?? 0,
      },
      query: { targetCycle: cycle },
      headers: { "user-agent": "phase6-smoke" },
      ip: "127.0.0.1",
    },
    internalPayOverride(`${cycle}-15`),
  );
}

export async function smokeActualFlexibleLock(ctx) {
  const startDate = "2020-01-01";
  const { scheme, cycles } = await createFlexScheme(ctx, {
    rules: FLEX_LOCK_RULES,
    startDate,
    suffix: "LOCK",
  });
  const [c1, c2] = cycles.map((row) => row.cycle);
  await payFlex(ctx, scheme, { cycle: c1, amountPaise: 80_000 });
  await payFlex(ctx, scheme, { cycle: c2, amountPaise: 40_000 });
  const lockReq = {
    auth: { id: ctx.user._id, tenantId: ctx.tenant._id, type: "TENANT_USER" },
    scope: { tenantId: ctx.tenant._id, branchId: ctx.branch._id },
    baseUrl: "/api/v1/admin",
    params: { schemeId: scheme._id },
    headers: { "user-agent": "phase6-smoke" },
    ip: "127.0.0.1",
  };
  const locked = await applyFlexibleLock(lockReq, { referenceDate: "2020-03-01" });
  if (locked.status !== SchemeStatus.LOCKED) {
    throw new Error(`Expected LOCKED after flex lock, got ${locked.status}`);
  }
  if (locked.flexiblePhase !== FlexiblePhase.CAPPED) {
    throw new Error(`Expected flexiblePhase CAPPED, got ${locked.flexiblePhase}`);
  }
  if (!(locked.lockedAveragePaise > 0)) {
    throw new Error("lockedAveragePaise not persisted");
  }
  const persisted = await Scheme.findById(scheme._id).lean();
  const cappedWithCap = (persisted.cycles ?? []).filter((row) => row.capPaise > 0);
  if (cappedWithCap.length < 1) {
    throw new Error("Capped cycles missing capPaise after lock");
  }
  const audit = await AuditEvent.countDocuments({
    tenantId: ctx.tenant._id,
    entityId: scheme._id,
    action: "FLEXIBLE_LOCK_APPLIED",
  });
  if (audit < 1) throw new Error("Missing FLEXIBLE_LOCK_APPLIED audit");
  const outbox = await OutboxEvent.countDocuments({
    tenantId: ctx.tenant._id,
    $or: [
      { key: { $regex: scheme._id } },
      { topic: { $regex: /flex|scheme/i } },
    ],
  });
  if (outbox < 1) throw new Error("Missing outbox after flex lock");
  await applyFlexibleLock(lockReq, { referenceDate: "2020-03-01" }).then(
    () => { throw new Error("Repeat lock should have been rejected"); },
    (error) => {
      if (error.code !== "LOCK_ALREADY_APPLIED") throw error;
    },
  );
  console.log(`Smoke: flexible lock persisted — enrollment ${persisted.enrollmentNumber}, cap=${locked.lockedAveragePaise}`);
  return { schemeId: scheme._id, lockedAveragePaise: locked.lockedAveragePaise };
}

export async function smokeSystemPolicyCompletion(ctx) {
  const startDate = "2020-01-01";
  const { scheme, cycles } = await createFlexScheme(ctx, {
    rules: SYSTEM_CLOSE_RULES,
    startDate,
    suffix: "SYSPOL",
    redemptionRules: SYSTEM_PLAN_PENALTY_RULES,
    benefit: SYSTEM_PLAN_BENEFIT,
  });
  const flexCycle = cycles[0].cycle;
  await payFlex(ctx, scheme, { cycle: flexCycle, amountPaise: 60_000 });
  const lockReq = {
    auth: { id: ctx.user._id, tenantId: ctx.tenant._id, type: "TENANT_USER" },
    scope: { tenantId: ctx.tenant._id, branchId: ctx.branch._id },
    baseUrl: "/api/v1/admin",
    params: { schemeId: scheme._id },
    headers: { "user-agent": "phase6-smoke" },
    ip: "127.0.0.1",
  };
  await applyFlexibleLock(lockReq, { referenceDate: "2020-03-01" });
  let closed = await Scheme.findById(scheme._id).lean();
  if (closed.status !== SchemeStatus.CLOSED_PREMATURE) {
    throw new Error(`Expected CLOSED_PREMATURE, got ${closed.status}`);
  }
  if (!closed.settlementRequired) {
    throw new Error("Expected settlementRequired=true after system-policy closure");
  }
  const preview = await settlementPreview(
    staffRedemptionReq(ctx, scheme._id, { mode: RedemptionMode.CASH }),
    ClosureType.PREMATURE_CLOSURE,
  );
  if (preview.benefitPaise !== 0 || preview.penaltyPaise !== 0) {
    throw new Error("System-policy preview must zero benefit and penalty");
  }
  const initiated = await initiateRedemption(
    staffRedemptionReq(ctx, scheme._id, {
      mode: RedemptionMode.CASH,
      expectedVersion: closed.version,
    }),
    ClosureType.PREMATURE_CLOSURE,
  );
  const redemptionId = initiated._id ?? initiated.id;
  if ([RedemptionStatus.REQUESTED, RedemptionStatus.PENDING_APPROVAL].includes(initiated.status)) {
    await transitionRedemption(
      { ...staffRedemptionReq(ctx, scheme._id), params: { redemptionId } },
      "approve",
    );
  }
  await transitionRedemption(
    { ...staffRedemptionReq(ctx, scheme._id), params: { redemptionId } },
    "complete",
  );
  closed = await Scheme.findById(scheme._id).lean();
  if (closed.settlementRequired) throw new Error("settlementRequired still true after completion");
  if (!closed.settlementCompletedAt) throw new Error("settlementCompletedAt missing");
  const ledgers = await LedgerEntry.find({ schemeId: scheme._id }).lean();
  if (ledgers.filter((r) => r.type === LedgerEntryType.REDEMPTION_DEBIT).length !== 1) {
    throw new Error("Expected exactly one REDEMPTION_DEBIT");
  }
  if (ledgers.some((r) => r.type === LedgerEntryType.BENEFIT_CREDIT || r.type === LedgerEntryType.CLOSURE_PENALTY)) {
    throw new Error("Unexpected BENEFIT_CREDIT or CLOSURE_PENALTY on system-policy completion");
  }
  const ledgerCount = ledgers.length;
  await transitionRedemption(
    { ...staffRedemptionReq(ctx, scheme._id), params: { redemptionId } },
    "complete",
  ).then(
    () => { throw new Error("Replay complete should fail"); },
    (error) => {
      if (error.code !== "REDEMPTION_STATUS_INVALID") throw error;
    },
  );
  if ((await LedgerEntry.countDocuments({ schemeId: scheme._id })) !== ledgerCount) {
    throw new Error("Replay created extra ledger rows");
  }
  console.log(`Smoke: system-policy settlement completed — scheme ${closed.enrollmentNumber}, settlementPaise=${preview.settlementPaise}`);
}

export async function smokeMaturityTransition(ctx) {
  const maturityDate = dayjs(today()).subtract(1, "day").format("YYYY-MM-DD");
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    customerNumber: `P6MAT${Date.now().toString().slice(-5)}`,
    name: "P6 Maturity",
    mobile: `+9195${Date.now().toString().slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: `P6-MAT-${Date.now().toString().slice(-6)}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      redemptionRules: { allowedModes: [RedemptionMode.CASH], prematureClosureAllowed: false },
    },
    valueBasis: ValueBasis.CASH,
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: dayjs(maturityDate).subtract(11, "month").format("YYYY-MM-DD"),
    maturityDate,
    installmentAmountPaise: 100_000,
    installments: Array.from({ length: 12 }, (_, index) => ({
      number: index + 1,
      dueDate: dayjs(maturityDate).subtract(11 - index, "month").format("YYYY-MM-DD"),
      amountPaise: 100_000,
      paidPaise: 100_000,
      status: "PAID",
      graceEndsAt: dayjs(maturityDate).subtract(11 - index, "month").add(4, "day").format("YYYY-MM-DD"),
    })),
    version: 1,
    createdBy: ctx.user._id,
  });
  const runDay = today();
  const first = await runMaturityTransitionBatch({ today: runDay });
  if (first.processed < 1) throw new Error("Maturity batch did not transition scheme");
  const matured = await Scheme.findById(scheme._id).lean();
  if (matured.status !== SchemeStatus.MATURED) throw new Error(`Expected MATURED, got ${matured.status}`);
  const msgCount = await Message.countDocuments({
    tenantId: ctx.tenant._id,
    schemeId: scheme._id,
    type: "SCHEME_MATURED",
  });
  const second = await runMaturityTransitionBatch({ today: runDay });
  if (second.processed !== 0) throw new Error("Second maturity batch should process 0");
  const msgCount2 = await Message.countDocuments({
    tenantId: ctx.tenant._id,
    schemeId: scheme._id,
    type: "SCHEME_MATURED",
  });
  if (msgCount2 > msgCount + 1) throw new Error("Duplicate maturity notifications");
  console.log(`Smoke: maturity transition — ${matured.enrollmentNumber} MATURED (messages=${msgCount2})`);
  return scheme._id;
}

async function seedMaturedCashScheme(ctx, { suffix, redemptionRules, paidPaise = 300_000 }) {
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    customerNumber: `P6R${suffix}${Date.now().toString().slice(-4)}`,
    name: `Redeem ${suffix}`,
    mobile: `+9194${Date.now().toString().slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: `P6-R-${suffix}-${Date.now().toString().slice(-5)}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis: ValueBasis.CASH,
      redemptionRules,
      benefit: { type: "TEXT_ONLY", displayLabel: "Smoke" },
    },
    valueBasis: ValueBasis.CASH,
    paymentPattern: "FIXED",
    status: SchemeStatus.MATURED,
    startDate: "2024-01-01",
    maturityDate: dayjs(today()).subtract(7, "day").format("YYYY-MM-DD"),
    installmentAmountPaise: paidPaise,
    installments: [],
    version: 1,
    createdBy: ctx.user._id,
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    sequence: 1,
    amountPaise: paidPaise,
    actorType: "USER",
    actorId: ctx.user._id,
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  return scheme;
}

async function approveAndCompleteRedemption(ctx, schemeId, redemptionId) {
  const row = await Redemption.findById(redemptionId).lean();
  if (row.status !== RedemptionStatus.APPROVED && row.status !== RedemptionStatus.COMPLETED) {
    await transitionRedemption(
      { ...staffRedemptionReq(ctx, schemeId), params: { redemptionId } },
      "approve",
    );
  }
  await transitionRedemption(
    { ...staffRedemptionReq(ctx, schemeId), params: { redemptionId } },
    "complete",
  );
}

export async function smokeRedemptionCashComplete(ctx) {
  const scheme = await seedMaturedCashScheme(ctx, {
    suffix: "CASH",
    redemptionRules: { allowedModes: [RedemptionMode.CASH], prematureClosureAllowed: false },
  });
  const initiated = await initiateRedemption(
    staffRedemptionReq(ctx, scheme._id, { mode: RedemptionMode.CASH, expectedVersion: scheme.version }),
    ClosureType.MATURITY_REDEMPTION,
  );
  await approveAndCompleteRedemption(ctx, scheme._id, initiated._id);
  const redemption = await Redemption.findById(initiated._id).lean();
  if (redemption.status !== RedemptionStatus.COMPLETED) throw new Error("CASH redemption not COMPLETED");
  if (!(redemption.cashOutPaise > 0)) throw new Error("cashOutPaise missing on CASH redemption");
  const after = await Scheme.findById(scheme._id).lean();
  if (after.status !== SchemeStatus.REDEEMED) throw new Error(`Expected REDEEMED, got ${after.status}`);
  console.log(`Smoke: CASH redemption completed — cashOutPaise=${redemption.cashOutPaise}`);
}

export async function smokeRedemptionGoldHandoverComplete(ctx) {
  const rateDay = today();
  await setGoldRate({
    auth: { id: ctx.user._id, tenantId: ctx.tenant._id },
    headers: { "user-agent": "phase6-smoke" },
    body: { effectiveDate: rateDay, ratePerGramPaise: 725_000, branchId: ctx.branch._id },
  });
  const scheme = await seedMaturedCashScheme(ctx, {
    suffix: "GH",
    paidPaise: 250_000,
    redemptionRules: {
      allowedModes: [RedemptionMode.GOLD_HANDOVER, RedemptionMode.CASH],
      prematureClosureAllowed: false,
    },
  });
  const preview = await settlementPreview(
    staffRedemptionReq(ctx, scheme._id, { mode: RedemptionMode.GOLD_HANDOVER }),
    ClosureType.MATURITY_REDEMPTION,
  );
  const initiated = await initiateRedemption(
    staffRedemptionReq(ctx, scheme._id, {
      mode: RedemptionMode.GOLD_HANDOVER,
      expectedVersion: scheme.version,
      modeDetails: { expectedFinalValuePaise: preview.settlementPaise },
    }),
    ClosureType.MATURITY_REDEMPTION,
  );
  await approveAndCompleteRedemption(ctx, scheme._id, initiated._id);
  const redemption = await Redemption.findById(initiated._id).lean();
  if (redemption.mode !== RedemptionMode.GOLD_HANDOVER) throw new Error("Wrong redemption mode");
  if (redemption.cashOutPaise !== 0 && redemption.cashOutPaise != null) {
    throw new Error(`Expected zero cash payout, got ${redemption.cashOutPaise}`);
  }
  if (!(redemption.weightMg > 0)) throw new Error("handover weightMg missing");
  const rate = await GoldRate.findOne({ tenantId: ctx.tenant._id, purity: "22K", effectiveDate: rateDay }).lean();
  if (!rate) throw new Error("22K rate missing for completion day");
  console.log(`Smoke: GOLD_HANDOVER completed — weightMg=${redemption.weightMg}, rateDay=${rateDay}`);
}

export async function smokeRedemptionPurchaseAdjustmentComplete(ctx) {
  const billNumber = `BILL-P6-${Date.now()}`;
  const scheme = await seedMaturedCashScheme(ctx, {
    suffix: "PA",
    redemptionRules: {
      allowedModes: [RedemptionMode.PURCHASE_ADJUSTMENT, RedemptionMode.CASH],
      prematureClosureAllowed: false,
    },
  });
  const preview = await settlementPreview(
    staffRedemptionReq(ctx, scheme._id, {
      mode: RedemptionMode.PURCHASE_ADJUSTMENT,
      modeDetails: { billNumber },
    }),
    ClosureType.MATURITY_REDEMPTION,
  );
  const initiated = await initiateRedemption(
    staffRedemptionReq(ctx, scheme._id, {
      mode: RedemptionMode.PURCHASE_ADJUSTMENT,
      expectedVersion: scheme.version,
      modeDetails: {
        billNumber,
        expectedFinalValuePaise: preview.settlementPaise,
      },
    }),
    ClosureType.MATURITY_REDEMPTION,
  );
  await approveAndCompleteRedemption(ctx, scheme._id, initiated._id);
  const redemption = await Redemption.findById(initiated._id).lean();
  if (redemption.mode !== RedemptionMode.PURCHASE_ADJUSTMENT) throw new Error("Wrong mode");
  if (redemption.cashOutPaise !== 0 && redemption.cashOutPaise != null) {
    throw new Error("Purchase adjustment should have zero cash payout");
  }
  if (String(redemption.modeDetails?.billNumber ?? "") !== billNumber) {
    throw new Error("billNumber not persisted on redemption");
  }
  console.log(`Smoke: PURCHASE_ADJUSTMENT completed — billNumber=${billNumber}`);
}

export async function smokePhonePePersisted(ctx, app, adminReqFactory, scheme) {
  await ctx.tenantPhonePeReady?.();
  const link = await createPaymentLink(adminReqFactory(ctx, {
    body: { schemeId: scheme._id, amountPaise: 50_000, expiresInMinutes: 30 },
  }));
  const original = phonePeProvider.createPayment.bind(phonePeProvider);
  phonePeProvider.createPayment = async () => ({
    orderId: `MOCK-${randomUUID()}`,
    redirectUrl: "http://localhost:5173/pay/return",
    state: "PENDING",
  });
  try {
    const init = await request(app)
      .post(`/api/v1/public/pay/${link.token}/initiate`)
      .set("x-idempotency-key", randomUUID())
      .send({ redirectUrl: "http://localhost:5173/pay/return" })
      .expect(200);
    const paymentId = init.body.data.paymentId;
    const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
    const storedLink = await PaymentLink.findById(link._id ?? link.id).lean();
    const txn = `mock-txn-${paymentId}`;
    await finalizeGatewaySuccess({
      tenantId: ctx.tenant._id,
      reference: intent._id,
      transactionId: txn,
      amountPaise: 50_000,
      providerPayload: { mock: true },
      webhookEventId: `mock-wh-${paymentId}`,
      intent,
      link: storedLink,
      paymentId,
    });
    const payment = await Payment.findById(paymentId).lean();
    if (payment.status !== PaymentStatus.SUCCESS) throw new Error("Payment not SUCCESS");
    const intentAfter = await PaymentIntent.findById(intent._id).lean();
    if (intentAfter.status !== PaymentIntentStatus.SUCCEEDED) {
      throw new Error(`Intent not SUCCEEDED: ${intentAfter.status}`);
    }
    const linkAfter = await PaymentLink.findById(storedLink._id).lean();
    if (linkAfter.status !== LinkStatus.PAID) throw new Error(`Link not PAID: ${linkAfter.status}`);
    const ledgerForPayment = await LedgerEntry.countDocuments({ schemeId: scheme._id, paymentId });
    if (ledgerForPayment !== 1) throw new Error(`Expected 1 ledger for gateway payment, got ${ledgerForPayment}`);
    const replay = await finalizeGatewaySuccess({
      tenantId: ctx.tenant._id,
      reference: intent._id,
      transactionId: txn,
      amountPaise: 50_000,
      providerPayload: { mock: true },
      webhookEventId: `mock-wh-replay-${paymentId}`,
      intent,
      link: storedLink,
      paymentId,
    });
    if (replay.outcome !== GatewayFinalizeOutcome.ALREADY_SUCCESS) {
      throw new Error(`Replay outcome expected ALREADY_SUCCESS, got ${replay.outcome}`);
    }
    if ((await LedgerEntry.countDocuments({ schemeId: scheme._id, paymentId })) !== 1) {
      throw new Error("Replay created duplicate ledger");
    }
    console.log("Smoke: PhonePe persisted SUCCESS + idempotent replay — OK");
  } finally {
    phonePeProvider.createPayment = original;
  }
}

export async function smokeFixedEnrolAndManual(ctx, adminReqFactory) {
  const planCode = `P6FIX${Date.now().toString().slice(-6)}`;
  const plan = await createPlan(adminReqFactory(ctx, {
    body: {
      name: "Phase6 Fixed Smoke",
      code: planCode,
      valueBasis: ValueBasis.CASH,
      paymentPattern: "FIXED",
      durationMonths: 11,
      installmentCount: 11,
      amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 100_000 },
      scheduleRules: {
        dueDateRule: "JOIN_ANNIVERSARY",
        firstInstallmentModeDefault: FirstInstallmentMode.COLLECT_NOW,
      },
      paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 10_000 },
      redemptionRules: {
        prematureClosureAllowed: false,
        lockInMonths: 0,
        prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
        allowedModes: [RedemptionMode.CASH],
        redeemAtAnyBranch: false,
      },
      availability: { allBranches: true, branchIds: [], visibleInCustomerApp: false, customerSelfEnrolAllowed: false },
      benefit: {
        type: "TEXT_ONLY",
        displayLabel: "Smoke",
        eligibility: { requireAllInstallmentsPaid: false, maxAllowedDefaults: 99, minMonthsCompleted: 0 },
      },
      status: "ACTIVE",
    },
  }));
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    customerNumber: `P6C${Date.now().toString().slice(-6)}`,
    name: "Phase6 Fixed",
    mobile: `+9199${Date.now().toString().slice(-8)}`,
  });
  const scheme = await enrol(adminReqFactory(ctx, {
    body: {
      customerId: customer._id,
      planId: plan._id,
      firstInstallmentMode: FirstInstallmentMode.COLLECT_NOW,
      firstInstallmentAction: FirstInstallmentAction.RECORD_MANUAL_PAYMENT,
      payment: { amountPaise: 100_000, mode: PaymentMode.CASH },
    },
  }));
  if (scheme.status !== SchemeStatus.ACTIVE) throw new Error(`Expected ACTIVE, got ${scheme.status}`);
  const refreshed = await Scheme.findById(scheme._id).lean();
  await recordPayment(adminReqFactory(ctx, {
    body: {
      schemeId: scheme._id,
      amountPaise: 10_000,
      mode: PaymentMode.UPI,
      expectedVersion: refreshed.version,
    },
  }));
  console.log("Smoke: fixed plan, first-payment activation, manual payment — OK");
  return scheme;
}

export async function verifyFinalSmokeInvariants(ctx) {
  const db = ctx.tenant._id;
  const dupes = await LedgerEntry.aggregate([
    { $match: { tenantId: db } },
    { $group: { _id: { schemeId: "$schemeId", sequence: "$sequence" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 3 },
  ]);
  if (dupes.length) throw new Error(`Duplicate ledger sequences: ${JSON.stringify(dupes)}`);
  const badPayments = await Payment.countDocuments({
    tenantId: db,
    status: { $in: ["UNALLOCATED_PENDING_REVIEW", "AMOUNT_MISMATCH_PENDING_REVIEW"] },
    receiptNumber: { $regex: /^P6-/ },
  });
  if (badPayments > 0) throw new Error(`Unexpected review-state P6 payments: ${badPayments}`);
  const openAlerts = await Alert.countDocuments({
    tenantId: db,
    status: "OPEN",
    type: { $in: ["GATEWAY_AMOUNT_MISMATCH", "PAYMENT_REVIEW"] },
  });
  if (openAlerts > 0) throw new Error(`Unexpected OPEN financial alerts: ${openAlerts}`);
  const stuckPending = await Payment.countDocuments({
    tenantId: db,
    status: PaymentStatus.PENDING,
    receiptNumber: { $regex: /^RCP-/ },
    createdAt: { $gte: new Date(Date.now() - 3600_000) },
  });
  if (stuckPending > 2) {
    console.log(`Note: ${stuckPending} recent PENDING payments (may include in-flight demo seed)`);
  }
  const stuckSettlement = await Scheme.countDocuments({
    tenantId: db,
    settlementRequired: true,
    settlementCompletedAt: { $ne: null },
  });
  if (stuckSettlement > 0) throw new Error("Schemes with settlementCompletedAt still settlementRequired");
  if (await Payment.countDocuments({ tenantId: db, mode: "CHEQUE" }) > 0) {
    throw new Error("CHEQUE payments present");
  }
  const pendingOutbox = await OutboxEvent.find({ tenantId: db, dispatchState: "PENDING" })
    .select("topic key")
    .limit(20)
    .lean();
  console.log(`Final invariants OK — pending outbox=${pendingOutbox.length}${pendingOutbox.length ? ` (worker processing): ${pendingOutbox.map((r) => r.topic).join(", ")}` : ""}`);
}
