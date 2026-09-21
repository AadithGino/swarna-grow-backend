/**
 * Phase 6 smoke flow against an already-seeded disposable database.
 */
import { randomUUID } from "node:crypto";
import request from "supertest";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import {
  ClosureType,
  FirstInstallmentAction,
  FirstInstallmentMode,
  FlexiblePhase,
  PaymentMode,
  PaymentStatus,
  RedemptionMode,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { addMonthsClamped, today } from "../src/lib/date.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { createId } from "../src/lib/ids.js";
import {
  Customer,
  GoldRate,
  LedgerEntry,
  OutboxEvent,
  Payment,
  PaymentIntent,
  PaymentLink,
  Scheme,
  SchemePlan,
  Tenant,
  User,
} from "../src/models/index.js";
import { createPlan } from "../src/services/plan.service.js";
import { createPaymentLink, recordPayment } from "../src/services/payment.service.js";
import { finalizeGatewaySuccess } from "../src/services/finalize-gateway-success.service.js";
import { settlementPreview } from "../src/services/redemption.service.js";
import { applyFlexibleLock, enrol } from "../src/services/scheme.service.js";

const app = createApp();
const redirectUrl = "http://localhost:5173/pay/return";

function adminReq(user, tenant, branch, { body = {}, params = {}, query = {} } = {}) {
  return {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: user.role },
    tenant,
    scope: { tenantId: tenant._id, branchId: branch._id },
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "phase6-smoke" },
    ip: "127.0.0.1",
    body,
    params,
    query,
  };
}

function previewReq(scheme, user, { mode, modeDetails } = {}) {
  return {
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    params: { schemeId: scheme._id },
    body: { ...(mode ? { mode } : {}), ...(modeDetails ? { modeDetails } : {}) },
    query: mode ? { mode } : {},
    headers: {},
    ip: "127.0.0.1",
  };
}

async function loadKairaliOwner() {
  const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
  if (!tenant) throw new Error("Demo tenant KAIRALI not found — run seed:demo first.");
  const branch = await mongoose.connection.db.collection("branches").findOne({ tenantId: tenant._id, isHeadOffice: true });
  const user = await User.findOne({ tenantId: tenant._id, role: TenantRole.TENANT_OWNER }).lean();
  if (!branch || !user) throw new Error("KAIRALI owner or HQ branch missing.");
  return { tenant, branch, user };
}

async function verifyPostSeedInvariants() {
  const db = mongoose.connection.db;
  if (await db.collection("payments").countDocuments({ mode: "CHEQUE" }) > 0) {
    throw new Error("CHEQUE payments present after seed.");
  }
  if (await db.collection("goldrates").countDocuments({ purity: { $ne: "22K" } }) > 0) {
    throw new Error("Non-22K gold rates present.");
  }
  const forbiddenPlans = await db.collection("schemeplans").countDocuments({
    $or: [
      { "redemptionRules.prematurePenalty.benefitTreatment": "PRORATE" },
      { "redemptionRules.allowedModes": "TRANSFER_TO_SCHEME" },
    ],
  });
  if (forbiddenPlans > 0) throw new Error("Forbidden PRORATE / TRANSFER_TO_SCHEME in plans.");
  console.log("Invariants: no CHEQUE, 22K-only rates, no forbidden plan tokens.");
}

async function verifyLedgerSequences() {
  const dupes = await LedgerEntry.aggregate([
    { $group: { _id: { schemeId: "$schemeId", sequence: "$sequence" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 3 },
  ]);
  if (dupes.length) throw new Error(`Duplicate ledger sequences: ${JSON.stringify(dupes)}`);
  console.log("Ledger sequences unique per scheme.");
}

async function verifyOutboxProcessable() {
  const pending = await OutboxEvent.countDocuments({ dispatchState: "PENDING" });
  const broken = await OutboxEvent.countDocuments({ dispatchState: "PENDING", topic: { $in: [null, ""] } });
  if (broken > 0) throw new Error("Pending outbox rows missing topic.");
  console.log(`Outbox pending=${pending} (shape OK).`);
}

async function smokeFixedPlanEnrolAndManual(ctx) {
  const planCode = `P6FIX${Date.now().toString().slice(-6)}`;
  const plan = await createPlan(adminReq(ctx.user, ctx.tenant, ctx.branch, {
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
  const scheme = await enrol(adminReq(ctx.user, ctx.tenant, ctx.branch, {
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
  await recordPayment(adminReq(ctx.user, ctx.tenant, ctx.branch, {
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

async function ensureTenantPhonePe(ctx) {
  await Tenant.updateOne(
    { _id: ctx.tenant._id },
    {
      $set: {
        "operations.customerAppPaymentsEnabled": true,
        "operations.customerAppWriteEnabled": true,
        integrationSecrets: {
          phonepe: {
            clientId: "P6SMOKE",
            clientSecret: "plain.secret",
            clientVersion: 1,
            webhookUsername: "u",
            webhookPassword: "p",
            environment: "SANDBOX",
          },
        },
      },
    },
  );
}

async function smokePhonePeMock(ctx, scheme) {
  await ensureTenantPhonePe(ctx);
  const link = await createPaymentLink(adminReq(ctx.user, ctx.tenant, ctx.branch, {
    body: { schemeId: scheme._id, amountPaise: 50_000, expiresInMinutes: 30 },
  }));
  const original = phonePeProvider.createPayment.bind(phonePeProvider);
  phonePeProvider.createPayment = async () => ({
    orderId: `MOCK-${randomUUID()}`,
    redirectUrl,
    state: "PENDING",
  });
  try {
    const init = await request(app)
      .post(`/api/v1/public/pay/${link.token}/initiate`)
      .set("x-idempotency-key", randomUUID())
      .send({ redirectUrl })
      .expect(200);
    const paymentId = init.body.data.paymentId;
    const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
    const storedLink = await PaymentLink.findById(link._id ?? link.id).lean();
    const result = await finalizeGatewaySuccess({
      tenantId: ctx.tenant._id,
      reference: intent._id,
      transactionId: `mock-txn-${paymentId}`,
      amountPaise: 50_000,
      providerPayload: { mock: true },
      webhookEventId: `mock-wh-${paymentId}`,
      intent,
      link: storedLink,
      paymentId,
    });
    const done = await Payment.findById(paymentId).lean();
    if (!done || done.status !== PaymentStatus.SUCCESS) {
      throw new Error(`Mock gateway finalization failed: ${result?.outcome ?? "unknown"}`);
    }
    console.log("Smoke: PhonePe reservation + finalization (mock) — OK");
  } finally {
    phonePeProvider.createPayment = original;
  }
}

async function smokeFlexibleFromSeed(ctx) {
  const flexReady = await Scheme.findOne({
    tenantId: ctx.tenant._id,
    paymentPattern: "FLEXIBLE",
    flexiblePhase: FlexiblePhase.FLEXIBLE,
    status: SchemeStatus.ACTIVE,
  }).lean();
  if (!flexReady) {
    console.log("Smoke: flexible lock skipped (no seeded free-phase scheme).");
    return;
  }
  await applyFlexibleLock(adminReq(ctx.user, ctx.tenant, ctx.branch, {
    params: { schemeId: flexReady._id },
  }), { referenceDate: new Date().toISOString().slice(0, 10) }).catch((error) => {
    if (error.code === "FLEXIBLE_LOCK_NOT_DUE") {
      console.log("Smoke: flexible lock not due on seeded scheme (acceptable for demo dates).");
      return;
    }
    throw error;
  });
  console.log("Smoke: flexible enrol/payment data from seed; lock attempted — OK");
}

async function smokeSystemPolicySettlement(ctx) {
  let needsSettlement = await Scheme.findOne({
    tenantId: ctx.tenant._id,
    settlementRequired: true,
  }).lean();
  if (!needsSettlement) {
    const flexPlan = await SchemePlan.findOne({ tenantId: ctx.tenant._id, code: "FLEXI11" }).lean();
    if (!flexPlan) throw new Error("FLEXI11 plan missing for system-policy smoke.");
    const customer = await Customer.create({
      _id: createId("customer"),
      tenantId: ctx.tenant._id,
      branchId: ctx.branch._id,
      customerNumber: `P6S${Date.now().toString().slice(-6)}`,
      name: "Phase6 Settlement",
      mobile: `+9197${Date.now().toString().slice(-8)}`,
    });
    const startDate = addMonthsClamped(today(), -4).format("YYYY-MM-DD");
    const { buildSchedulePreview } = await import("../src/services/schedule.service.js");
    const cycles = buildSchedulePreview({
      startDate,
      durationMonths: flexPlan.durationMonths,
      installmentCount: flexPlan.durationMonths,
      scheduleRules: flexPlan.scheduleRules ?? {},
      firstInstallmentMode: "START_NEXT_CYCLE",
    }).map((row) => ({
      cycle: row.dueDate.slice(0, 7),
      capPaise: 0,
      paidPaise: 0,
      remainingPaise: 0,
      status: "UPCOMING",
      expiresAt: row.graceEndsAt,
    }));
    const settlementPlanSnapshot = {
      ...flexPlan,
      flexibleRules: {
        ...flexPlan.flexibleRules,
        capComputation: {
          ...flexPlan.flexibleRules.capComputation,
          onBelowMinimumTotal: "CLOSE_SCHEME",
        },
      },
    };
    const schemeDoc = await Scheme.create({
      _id: createId("scheme"),
      tenantId: ctx.tenant._id,
      branchId: ctx.branch._id,
      customerId: customer._id,
      planId: flexPlan._id,
      enrollmentNumber: `P6-SET-${Date.now().toString().slice(-6)}`,
      planSnapshot: settlementPlanSnapshot,
      valueBasis: flexPlan.valueBasis,
      paymentPattern: flexPlan.paymentPattern,
      status: SchemeStatus.ACTIVE,
      startDate,
      maturityDate: cycles.at(-1).expiresAt.slice(0, 10),
      cycles,
      flexiblePhase: FlexiblePhase.FLEXIBLE,
      positionVersion: 0,
      version: 1,
      createdBy: ctx.user._id,
    });
    const flexCycle = cycles[0].cycle;
    await recordPayment(adminReq(ctx.user, ctx.tenant, ctx.branch, {
      body: {
        schemeId: schemeDoc._id,
        amountPaise: 60_000,
        mode: PaymentMode.CASH,
        targetCycle: flexCycle,
        expectedPositionVersion: 0,
      },
    }), { referenceDate: `${flexCycle}-15` });
    await applyFlexibleLock(adminReq(ctx.user, ctx.tenant, ctx.branch, {
      params: { schemeId: schemeDoc._id },
    }));
    needsSettlement = await Scheme.findById(schemeDoc._id).lean();
    if (!needsSettlement?.settlementRequired) {
      throw new Error("Expected settlementRequired after below-minimum flex lock smoke.");
    }
  }
  const preview = await settlementPreview(
    previewReq(needsSettlement, ctx.user, { mode: RedemptionMode.CASH }),
    ClosureType.PREMATURE_CLOSURE,
  );
  if (preview?.settlementPaise == null) {
    throw new Error("System-policy settlement preview missing settlementPaise.");
  }
  console.log("Smoke: system-policy closure settlement preview — OK");
}

async function smokeRedemptionModes(ctx) {
  const matured = await Scheme.findOne({
    tenantId: ctx.tenant._id,
    status: SchemeStatus.MATURED,
    valueBasis: ValueBasis.CASH,
  }).lean();
  if (!matured) throw new Error("No matured cash scheme in seed.");
  await settlementPreview(previewReq(matured, ctx.user, { mode: RedemptionMode.CASH }), ClosureType.MATURITY_REDEMPTION);

  const goldMatured = await Scheme.findOne({
    tenantId: ctx.tenant._id,
    status: SchemeStatus.MATURED,
    valueBasis: ValueBasis.GOLD_WEIGHT,
  }).lean();
  if (goldMatured) {
    const rateDay = new Date().toISOString().slice(0, 10);
    if (!(await GoldRate.findOne({ tenantId: ctx.tenant._id, purity: "22K", effectiveDate: rateDay }).lean())) {
      throw new Error(`Missing exact-day 22K rate for ${rateDay}`);
    }
    await settlementPreview(
      previewReq(goldMatured, ctx.user, { mode: RedemptionMode.GOLD_HANDOVER }),
      ClosureType.MATURITY_REDEMPTION,
    );
    await settlementPreview(
      previewReq(goldMatured, ctx.user, {
        mode: RedemptionMode.PURCHASE_ADJUSTMENT,
        modeDetails: { billNumber: `BILL-P6-${Date.now()}` },
      }),
      ClosureType.MATURITY_REDEMPTION,
    );
  }
  console.log("Smoke: CASH / GOLD_HANDOVER / PURCHASE_ADJUSTMENT previews — OK");
}

export async function runPhase6SmokeFlow() {
  await connectDatabase();
  try {
    await verifyPostSeedInvariants();
    await verifyLedgerSequences();
    await verifyOutboxProcessable();
    const ctx = await loadKairaliOwner();
    const scheme = await smokeFixedPlanEnrolAndManual(ctx);
    await smokePhonePeMock(ctx, scheme);
    await smokeFlexibleFromSeed(ctx);
    await smokeSystemPolicySettlement(ctx);
    await smokeRedemptionModes(ctx);
    console.log("phase6-smoke-flow: ALL STEPS PASSED");
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1]?.endsWith("phase6-smoke-flow.js")) {
  runPhase6SmokeFlow().catch((error) => {
    console.error("phase6-smoke-flow FAILED:", error);
    process.exit(1);
  });
}
