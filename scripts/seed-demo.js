/**
 * Demo tenant seed — KAIRALI Jewellers (full scenario matrix)
 *
 * Covers fixed / flexible / gold-weight plans, every major scheme status
 * (ACTIVE, DEFAULTED, MATURED, REDEEMED, CLOSED_PREMATURE, LOCKED flex),
 * flex FLEXIBLE + CAPPED phases (incl. zero-close, expired cycle),
 * redemption queue (pending / approved / completed / rejected),
 * cash handovers (pending / accepted / discrepancy / cancelled / rejected),
 * KYC states, support desk, collector field flow, and realistic payment amounts.
 *
 * Usage:  npm run seed:demo
 * Login:  tenantCode KAIRALI · mobile 9847012345 · password 2026
 * Staff:  9847012350 / 9847012351 (MGR) · 9847012353 (KOC)
 * Admin:   9847012347 · Branch mgr: 9847012346 · Collector: 9847012352
 */
import argon2 from "argon2";
import dayjs from "dayjs";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import {
  BillingCycle,
  ClosureType,
  CustomerStatus,
  PaymentStatus,
  PlanTier,
  FlexiblePhase,
  GrievanceCategory,
  GrievanceMessageType,
  GrievancePriority,
  GrievanceStatus,
  HandoverInitiator,
  InvoiceStatus,
  RedemptionMode,
  SchemePlanStatus,
  SchemeStatus,
  TenantRole,
  TenantStatus,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { addMonthsClamped, monthKey, today } from "../src/lib/date.js";
import { createId } from "../src/lib/ids.js";
import {
  Alert,
  AuditEvent,
  Branch,
  CashAdjustment,
  CashHandover,
  Counter,
  Customer,
  ExportJob,
  GoldRate,
  Grievance,
  IdempotencyRecord,
  LedgerEntry,
  Message,
  OutboxEvent,
  Payment,
  PaymentIntent,
  PaymentLink,
  Redemption,
  Scheme,
  SchemePlan,
  Invoice,
  SubscriptionPlan,
  SubscriptionUpgradeRequest,
  Tenant,
  Upload,
  User,
} from "../src/models/index.js";
import { createHandover, settleHandover } from "../src/services/cash.service.js";
import { recordPayment, reversePayment } from "../src/services/payment.service.js";
import { buildSchedulePreview } from "../src/services/schedule.service.js";
import {
  initiateRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { applyFlexibleLock, enrol, rebuildSchemeProjection } from "../src/services/scheme.service.js";
import { nextSequence } from "../src/services/sequence.service.js";
import {
  draftPlanBody,
  inactivePlanBody,
  microSaverPlanBody,
  slabPlanBody,
  seedCollectorPayments,
  seedExtendedCashControl,
  seedExtendedFixedCash,
  seedExtendedFlexible,
  seedExtraStaff,
  seedKycCustomers,
} from "./seed-demo-matrix.js";

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

const DEMO = {
  tenantCode: "KAIRALI",
  tenantName: "Kairali Jewellers",
  tenantMobile: "+919847012346",
  ownerMobile: "9847012345",
  ownerPassword: "2026",
  managerMobile: "9847012346",
  staffMobile1: "9847012350",
  staffMobile2: "9847012351",
  collectorMobile: "9847012352",
  goldRatePerGramPaise: 725_000,
};

if (env.NODE_ENV === "production" && DEMO.ownerPassword === "2026") {
  console.warn("Demo seed on production — set DEMO_OWNER_PASSWORD in env if you intend this.");
}

function daysFromToday(offsetDays) {
  return dayjs(today()).add(offsetDays, "day").format("YYYY-MM-DD");
}

function makeCtx(tenant, user) {
  return {
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: UserType.TENANT_USER,
      role: user.role,
      ...(user.branchId ? { branchId: user.branchId } : {}),
    },
    scope: { tenantId: tenant._id, ...(user.branchId ? { branchId: user.branchId } : {}) },
    tenant,
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "seed-demo" },
    ip: "127.0.0.1",
    body: {},
    query: {},
  };
}

function makeStaffCtx(tenant, staff, branch) {
  const user =
    typeof staff.toObject === "function" ? staff.toObject() : staff;
  return makeCtx(tenant, { ...user, branchId: branch._id });
}

function paymentReq(ctx, schemeId, { amountPaise, mode = "CASH", expectedVersion }) {
  return {
    ...ctx,
    body: { schemeId, amountPaise, mode, expectedVersion },
  };
}

async function wipeDemoTenant(code) {
  const existing = await Tenant.findOne({ code }).lean();
  if (!existing) return;
  const tenantId = existing._id;
  await LedgerEntry.collection.deleteMany({ tenantId });
  await AuditEvent.collection.deleteMany({ tenantId });
  await CashAdjustment.collection.deleteMany({ tenantId });

  const scoped = [
    Payment,
    PaymentIntent,
    PaymentLink,
    Scheme,
    Redemption,
    Customer,
    SchemePlan,
    GoldRate,
    Grievance,
    Message,
    CashHandover,
    OutboxEvent,
    ExportJob,
    Alert,
    Upload,
    IdempotencyRecord,
  ];
  for (const Model of scoped) {
    await Model.deleteMany({ tenantId });
  }
  await User.deleteMany({ tenantId, type: UserType.TENANT_USER });
  await Branch.deleteMany({ tenantId });
  await Counter.deleteMany({ _id: { $regex: `^${tenantId}:` } });
  await Invoice.deleteMany({ tenantId });
  await SubscriptionUpgradeRequest.deleteMany({ tenantId });
  await Tenant.deleteOne({ _id: tenantId });
}

async function ensurePlatformBasics() {
  const plans = [
    { tier: PlanTier.STARTER, name: "Starter", pricePaise: 199_900, limits: { activeCustomers: 250, branches: 1, staff: 3, schemePlans: 3, whatsappMessages: 1000 } },
    { tier: PlanTier.GROWTH, name: "Growth", pricePaise: 499_900, limits: { activeCustomers: 1000, branches: 5, staff: 10, schemePlans: 10, whatsappMessages: 5000 } },
    { tier: PlanTier.PRO, name: "Pro", pricePaise: 999_900, limits: { activeCustomers: 5000, branches: 25, staff: 50, schemePlans: 50, whatsappMessages: 25000 } },
  ];
  for (const plan of plans) {
    await SubscriptionPlan.updateOne(
      { tier: plan.tier, billingCycle: BillingCycle.MONTHLY },
      { $set: { ...plan, billingCycle: BillingCycle.MONTHLY, active: true }, $setOnInsert: { _id: createId("subscription") } },
      { upsert: true },
    );
  }
}

async function createDemoTenant() {
  const tenantId = createId("tenant");
  const hqId = createId("branch");
  const kocId = createId("branch");
  const ownerId = createId("user");
  const managerId = createId("user");
  const staff1Id = createId("user");
  const staff2Id = createId("user");
  const collectorId = createId("user");
  const passwordHash = await argon2.hash(DEMO.ownerPassword, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

  const renewsAt = new Date(Date.now() + 17 * 86_400_000);
  const tenant = await Tenant.create({
    _id: tenantId,
    code: DEMO.tenantCode,
    name: DEMO.tenantName,
    displayName: "Kairali",
    mobile: DEMO.tenantMobile,
    supportNumber: "9846543211",
    gstin: "32AAHFK8821B1ZP",
    email: "owner@kairalijewellers.in",
    status: TenantStatus.ACTIVE,
    address: {
      line1: "42 MG Road",
      city: "Mangalore",
      state: "Karnataka",
      pincode: "575001",
    },
    branding: {
      primaryColor: "#730321",
      accentColor: "#C9A227",
      displayName: "Kairali Savings",
    },
    settings: { requireKycForEnrolment: false, oneActiveSchemePerCustomer: false },
    operations: {
      multiSchemePerCustomer: true,
      receiptPrefix: "KL",
      termsAndConditions:
        "1. Scheme is valid for the stated tenure.\n2. Benefit applies only if all installments are paid.",
    },
    subscription: {
      tier: PlanTier.GROWTH,
      status: "ACTIVE",
      startsAt: new Date(),
      renewsAt,
      limits: { activeCustomers: 1000, branches: 5, staff: 10, schemePlans: 10, whatsappMessages: 5000 },
    },
  });

  const hq = await Branch.create({
    _id: hqId,
    tenantId,
    code: "MGR",
    name: "MG Road — Mangalore",
    address: { line1: "MG Road", city: "Mangalore", pincode: "575001" },
    isHeadOffice: true,
    active: true,
  });
  const kochi = await Branch.create({
    _id: kocId,
    tenantId,
    code: "KOC",
    name: "Kochi Showroom",
    address: { line1: "Marine Drive", city: "Kochi", pincode: "682001" },
    isHeadOffice: false,
    active: true,
  });

  const owner = await User.create({
    _id: ownerId,
    type: UserType.TENANT_USER,
    tenantId,
    branchId: null,
    role: TenantRole.TENANT_OWNER,
    name: "Rahul Nair",
    mobile: DEMO.ownerMobile,
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_OWNER],
  });

  const manager = await User.create({
    _id: managerId,
    type: UserType.TENANT_USER,
    tenantId,
    branchId: kochi._id,
    role: TenantRole.BRANCH_MANAGER,
    name: "Anu Menon",
    mobile: DEMO.managerMobile,
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER],
  });

  const staff1 = await User.create({
    _id: staff1Id,
    type: UserType.TENANT_USER,
    tenantId,
    branchId: hqId,
    role: TenantRole.BRANCH_STAFF,
    name: "Priya K",
    mobile: DEMO.staffMobile1,
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
  });

  const staff2 = await User.create({
    _id: staff2Id,
    type: UserType.TENANT_USER,
    tenantId,
    branchId: hqId,
    role: TenantRole.BRANCH_STAFF,
    name: "Sanjay M",
    mobile: DEMO.staffMobile2,
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
  });

  await User.create({
    _id: collectorId,
    type: UserType.TENANT_USER,
    tenantId,
    branchId: kochi._id,
    role: TenantRole.COLLECTION_AGENT,
    name: "Vijay Field",
    mobile: DEMO.collectorMobile,
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.COLLECTION_AGENT],
  });

  const goldRateDates = [
    addMonthsClamped(today(), -15).startOf("month").format("YYYY-MM-DD"),
    today(),
  ];
  for (const effectiveDate of goldRateDates) {
    await GoldRate.create({
      _id: createId("goldRate"),
      tenantId,
      branchId: null,
      ratePerGramPaise: DEMO.goldRatePerGramPaise,
      effectiveDate,
      purity: "22K",
      source: "MANUAL",
      enteredBy: owner._id,
    });
  }

  const paidAtBase = dayjs().subtract(1, "month").date(1).hour(10).minute(0).toDate();
  await Invoice.insertMany([
    {
      _id: createId("inv"),
      tenantId,
      amountPaise: 499_900,
      status: InvoiceStatus.PAID,
      reference: "SG-INV-2026-08",
      dueDate: "Aug 2026",
      paidAt: paidAtBase,
    },
    {
      _id: createId("inv"),
      tenantId,
      amountPaise: 499_900,
      status: InvoiceStatus.PAID,
      reference: "SG-INV-2026-09",
      dueDate: "Sep 2026",
      paidAt: dayjs(paidAtBase).add(1, "month").toDate(),
    },
    {
      _id: createId("inv"),
      tenantId,
      amountPaise: 499_900,
      status: InvoiceStatus.ISSUED,
      reference: "SG-INV-2026-10",
      dueDate: "Oct 2026",
    },
  ]);

  return { tenant, hq, kochi, owner, manager, staff1, staff2, passwordHash };
}

function flexiblePlanBody() {
  return {
    name: "Flexi Save",
    code: "FLEXI11",
    displayName: "Flexible then capped",
    description: "Free contribution window, then monthly cap from averaged total",
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    durationMonths: 12,
    installmentCount: 12,
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      slabsPaise: [],
      minInstallmentPaise: 100_000,
      maxInstallmentPaise: 500_000,
      multipleOfPaise: 10_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 5,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: true,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      advancePaymentAllowed: false,
      maxAdvanceInstallments: 0,
      minPaymentPaise: 10_000,
    },
    flexibleRules: {
      phaseMode: "FLEXIBLE_THEN_CAPPED",
      capMode: "FLEXIBLE_PHASE_AVERAGE",
      carryForwardMode: "NONE",
      flexiblePhaseCycles: 3,
      cappedPhaseCycles: 9,
      averagingDivisor: 3,
      frequencyMode: "MULTIPLE",
      flexiblePhase: {
        minimumPaymentPaise: 10_000,
        maximumPaymentPaise: 500_000,
        paymentIncrementPaise: 10_000,
        minTotalPaise: 300_000,
        maxPaymentsPerCycle: null,
        paymentsRequiredPerCycle: 0,
      },
      capComputation: {
        formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
        roundingMode: "ROUND_UP",
        roundToNearestPaise: 10_000,
        minCycleCapPaise: 50_000,
        maxCycleCapPaise: 1_000_000,
        onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
        onBelowMinimumTotal: "USE_MINIMUM",
      },
      cappedPhase: {
        minimumPaymentPaise: 10_000,
        paymentIncrementPaise: 10_000,
        allowFinalRemainderBelowMinimum: true,
        allowFutureCyclePayment: false,
        maxAdvanceCycles: 0,
      },
    },
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "PERCENT_OF_PAID",
      bonusValue: 5,
      maxBonusPaise: 500_000,
      displayLabel: "5% bonus on maturity (max ₹5,000)",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 2, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: { allBranches: true, branchIds: [], visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
    termsText:
      "1. During the free phase you may pay any amount between the plan minimum and maximum per transaction.\n2. After the free phase, each cycle is capped at the average of your free-phase payments (rounded as per plan rules).\n3. Maturity benefit applies only if you complete all capped cycles and meet eligibility rules.\n4. Premature closure may forfeit benefit and attract penalty as per store policy.",
    status: SchemePlanStatus.ACTIVE,
  };
}

function goldWeightPlanBody() {
  return {
    name: "Gold Accumulation",
    code: "GOLD11",
    displayName: "11+1 Gold weight",
    description:
      "Fixed monthly instalments converted to 22K gold weight at the branch daily rate",
    valueBasis: "GOLD_WEIGHT",
    paymentPattern: "FIXED",
    durationMonths: 12,
    installmentCount: 12,
    amountRules: {
      amountMode: "JEWELLER_FIXED",
      fixedAmountPaise: 500_000,
      minInstallmentPaise: 500_000,
      maxInstallmentPaise: 500_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 5,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: true,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      advancePaymentAllowed: false,
      maxAdvanceInstallments: 0,
      minPaymentPaise: 10_000,
      maxPaymentPerTransactionPaise: 500_000,
    },
    goldRules: {
      rateSource: "TENANT_DAILY_RATE",
      weightRoundingMode: "HALF_UP",
      weightPrecisionMg: 1,
      blockPaymentIfRateNotSet: true,
    },
    benefit: {
      type: "ONE_FREE_INSTALLMENT",
      displayLabel: "12th instalment as bonus gold weight",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 3,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 2, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH", "GOLD_HANDOVER", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: { allBranches: true, branchIds: [], visibleInCustomerApp: true, customerSelfEnrolAllowed: false },
    termsText:
      "1. Each payment is converted to gold weight using the rate on the payment date.\n2. The maturity benefit is credited as additional gold weight when all instalments are paid.\n3. You may redeem as physical gold (handover) or cash as per plan rules.\n4. Premature closure forfeits benefit and may attract penalty after lock-in.",
    status: SchemePlanStatus.ACTIVE,
  };
}

function savingPlanBody() {
  return {
    name: "Saving",
    code: "SAVING11",
    displayName: "11+1 Saving Scheme",
    description: "Pay 11 installments · 12th month benefit on maturity",
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    durationMonths: 12,
    installmentCount: 12,
    amountRules: {
      amountMode: "JEWELLER_FIXED",
      fixedAmountPaise: 500_000,
      minInstallmentPaise: 500_000,
      maxInstallmentPaise: 500_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 5,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: true,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      advancePaymentAllowed: false,
      maxAdvanceInstallments: 0,
      minPaymentPaise: 10_000,
      maxPaymentPerTransactionPaise: 500_000,
    },
    benefit: {
      type: "ONE_FREE_INSTALLMENT",
      displayLabel: "12th installment free",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 3,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 2, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH", "GOLD_HANDOVER", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: { allBranches: true, branchIds: [], visibleInCustomerApp: true, customerSelfEnrolAllowed: false },
    termsText:
      "1. One fixed installment is due each month on your enrolment anniversary.\n2. The 12th installment is credited as a benefit when all 11 installments are paid on time.\n3. Late or missed payments may affect benefit eligibility.\n4. Redemption is at maturity or as per premature closure rules shown at enrolment.",
    status: SchemePlanStatus.ACTIVE,
  };
}

async function createPlan(tenantId, ownerId, body) {
  return SchemePlan.create({
    _id: createId("plan"),
    tenantId,
    ...body,
    createdBy: ownerId,
    version: 1,
  });
}

async function createCustomer(tenantId, branchId, { name, mobile, passbookNumber }) {
  const n = await nextSequence(tenantId, "customer");
  return Customer.create({
    _id: createId("customer"),
    tenantId,
    branchId,
    customerNumber: `CUS-${String(n).padStart(6, "0")}`,
    passbookNumber,
    name,
    mobile,
    status: CustomerStatus.ACTIVE,
    kyc: { status: "VERIFIED", verifiedAt: new Date() },
  });
}

async function createFixedScheme(ctx, {
  customer,
  plan,
  branchId,
  startDate,
  label,
  installmentAmountPaise: installmentOverride,
}) {
  const installmentAmountPaise =
    installmentOverride ?? plan.amountRules.fixedAmountPaise;
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
  return { scheme, label };
}

async function payInstallments(ctx, scheme, count, { mode = "CASH", amountPaise, backdateFrom }) {
  let doc = await Scheme.findById(scheme._id);
  const unit = amountPaise ?? doc.installmentAmountPaise;
  for (let i = 0; i < count; i += 1) {
    await recordPayment(
      paymentReq(ctx, doc._id, { amountPaise: unit, mode, expectedVersion: doc.version }),
    );
    doc = await Scheme.findById(scheme._id);
  }
  if (backdateFrom) {
    const payments = await Payment.find({ schemeId: scheme._id, status: PaymentStatus.SUCCESS }).sort({ createdAt: 1 });
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
  if (!scheme) throw new Error(`Scheme ${schemeId} not found for redemption seed`);
  const preview = await settlementPreview(
    redemptionCtx(ctx, scheme._id),
    closureType,
  );
  if (!preview.eligible) {
    throw new Error(
      `Redemption seed blocked for ${scheme.enrollmentNumber}: ${preview.blockers[0]?.message ?? "not eligible"}`,
    );
  }
  const body = {
    mode,
    expectedVersion: scheme.version,
    modeDetails: {
      expectedFinalValuePaise: preview.settlementPaise,
      ...(mode === RedemptionMode.PURCHASE_ADJUSTMENT
        ? { billNumber: `SEED-BILL-${scheme.enrollmentNumber}` }
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

async function approveRedemption(ctx, redemptionId) {
  return transitionRedemption(
    { ...ctx, params: { redemptionId }, body: {} },
    "approve",
  );
}

async function completeRedemption(ctx, redemptionId) {
  return transitionRedemption(
    { ...ctx, params: { redemptionId }, body: {} },
    "complete",
  );
}

async function rejectRedemption(ctx, redemptionId, reason) {
  return transitionRedemption(
    { ...ctx, params: { redemptionId }, body: { reason } },
    "reject",
  );
}

async function seedMatureGoldScheme(ctx, { customer, plan, branchId, startDate }) {
  const { scheme } = await createFixedScheme(ctx, {
    customer,
    plan,
    branchId,
    startDate,
    label: "gold-mature",
  });
  await payInstallments(ctx, scheme, 12, { mode: "UPI", backdateFrom: startDate });
  await markMatured(scheme._id);
  return Scheme.findById(scheme._id);
}

async function enrolFlexible(ctx, customer, plan) {
  ctx.body = {
    customerId: customer._id,
    planId: plan._id,
    firstInstallmentMode: "START_NEXT_CYCLE",
  };
  return enrol(ctx);
}

async function createFlexibleScheme(ctx, { customer, plan, branchId, startDate }) {
  const cycles = buildSchedulePreview({
    startDate,
    durationMonths: plan.durationMonths,
    installmentCount: plan.durationMonths,
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

function flexPhaseCycleKeys(scheme, count = 3) {
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

async function recordFlexPayment(ctx, scheme, amountPaise, mode = "CASH", targetCycle) {
  let doc = await Scheme.findById(scheme._id);
  await recordPayment(
    flexPaymentReq(ctx, doc._id, {
      amountPaise,
      expectedPositionVersion: doc.positionVersion ?? 0,
      mode,
      targetCycle,
    }),
  );
  return Scheme.findById(scheme._id);
}

async function seedFlexibleScenarios(ownerCtx, staffCtx, flexPlan, customers) {
  const summary = [];
  const [freeCust, lockCust, cappedCust] = customers;

  const freeEnrol = await enrolFlexible(ownerCtx, freeCust, flexPlan);
  let freeScheme = await Scheme.findById(freeEnrol._id);
  freeScheme = await recordFlexPayment(staffCtx, freeScheme, 120_000, "CASH");
  freeScheme = await recordFlexPayment(staffCtx, freeScheme, 80_000, "CASH");
  summary.push({
    enrollment: freeScheme.enrollmentNumber,
    story: "FLEXIBLE free window · ₹2,000 collected · ready to apply lock",
  });

  // Four months back so today's month is the first capped cycle (after 3 flexible cycles).
  const cappedPhaseStart = addMonthsClamped(today(), -4).format("YYYY-MM-DD");
  const lockEnrol = await createFlexibleScheme(ownerCtx, {
    customer: lockCust,
    plan: flexPlan,
    branchId: lockCust.branchId,
    startDate: cappedPhaseStart,
  });
  let lockScheme = await Scheme.findById(lockEnrol._id);
  const [flexM1, flexM2, flexM3] = flexPhaseCycleKeys(lockScheme);
  lockScheme = await recordFlexPayment(staffCtx, lockScheme, 100_000, "CASH", flexM1);
  lockScheme = await recordFlexPayment(staffCtx, lockScheme, 100_000, "CASH", flexM2);
  lockScheme = await recordFlexPayment(staffCtx, lockScheme, 100_000, "CASH", flexM3);
  const lockReq = { ...ownerCtx, params: { schemeId: lockScheme._id } };
  await applyFlexibleLock(lockReq);
  lockScheme = await Scheme.findById(lockScheme._id);
  lockScheme = await recordFlexPayment(staffCtx, lockScheme, 50_000, "CASH", monthKey());
  summary.push({
    enrollment: lockScheme.enrollmentNumber,
    story: "FLEXIBLE LOCKED · ₹1,000/mo cap · ₹500 partial in current capped cycle",
  });

  const capEnrol = await createFlexibleScheme(ownerCtx, {
    customer: cappedCust,
    plan: flexPlan,
    branchId: cappedCust.branchId,
    startDate: cappedPhaseStart,
  });
  let capScheme = await Scheme.findById(capEnrol._id);
  const capFlexCycles = flexPhaseCycleKeys(capScheme);
  capScheme = await recordFlexPayment(ownerCtx, capScheme, 150_000, "UPI", capFlexCycles[0]);
  capScheme = await recordFlexPayment(ownerCtx, capScheme, 150_000, "UPI", capFlexCycles[1]);
  await applyFlexibleLock({ ...ownerCtx, params: { schemeId: capScheme._id } });
  capScheme = await Scheme.findById(capScheme._id);
  capScheme = await recordFlexPayment(ownerCtx, capScheme, 100_000, "UPI", monthKey());
  summary.push({
    enrollment: capScheme.enrollmentNumber,
    story: "FLEXIBLE LOCKED · capped phase (non-cash payments)",
  });

  return { summary, freeScheme, lockScheme };
}

async function seedGoldWeightScenarios(ctx, goldPlan, customers, branches) {
  const { hq, kochi } = branches;
  const summary = [];
  const matureStart = addMonthsClamped(today(), -13).format("YYYY-MM-DD");

  const ongoingStart = addMonthsClamped(today(), -4).format("YYYY-MM-DD");
  const { scheme: ongoing } = await createFixedScheme(ctx, {
    customer: customers[0],
    plan: goldPlan,
    branchId: hq._id,
    startDate: ongoingStart,
    label: "gold-active",
  });
  await payInstallments(ctx, ongoing, 4, { mode: "CASH", backdateFrom: ongoingStart });
  summary.push({
    enrollment: ongoing.enrollmentNumber,
    story: "GOLD_WEIGHT · ACTIVE · 4 instalments · weight on passbook",
  });

  const dueStart = addMonthsClamped(today(), -3).format("YYYY-MM-DD");
  const { scheme: dueGold } = await createFixedScheme(ctx, {
    customer: customers[1],
    plan: goldPlan,
    branchId: hq._id,
    startDate: dueStart,
    label: "gold-due",
  });
  await payInstallments(ctx, dueGold, 2, { mode: "UPI", backdateFrom: dueStart });
  summary.push({
    enrollment: dueGold.enrollmentNumber,
    story: "GOLD_WEIGHT · next instalment due · collect at gold rate",
  });

  const redeemable = await seedMatureGoldScheme(ctx, {
    customer: customers[2],
    plan: goldPlan,
    branchId: kochi._id,
    startDate: matureStart,
  });
  summary.push({
    enrollment: redeemable.enrollmentNumber,
    story: "GOLD_WEIGHT · MATURED · redeemable (no open request)",
  });

  const pendingScheme = await seedMatureGoldScheme(ctx, {
    customer: customers[3],
    plan: goldPlan,
    branchId: hq._id,
    startDate: matureStart,
  });
  const pendingRed = await openRedemption(
    ctx,
    pendingScheme._id,
    ClosureType.MATURITY_REDEMPTION,
    RedemptionMode.GOLD_HANDOVER,
  );
  summary.push({
    enrollment: pendingScheme.enrollmentNumber,
    story: `GOLD_WEIGHT · redemption ${pendingRed.status} · take as gold · approve in queue`,
  });

  const approvedScheme = await seedMatureGoldScheme(ctx, {
    customer: customers[4],
    plan: goldPlan,
    branchId: hq._id,
    startDate: matureStart,
  });
  const approvedRed = await openRedemption(
    ctx,
    approvedScheme._id,
    ClosureType.MATURITY_REDEMPTION,
    RedemptionMode.CASH,
  );
  await approveRedemption(ctx, approvedRed._id);
  summary.push({
    enrollment: approvedScheme.enrollmentNumber,
    story: "GOLD_WEIGHT · APPROVED · cash maturity · ready to complete",
  });

  const completedGoldScheme = await seedMatureGoldScheme(ctx, {
    customer: customers[5],
    plan: goldPlan,
    branchId: kochi._id,
    startDate: matureStart,
  });
  const completedGoldRed = await openRedemption(
    ctx,
    completedGoldScheme._id,
    ClosureType.MATURITY_REDEMPTION,
    RedemptionMode.GOLD_HANDOVER,
  );
  await approveRedemption(ctx, completedGoldRed._id);
  await completeRedemption(ctx, completedGoldRed._id);
  summary.push({
    enrollment: completedGoldScheme.enrollmentNumber,
    story: "GOLD_WEIGHT · COMPLETED · REDEEMED · gold handover",
  });

  const completedCashScheme = await seedMatureGoldScheme(ctx, {
    customer: customers[6],
    plan: goldPlan,
    branchId: hq._id,
    startDate: matureStart,
  });
  const completedCashRed = await openRedemption(
    ctx,
    completedCashScheme._id,
    ClosureType.MATURITY_REDEMPTION,
    RedemptionMode.CASH,
  );
  await approveRedemption(ctx, completedCashRed._id);
  await completeRedemption(ctx, completedCashRed._id);
  summary.push({
    enrollment: completedCashScheme.enrollmentNumber,
    story: "GOLD_WEIGHT · COMPLETED · REDEEMED · cash payout",
  });

  const prematureStart = addMonthsClamped(today(), -5).format("YYYY-MM-DD");
  const { scheme: prematureActive } = await createFixedScheme(ctx, {
    customer: customers[7],
    plan: goldPlan,
    branchId: hq._id,
    startDate: prematureStart,
    label: "gold-premature-open",
  });
  await payInstallments(ctx, prematureActive, 4, {
    mode: "CARD",
    backdateFrom: prematureStart,
  });
  const prematureApprovedRed = await openRedemption(
    ctx,
    prematureActive._id,
    ClosureType.PREMATURE_CLOSURE,
    RedemptionMode.GOLD_HANDOVER,
  );
  await approveRedemption(ctx, prematureApprovedRed._id);
  summary.push({
    enrollment: prematureActive.enrollmentNumber,
    story: "GOLD_WEIGHT · PREMATURE · APPROVED · early gold handover",
  });

  const prematureDoneStart = addMonthsClamped(today(), -6).format("YYYY-MM-DD");
  const { scheme: prematureDone } = await createFixedScheme(ctx, {
    customer: customers[8],
    plan: goldPlan,
    branchId: kochi._id,
    startDate: prematureDoneStart,
    label: "gold-premature-done",
  });
  await payInstallments(ctx, prematureDone, 4, {
    mode: "CASH",
    backdateFrom: prematureDoneStart,
  });
  const prematureDoneRed = await openRedemption(
    ctx,
    prematureDone._id,
    ClosureType.PREMATURE_CLOSURE,
    RedemptionMode.CASH,
  );
  await approveRedemption(ctx, prematureDoneRed._id);
  await completeRedemption(ctx, prematureDoneRed._id);
  summary.push({
    enrollment: prematureDone.enrollmentNumber,
    story: "GOLD_WEIGHT · PREMATURE · COMPLETED · CLOSED_PREMATURE",
  });

  const rejectedScheme = await seedMatureGoldScheme(ctx, {
    customer: customers[9],
    plan: goldPlan,
    branchId: hq._id,
    startDate: matureStart,
  });
  const rejectedRed = await openRedemption(
    ctx,
    rejectedScheme._id,
    ClosureType.MATURITY_REDEMPTION,
    RedemptionMode.PURCHASE_ADJUSTMENT,
  );
  await rejectRedemption(
    ctx,
    rejectedRed._id,
    "Customer postponed visit — scheme stays matured",
  );
  summary.push({
    enrollment: rejectedScheme.enrollmentNumber,
    story: "GOLD_WEIGHT · redemption REJECTED · still MATURED · can re-initiate",
  });

  return summary;
}

function grievanceSlaDueAt(createdAt, priority) {
  const hours = { URGENT: 1, HIGH: 4, NORMAL: 24, LOW: 48 }[priority] ?? 24;
  return new Date(new Date(createdAt).getTime() + hours * 3_600_000);
}

async function seedSupportDesk(tenantId, { hq, kochi, owner, manager, staff1, customers }) {
  const year = dayjs().year();
  let ticketSeq = 0;
  const ticketNumber = () => {
    ticketSeq += 1;
    return `SG-${year}-${String(ticketSeq).padStart(6, "0")}`;
  };

  const customerMessage = (customerId, body, createdAt) => ({
    type: GrievanceMessageType.PUBLIC_REPLY,
    actorType: "CUSTOMER",
    actorId: customerId,
    body,
    attachmentUploadIds: [],
    createdAt,
  });

  const staffNote = (userId, body, createdAt) => ({
    type: GrievanceMessageType.INTERNAL_NOTE,
    actorType: "USER",
    actorId: userId,
    body,
    attachmentUploadIds: [],
    createdAt,
  });

  const staffReply = (userId, body, createdAt) => ({
    type: GrievanceMessageType.PUBLIC_REPLY,
    actorType: "USER",
    actorId: userId,
    body,
    attachmentUploadIds: [],
    createdAt,
  });

  const specs = [
    {
      customer: customers[0],
      branchId: hq._id,
      category: GrievanceCategory.RECEIPT,
      priority: GrievancePriority.URGENT,
      status: GrievanceStatus.OPEN,
      subject: "WhatsApp receipt not received after UPI payment",
      description:
        "Paid ₹5,000 via UPI yesterday evening. Passbook shows the payment but I did not get the WhatsApp receipt.",
      createdAt: dayjs().subtract(3, "hour").toDate(),
      assigneeId: staff1._id,
      messages: (cust, createdAt) => [
        customerMessage(
          cust._id,
          "Paid ₹5,000 via UPI yesterday evening. Passbook shows the payment but I did not get the WhatsApp receipt.",
          createdAt,
        ),
      ],
      line: "URGENT · RECEIPT · SLA overdue · Sachu Sudhish",
    },
    {
      customer: customers[1],
      branchId: hq._id,
      category: GrievanceCategory.RECEIPT,
      priority: GrievancePriority.HIGH,
      status: GrievanceStatus.IN_PROGRESS,
      subject: "Need duplicate receipt for cash payment at counter",
      description:
        "I paid cash at MG Road last week and need a duplicate receipt for my employer reimbursement.",
      createdAt: dayjs().subtract(6, "hour").toDate(),
      firstResponseAt: dayjs().subtract(5, "hour").toDate(),
      assigneeId: manager._id,
      messages: (cust, createdAt) => {
        const replied = dayjs(createdAt).add(1, "hour").toDate();
        return [
          customerMessage(
            cust._id,
            "I paid cash at MG Road last week and need a duplicate receipt for my employer reimbursement.",
            createdAt,
          ),
          staffNote(
            owner._id,
            "Verified ledger — payment ENR exists; resend receipt template after KYC check.",
            dayjs(replied).subtract(5, "minute").toDate(),
          ),
          staffReply(
            owner._id,
            "We found your cash payment on file. We will resend the receipt to your WhatsApp within an hour.",
            replied,
          ),
        ];
      },
      line: "IN_PROGRESS · RECEIPT duplicate · Lakshmi Nair",
    },
    {
      customer: customers[2],
      branchId: kochi._id,
      category: GrievanceCategory.PAYMENT,
      priority: GrievancePriority.NORMAL,
      status: GrievanceStatus.OPEN,
      subject: "Partial payment not reflected on current installment",
      description:
        "Paid ₹2,000 against this month’s installment at Kochi showroom but the app still shows partially due.",
      createdAt: dayjs().subtract(2, "hour").toDate(),
      assigneeId: null,
      messages: (cust, createdAt) => [
        customerMessage(
          cust._id,
          "Paid ₹2,000 against this month’s installment at Kochi showroom but the app still shows partially due.",
          createdAt,
        ),
      ],
      line: "OPEN · PAYMENT · Kochi · Arjun Pillai",
    },
    {
      customer: customers[4],
      branchId: hq._id,
      category: GrievanceCategory.MATURITY,
      priority: GrievancePriority.HIGH,
      status: GrievanceStatus.WAITING_FOR_CUSTOMER,
      subject: "Maturity redemption appointment slot",
      description: "Scheme matured — need help booking a redemption visit this week.",
      createdAt: dayjs().subtract(1, "day").toDate(),
      firstResponseAt: dayjs().subtract(22, "hour").toDate(),
      assigneeId: staff1._id,
      messages: (cust, createdAt) => [
        customerMessage(
          cust._id,
          "My scheme shows matured. Please confirm when I can visit to redeem.",
          createdAt,
        ),
        staffReply(
          staff1._id,
          "Congratulations! We can slot you Thu–Sat 11am–5pm. Reply with your preferred day.",
          dayjs(createdAt).add(2, "hour").toDate(),
        ),
      ],
      line: "WAITING_FOR_CUSTOMER · maturity · Vijay Kumar",
    },
    {
      customer: customers[7],
      branchId: hq._id,
      category: GrievanceCategory.WHATSAPP,
      priority: GrievancePriority.LOW,
      status: GrievanceStatus.OPEN,
      subject: "Reminder messages stopped for my scheme",
      description: "I used to get due reminders on WhatsApp but none this month.",
      createdAt: dayjs().subtract(30, "hour").toDate(),
      assigneeId: null,
      messages: (cust, createdAt) => [
        customerMessage(
          cust._id,
          "I used to get due reminders on WhatsApp but none this month.",
          createdAt,
        ),
      ],
      line: "OPEN · WHATSAPP · SLA overdue · Nisha Thomas",
    },
    {
      customer: customers[3],
      branchId: hq._id,
      category: GrievanceCategory.RECEIPT,
      priority: GrievancePriority.NORMAL,
      status: GrievanceStatus.RESOLVED,
      subject: "Receipt PDF download failed in customer app",
      description: "Download button spins forever when I try to save my last payment receipt.",
      createdAt: dayjs().subtract(2, "day").toDate(),
      firstResponseAt: dayjs().subtract(47, "hour").toDate(),
      resolvedAt: dayjs().subtract(2, "hour").toDate(),
      assigneeId: owner._id,
      messages: (cust, createdAt) => [
        customerMessage(
          cust._id,
          "Download button spins forever when I try to save my last payment receipt.",
          createdAt,
        ),
        staffReply(
          owner._id,
          "We reset your session and resent the receipt link — please try again from Messages.",
          dayjs(createdAt).add(3, "hour").toDate(),
        ),
      ],
      line: "RESOLVED today · RECEIPT app download · Meera Das",
    },
  ];

  for (const spec of specs) {
    const createdAt = spec.createdAt;
    const priority = spec.priority;
    await Grievance.create({
      _id: createId("grievance"),
      tenantId,
      branchId: spec.branchId,
      customerId: spec.customer._id,
      ticketNumber: ticketNumber(),
      category: spec.category,
      priority,
      status: spec.status,
      subject: spec.subject,
      description: spec.description,
      assigneeId: spec.assigneeId ?? undefined,
      firstResponseDueAt: grievanceSlaDueAt(createdAt, priority),
      firstResponseAt: spec.firstResponseAt,
      resolvedAt: spec.resolvedAt,
      messages: spec.messages(spec.customer, createdAt),
      version: 1,
      createdAt,
      updatedAt: spec.resolvedAt ?? spec.firstResponseAt ?? createdAt,
    });
  }

  await Counter.updateOne(
    { _id: `${tenantId}:grievance:${year}` },
    { $set: { value: ticketSeq } },
    { upsert: true },
  );

  return specs.map((row) => row.line);
}

async function seedCashControl(
  ownerCtx,
  staffCtx,
  staff2Ctx,
  managerCtx,
  hq,
  kochi,
  freeScheme,
  tenantId,
  kochiPartialCustomerId,
) {
  const summary = [];
  const ownerAtHq = {
    ...ownerCtx,
    scope: { tenantId: ownerCtx.auth.tenantId, branchId: hq._id },
  };

  let free = await Scheme.findById(freeScheme._id);
  free = await recordFlexPayment(staff2Ctx, free, 60_000, "CASH");
  const acceptedHo = await createHandover(
    {
      ...staff2Ctx,
      body: { amountPaise: 60_000, remarks: "Morning float handover" },
    },
    HandoverInitiator.STAFF,
  );
  await settleHandover(
    {
      ...ownerAtHq,
      params: { handoverId: acceptedHo._id },
      body: { acceptedAmountPaise: 60_000 },
    },
    "accept",
  );
  await recordFlexPayment(staff2Ctx, free, 80_000, "CASH");
  summary.push("Sanjay (MGR) · ₹60,000 accepted earlier · ₹800 still in hand");

  await recordFlexPayment(staffCtx, free, 120_000, "CASH");
  await createHandover(
    {
      ...staffCtx,
      body: { amountPaise: 100_000, remarks: "Counter closing — MG Road" },
    },
    HandoverInitiator.STAFF,
  );
  summary.push("Priya (MGR) · ₹1,00,000 handover pending · use Receive cash on Cash control");

  const partialScheme = await Scheme.findOne({
    tenantId,
    customerId: kochiPartialCustomerId,
    branchId: kochi._id,
  }).sort({ createdAt: -1 });
  if (partialScheme) {
    let partialDoc = await Scheme.findById(partialScheme._id);
    await recordPayment(
      paymentReq(managerCtx, partialDoc._id, {
        amountPaise: 150_000,
        mode: "CASH",
        expectedVersion: partialDoc.version,
      }),
    );
    await createHandover(
      {
        ...managerCtx,
        body: { amountPaise: 45_000, remarks: "Kochi counter — float to HO" },
      },
      HandoverInitiator.STAFF,
    );
    summary.push("Anu Menon (KOC) · ₹450 pending handover · cash from Kochi collections");
  }

  await recordFlexPayment(staff2Ctx, free, 40_000, "CASH");
  const discrepancyHo = await createHandover(
    {
      ...staff2Ctx,
      body: { amountPaise: 50_000, remarks: "Afternoon bundle — note ₹500 short in envelope" },
    },
    HandoverInitiator.STAFF,
  );
  await settleHandover(
    {
      ...ownerAtHq,
      params: { handoverId: discrepancyHo._id },
      body: { acceptedAmountPaise: 49_500 },
    },
    "accept",
  );
  summary.push("Sanjay · ₹500 discrepancy handover settled (shortfall) · recent history");

  return summary;
}

async function seedScenarios(ctx, plan, customers, branches) {
  const { hq, kochi } = branches;
  const summary = [];

  // 1) Due today — 2 paid, 3rd due now (lock-in met path later)
  const dueCustomer = customers[0];
  const startDue = addMonthsClamped(today(), -3).format("YYYY-MM-DD");
  const { scheme: dueScheme } = await createFixedScheme(ctx, {
    customer: dueCustomer,
    plan,
    branchId: hq._id,
    startDate: startDue,
    label: "due-today",
  });
  await payInstallments(ctx, dueScheme, 2, { mode: "CASH", backdateFrom: startDue });
  summary.push({ enrollment: dueScheme.enrollmentNumber, story: "Next installment DUE today (2 prior paid)" });

  // 2) Overdue — started 5 months ago, only 1st paid
  const overdueCustomer = customers[1];
  const startOverdue = addMonthsClamped(today(), -5).format("YYYY-MM-DD");
  const { scheme: overdueScheme } = await createFixedScheme(ctx, {
    customer: overdueCustomer,
    plan,
    branchId: hq._id,
    startDate: startOverdue,
    label: "overdue",
  });
  await payInstallments(ctx, overdueScheme, 1, { mode: "UPI", backdateFrom: startOverdue });
  summary.push({ enrollment: overdueScheme.enrollmentNumber, story: "Installment 2+ OVERDUE (grace elapsed)" });

  // 3) Partially paid current due
  const partialCustomer = customers[2];
  const startPartial = addMonthsClamped(today(), -1).format("YYYY-MM-DD");
  const { scheme: partialScheme } = await createFixedScheme(ctx, {
    customer: partialCustomer,
    plan,
    branchId: kochi._id,
    startDate: startPartial,
    label: "partial",
  });
  let partialDoc = await Scheme.findById(partialScheme._id);
  await recordPayment(
    paymentReq(ctx, partialDoc._id, {
      amountPaise: 200_000,
      mode: "CASH",
      expectedVersion: partialDoc.version,
    }),
  );
  await Payment.updateMany(
    { schemeId: partialScheme._id },
    { $set: { paidAt: dayjs(startPartial).add(1, "month").toDate() } },
  );
  await recomputeSchemeStatuses(partialScheme._id);
  summary.push({ enrollment: partialScheme.enrollmentNumber, story: "PARTIALLY_PAID on current installment" });

  // 4) Healthy active — 3 paid (premature preview: lock-in met, penalty applies)
  const activeCustomer = customers[3];
  const startActive = addMonthsClamped(today(), -3).format("YYYY-MM-DD");
  const { scheme: activeScheme } = await createFixedScheme(ctx, {
    customer: activeCustomer,
    plan,
    branchId: hq._id,
    startDate: startActive,
    label: "active-lockin-met",
  });
  await payInstallments(ctx, activeScheme, 3, {
    mode: "CASH",
    backdateFrom: startActive,
  });
  summary.push({ enrollment: activeScheme.enrollmentNumber, story: "ACTIVE · 3 paid · premature closure eligible" });

  // 5) Matured — all 12 paid, ready to redeem
  const matureCustomer = customers[4];
  const startMature = addMonthsClamped(today(), -13).format("YYYY-MM-DD");
  const { scheme: matureScheme } = await createFixedScheme(ctx, {
    customer: matureCustomer,
    plan,
    branchId: hq._id,
    startDate: startMature,
    label: "matured",
  });
  await payInstallments(ctx, matureScheme, 12, {
    mode: "CARD",
    backdateFrom: startMature,
  });
  await markMatured(matureScheme._id);
  const cashMaturityRed = await openRedemption(
    ctx,
    matureScheme._id,
    ClosureType.MATURITY_REDEMPTION,
    RedemptionMode.CASH,
  );
  summary.push({
    enrollment: matureScheme.enrollmentNumber,
    story: `CASH SAVING11 · MATURED · redemption ${cashMaturityRed.status} (Vijay — complete in queue)`,
  });

  // 6) Maturity this month (not all paid) — calendar entry
  const calCustomer = customers[5];
  const startCal = addMonthsClamped(today(), -11).format("YYYY-MM-DD");
  const { scheme: calScheme } = await createFixedScheme(ctx, {
    customer: calCustomer,
    plan,
    branchId: kochi._id,
    startDate: startCal,
    label: "maturity-soon",
  });
  await payInstallments(ctx, calScheme, 10, { mode: "UPI", backdateFrom: startCal });
  await Scheme.updateOne(
    { _id: calScheme._id },
    { $set: { maturityDate: daysFromToday(12) } },
  );
  summary.push({ enrollment: calScheme.enrollmentNumber, story: "Maturity in ~12 days · 2 installments left" });

  // 7) Collections mix — extra payments this month on new scheme
  const mixCustomer = customers[6];
  const startMix = daysFromToday(-45);
  const { scheme: mixScheme } = await createFixedScheme(ctx, {
    customer: mixCustomer,
    plan,
    branchId: hq._id,
    startDate: startMix,
    label: "collections",
  });
  await payInstallments(ctx, mixScheme, 2, { mode: "CASH", backdateFrom: startMix });
  let mixDoc = await Scheme.findById(mixScheme._id);
  await recordPayment(
    paymentReq(ctx, mixDoc._id, { amountPaise: mixDoc.installmentAmountPaise, mode: "UPI", expectedVersion: mixDoc.version }),
  );
  mixDoc = await Scheme.findById(mixScheme._id);
  await recordPayment(
    paymentReq(ctx, mixDoc._id, { amountPaise: mixDoc.installmentAmountPaise, mode: "CARD", expectedVersion: mixDoc.version }),
  );
  const monthStart = dayjs(today()).startOf("month");
  const payments = await Payment.find({ schemeId: mixScheme._id, status: PaymentStatus.SUCCESS }).sort({ createdAt: -1 }).limit(2);
  await Payment.updateOne({ _id: payments[0]._id }, { $set: { paidAt: monthStart.add(5, "day").hour(10).toDate() } });
  await Payment.updateOne({ _id: payments[1]._id }, { $set: { paidAt: monthStart.add(12, "day").hour(15).toDate() } });
  summary.push({ enrollment: mixScheme.enrollmentNumber, story: "Recent UPI + CARD for mode mix / trend" });

  // 8) Pending gateway payment (collections pending tab)
  const pendingCustomer = customers[7];
  const { scheme: pendingScheme } = await createFixedScheme(ctx, {
    customer: pendingCustomer,
    plan,
    branchId: hq._id,
    startDate: daysFromToday(-20),
    label: "pending-gateway",
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: ctx.auth.tenantId,
    branchId: hq._id,
    schemeId: pendingScheme._id,
    customerId: pendingCustomer._id,
    receiptNumber: `PENDING-DEMO-${Date.now()}`,
    amountPaise: plan.amountRules.fixedAmountPaise,
    allocatedAmountPaise: 0,
    mode: "ONLINE_GATEWAY",
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  summary.push({ enrollment: pendingScheme.enrollmentNumber, story: "PENDING online payment on ledger" });

  // 9) Reversed payment
  const revCustomer = customers[8];
  const { scheme: revScheme } = await createFixedScheme(ctx, {
    customer: revCustomer,
    plan,
    branchId: kochi._id,
    startDate: daysFromToday(-60),
    label: "reversed",
  });
  let revDoc = await Scheme.findById(revScheme._id);
  const paid = await recordPayment(
    paymentReq(ctx, revDoc._id, {
      amountPaise: revDoc.installmentAmountPaise,
      mode: "CASH",
      expectedVersion: revDoc.version,
    }),
  );
  await reversePayment({
    ...ctx,
    params: { paymentId: paid._id ?? paid.id },
    body: { reason: "Demo reversal — wrong amount entered at counter" },
  });
  await recomputeSchemeStatuses(revScheme._id);
  summary.push({ enrollment: revScheme.enrollmentNumber, story: "One SUCCESS payment reversed" });

  return summary;
}

await connectDatabase();
try {
  await ensurePlatformBasics();
  await wipeDemoTenant(DEMO.tenantCode);
  const { tenant, hq, kochi, owner, manager, staff1, staff2, passwordHash } =
    await createDemoTenant();
  await seedExtraStaff(tenant._id, hq._id, kochi._id, passwordHash);
  const ctx = makeCtx(tenant, owner);
  const staffCtx = makeStaffCtx(tenant, staff1, hq);
  const staff2Ctx = makeStaffCtx(tenant, staff2, hq);
  const managerCtx = makeStaffCtx(tenant, manager, kochi);
  const collector = await User.findOne({
    tenantId: tenant._id,
    mobile: DEMO.collectorMobile,
    type: UserType.TENANT_USER,
  }).lean();
  const collectorCtx = collector
    ? makeStaffCtx(tenant, collector, kochi)
    : managerCtx;
  const plan = await createPlan(tenant._id, owner._id, savingPlanBody());
  const flexPlan = await createPlan(tenant._id, owner._id, flexiblePlanBody());
  const goldPlan = await createPlan(tenant._id, owner._id, goldWeightPlanBody());
  const microPlan = await createPlan(tenant._id, owner._id, microSaverPlanBody());
  const slabPlan = await createPlan(tenant._id, owner._id, slabPlanBody());
  await createPlan(tenant._id, owner._id, draftPlanBody());
  await createPlan(tenant._id, owner._id, inactivePlanBody());

  const customers = await Promise.all([
    createCustomer(tenant._id, hq._id, { name: "Sachu Sudhish", mobile: "7907753163", passbookNumber: "CUS-000001" }),
    createCustomer(tenant._id, hq._id, { name: "Lakshmi Nair", mobile: "9847123456", passbookNumber: "CUS-000002" }),
    createCustomer(tenant._id, kochi._id, { name: "Arjun Pillai", mobile: "9847234567", passbookNumber: "CUS-000003" }),
    createCustomer(tenant._id, hq._id, { name: "Meera Das", mobile: "9847345678", passbookNumber: "CUS-000004" }),
    createCustomer(tenant._id, hq._id, { name: "Vijay Kumar", mobile: "9847456789", passbookNumber: "CUS-000005" }),
    createCustomer(tenant._id, kochi._id, { name: "Deepa Menon", mobile: "9847567890", passbookNumber: "CUS-000006" }),
    createCustomer(tenant._id, hq._id, { name: "Ravi Shankar", mobile: "9847678901", passbookNumber: "CUS-000007" }),
    createCustomer(tenant._id, hq._id, { name: "Nisha Thomas", mobile: "9847789012", passbookNumber: "CUS-000008" }),
    createCustomer(tenant._id, kochi._id, { name: "George Mathew", mobile: "9847890123", passbookNumber: "CUS-000009" }),
    createCustomer(tenant._id, hq._id, { name: "Flexi Amal", mobile: "9847901234", passbookNumber: "CUS-000010" }),
    createCustomer(tenant._id, hq._id, { name: "Flexi Beena", mobile: "9847912345", passbookNumber: "CUS-000011" }),
    createCustomer(tenant._id, kochi._id, { name: "Flexi Cyrus", mobile: "9847923456", passbookNumber: "CUS-000012" }),
    createCustomer(tenant._id, hq._id, { name: "Gold Hari", mobile: "9847934567", passbookNumber: "CUS-000013" }),
    createCustomer(tenant._id, hq._id, { name: "Gold Indu", mobile: "9847945678", passbookNumber: "CUS-000014" }),
    createCustomer(tenant._id, kochi._id, { name: "Gold Jaya", mobile: "9847956789", passbookNumber: "CUS-000015" }),
    createCustomer(tenant._id, hq._id, { name: "Gold Karthik", mobile: "9847967890", passbookNumber: "CUS-000016" }),
    createCustomer(tenant._id, hq._id, { name: "Gold Latha", mobile: "9847978901", passbookNumber: "CUS-000017" }),
    createCustomer(tenant._id, kochi._id, { name: "Gold Manu", mobile: "9847989012", passbookNumber: "CUS-000018" }),
    createCustomer(tenant._id, hq._id, { name: "Gold Neena", mobile: "9847990123", passbookNumber: "CUS-000019" }),
    createCustomer(tenant._id, hq._id, { name: "Gold Omar", mobile: "9847001234", passbookNumber: "CUS-000020" }),
    createCustomer(tenant._id, kochi._id, { name: "Gold Priya G", mobile: "9847011111", passbookNumber: "CUS-000021" }),
    createCustomer(tenant._id, hq._id, { name: "Gold Qadir", mobile: "9847022222", passbookNumber: "CUS-000022" }),
  ]);

  await seedKycCustomers(tenant._id, hq._id, kochi._id, () =>
    nextSequence(tenant._id, "customer"),
  );

  const matrixCustomers = await Promise.all([
    createCustomer(tenant._id, hq._id, { name: "Matrix Default", mobile: "9847040001", passbookNumber: "CUS-M-DEF" }),
    createCustomer(tenant._id, hq._id, { name: "Matrix Redeemed", mobile: "9847040002", passbookNumber: "CUS-M-RED" }),
    createCustomer(tenant._id, kochi._id, { name: "Matrix Purchase", mobile: "9847040003", passbookNumber: "CUS-M-PA" }),
    createCustomer(tenant._id, hq._id, { name: "Matrix Premature", mobile: "9847040004", passbookNumber: "CUS-M-PRE" }),
    createCustomer(tenant._id, hq._id, { name: "Matrix Micro", mobile: "9847040005", passbookNumber: "CUS-M-MIC" }),
    createCustomer(tenant._id, kochi._id, { name: "Matrix Slab", mobile: "9847040006", passbookNumber: "CUS-M-SLB" }),
    createCustomer(tenant._id, hq._id, { name: "Matrix Flex Early", mobile: "9847040007", passbookNumber: "CUS-M-FE" }),
    createCustomer(tenant._id, hq._id, { name: "Matrix Flex Zero", mobile: "9847040008", passbookNumber: "CUS-M-FZ" }),
    createCustomer(tenant._id, hq._id, { name: "Matrix Flex CapFull", mobile: "9847040009", passbookNumber: "CUS-M-FC" }),
    createCustomer(tenant._id, hq._id, { name: "Matrix Flex Expired", mobile: "9847040010", passbookNumber: "CUS-M-FX" }),
    createCustomer(tenant._id, kochi._id, { name: "Matrix Collector", mobile: "9847040011", passbookNumber: "CUS-M-COL" }),
  ]);

  const seedDeps = {
    createFixedScheme,
    payInstallments,
    markMatured,
    recordPayment,
    paymentReq,
    recomputeSchemeStatuses,
    createFlexibleScheme,
    recordFlexPayment,
    flexPhaseCycleKeys,
    enrolFlexible,
  };

  const stories = await seedScenarios(ctx, plan, customers.slice(0, 9), { hq, kochi });
  const flex = await seedFlexibleScenarios(ctx, staffCtx, flexPlan, customers.slice(9, 12));
  const goldStories = await seedGoldWeightScenarios(
    ctx,
    goldPlan,
    customers.slice(12, 22),
    { hq, kochi },
  );
  const supportLines = await seedSupportDesk(tenant._id, {
    hq,
    kochi,
    owner,
    manager,
    staff1,
    customers,
  });
  const cashLines = await seedCashControl(
    ctx,
    staffCtx,
    staff2Ctx,
    managerCtx,
    hq,
    kochi,
    flex.freeScheme,
    tenant._id,
    customers[2]._id,
  );

  const matrixFixed = await seedExtendedFixedCash({
    ctx,
    plan,
    microPlan,
    slabPlan,
    customers: matrixCustomers.slice(0, 6),
    branches: { hq, kochi },
    deps: seedDeps,
  });
  const matrixFlex = await seedExtendedFlexible({
    ownerCtx: ctx,
    staffCtx,
    flexPlan,
    customers: matrixCustomers.slice(6, 10),
    branches: { hq, kochi },
    deps: seedDeps,
  });
  const collectorLines = await seedCollectorPayments(
    collectorCtx,
    matrixCustomers[10],
    flexPlan,
    seedDeps,
  );
  const matrixCash = await seedExtendedCashControl({
    ownerCtx: ctx,
    staffCtx,
    staff2Ctx,
    managerCtx,
    collectorCtx,
    hq,
    kochi,
    freeScheme: flex.freeScheme,
    deps: seedDeps,
  });

  process.stdout.write("\n=== Demo seed complete (KAIRALI) ===\n");
  process.stdout.write(`Tenant code: ${DEMO.tenantCode}\n`);
  process.stdout.write(`Owner login: ${DEMO.ownerMobile} / ${DEMO.ownerPassword}\n`);
  process.stdout.write(
    `Staff login: ${DEMO.staffMobile1} or ${DEMO.staffMobile2} / ${DEMO.ownerPassword} (${hq.code})\n`,
  );
  process.stdout.write(
    `Tenant admin: 9847012347 / ${DEMO.ownerPassword} · Kochi staff: 9847012353 / ${DEMO.ownerPassword}\n`,
  );
  process.stdout.write(
    `Collection agent: ${DEMO.collectorMobile} / ${DEMO.ownerPassword} (${kochi.code}, COLLECTION_AGENT)\n`,
  );
  process.stdout.write(`Branches: ${hq.code} (${hq.name}), ${kochi.code} (${kochi.name})\n`);
  process.stdout.write(
    `Plans: ${plan.code} · ${flexPlan.code} · ${goldPlan.code} · ${microPlan.code} · ${slabPlan.code} · FEST27 (draft) · LEG10 (inactive)\n`,
  );
  process.stdout.write(`Gold rate today: ₹${DEMO.goldRatePerGramPaise / 100}/g\n\nFixed schemes:\n`);
  for (const row of stories) {
    process.stdout.write(`  · ${row.enrollment} — ${row.story}\n`);
  }
  process.stdout.write("\nFlexible schemes:\n");
  for (const row of flex.summary) {
    process.stdout.write(`  · ${row.enrollment} — ${row.story}\n`);
  }
  process.stdout.write("\nGold-weight schemes (GOLD11):\n");
  for (const row of goldStories) {
    process.stdout.write(`  · ${row.enrollment} — ${row.story}\n`);
  }
  process.stdout.write("\nSupport desk:\n");
  for (const line of supportLines) {
    process.stdout.write(`  · ${line}\n`);
  }
  process.stdout.write("\nCash control:\n");
  for (const line of cashLines) {
    process.stdout.write(`  · ${line}\n`);
  }
  process.stdout.write("\nExtended fixed / redemption matrix:\n");
  for (const row of matrixFixed) {
    process.stdout.write(`  · ${row.enrollment} — ${row.story}\n`);
  }
  process.stdout.write("\nExtended flexible matrix:\n");
  for (const row of matrixFlex) {
    process.stdout.write(`  · ${row.enrollment} — ${row.story}\n`);
  }
  process.stdout.write("\nExtended cash / collector:\n");
  for (const line of [...matrixCash, ...collectorLines.map((r) => `${r.enrollment} — ${r.story}`)]) {
    process.stdout.write(`  · ${line}\n`);
  }
  process.stdout.write(
    "\nUI: Support desk → grievances (receipt / payment tickets). " +
      "Cash control → Receive cash / pending handovers (MGR + KOC). " +
      "Enrollments → value basis Gold weight or filter GOLD11. " +
      "Maturity & redemption → open queue (cash + gold handover). " +
      "Flexible → filter FLEXI11.\n",
  );
  process.stdout.write("Re-run anytime: npm run seed:demo (replaces KAIRALI data)\n");
} finally {
  await disconnectDatabase();
}
