/**
 * Extended KAIRALI demo scenarios — every major scheme / cash / staff / KYC state.
 * Imported by scripts/seed-demo.js (not run standalone).
 */
import dayjs from "dayjs";
import {
  ClosureType,
  CustomerStatus,
  FlexiblePhase,
  HandoverInitiator,
  KycStatus,
  RedemptionMode,
  SchemePlanStatus,
  SchemeStatus,
  TenantRole,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { addMonthsClamped, monthKey, today } from "../src/lib/date.js";
import { createId } from "../src/lib/ids.js";
import { Customer, Scheme, User } from "../src/models/index.js";
import {
  cancelHandover,
  createHandover,
  settleHandover,
} from "../src/services/cash.service.js";
import { applyFlexibleLock } from "../src/services/scheme.service.js";
import {
  initiateRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";

function redemptionCtx(ctx, schemeId, body = {}) {
  return { ...ctx, params: { schemeId }, body };
}

async function openRedemption(ctx, schemeId, closureType, mode) {
  const scheme = await Scheme.findById(schemeId);
  if (!scheme) throw new Error(`Scheme ${schemeId} not found`);
  const preview = await settlementPreview(
    redemptionCtx(ctx, scheme._id),
    closureType,
  );
  if (!preview.eligible) {
    throw new Error(
      `Matrix redemption blocked ${scheme.enrollmentNumber}: ${preview.blockers[0]?.message ?? "not eligible"}`,
    );
  }
  return initiateRedemption(
    redemptionCtx(ctx, scheme._id, {
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
    }),
    closureType,
    false,
  );
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

export function microSaverPlanBody() {
  return {
    name: "Micro Saver",
    code: "MICRO12",
    displayName: "Micro Saver 12M",
    description: "Low-ticket fixed monthly savings for walk-in customers",
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    durationMonths: 12,
    installmentCount: 12,
    amountRules: {
      amountMode: "JEWELLER_FIXED",
      fixedAmountPaise: 150_000,
      minInstallmentPaise: 150_000,
      maxInstallmentPaise: 150_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 3,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: true,
    },
    paymentRules: {
      partialPaymentAllowed: false,
      advancePaymentAllowed: false,
      maxAdvanceInstallments: 0,
      minPaymentPaise: 150_000,
      maxPaymentPerTransactionPaise: 150_000,
    },
    benefit: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: 150_000,
      displayLabel: "₹1,500 flat bonus on maturity",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 2,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 1, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: { allBranches: true, branchIds: [], visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
    termsText: "Fixed ₹1,500/month for 12 months. Flat ₹1,500 bonus when all instalments are paid.",
    status: SchemePlanStatus.ACTIVE,
  };
}

export function slabPlanBody() {
  return {
    name: "Choice Saver",
    code: "SLAB11",
    displayName: "Choice slab 11+1",
    description: "Customer picks instalment from jeweller-defined slabs",
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    durationMonths: 11,
    installmentCount: 11,
    amountRules: {
      amountMode: "JEWELLER_SLABS",
      slabsPaise: [200_000, 300_000, 500_000, 1_000_000],
      minInstallmentPaise: 200_000,
      maxInstallmentPaise: 1_000_000,
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
      maxPaymentPerTransactionPaise: 1_000_000,
    },
    benefit: {
      type: "ONE_FREE_INSTALLMENT",
      displayLabel: "One free instalment on maturity",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 3,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 2, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: { allBranches: true, branchIds: [], visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
    termsText: "Pick ₹2,000 / ₹3,000 / ₹5,000 / ₹10,000 per month from slabs.",
    status: SchemePlanStatus.ACTIVE,
  };
}

export function draftPlanBody() {
  return {
    name: "Festive 2027",
    code: "FEST27",
    displayName: "Festive plan (draft)",
    description: "Draft plan — not visible for enrolment",
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    durationMonths: 10,
    installmentCount: 10,
    amountRules: {
      amountMode: "JEWELLER_FIXED",
      fixedAmountPaise: 1_000_000,
      minInstallmentPaise: 1_000_000,
      maxInstallmentPaise: 1_000_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 5,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: false,
    },
    paymentRules: {
      partialPaymentAllowed: false,
      advancePaymentAllowed: false,
      maxAdvanceInstallments: 0,
      minPaymentPaise: 1_000_000,
    },
    benefit: {
      type: "TEXT_ONLY",
      displayLabel: "Festive benefit TBD",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      prematureClosureAllowed: false,
      lockInMonths: 0,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH"],
      redeemAtAnyBranch: false,
    },
    availability: { allBranches: false, branchIds: [], visibleInCustomerApp: false, customerSelfEnrolAllowed: false },
    termsText: "Draft — do not enrol customers yet.",
    status: SchemePlanStatus.DRAFT,
  };
}

export function inactivePlanBody() {
  return {
    name: "Legacy 10M",
    code: "LEG10",
    displayName: "Legacy 10-month (inactive)",
    description: "Retired plan kept for historical enrolments only",
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    durationMonths: 10,
    installmentCount: 10,
    amountRules: {
      amountMode: "JEWELLER_FIXED",
      fixedAmountPaise: 400_000,
      minInstallmentPaise: 400_000,
      maxInstallmentPaise: 400_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 5,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: false,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      advancePaymentAllowed: false,
      maxAdvanceInstallments: 0,
      minPaymentPaise: 10_000,
    },
    benefit: {
      type: "ONE_FREE_INSTALLMENT",
      displayLabel: "Legacy benefit",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 2,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 2, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH"],
      redeemAtAnyBranch: true,
    },
    availability: { allBranches: true, branchIds: [], visibleInCustomerApp: false, customerSelfEnrolAllowed: false },
    termsText: "Inactive plan — no new enrolments.",
    status: SchemePlanStatus.INACTIVE,
  };
}

export async function seedExtraStaff(tenantId, hqId, kochiId, passwordHash) {
  const tenantAdmin = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId,
    branchId: null,
    role: TenantRole.TENANT_ADMIN,
    name: "Divya Admin",
    mobile: "9847012347",
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_ADMIN],
  });

  const kochiStaff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId,
    branchId: kochiId,
    role: TenantRole.BRANCH_STAFF,
    name: "Reena K",
    mobile: "9847012353",
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
  });

  const inactiveStaff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId,
    branchId: hqId,
    role: TenantRole.BRANCH_STAFF,
    name: "Former Staff",
    mobile: "9847012354",
    passwordHash,
    status: UserStatus.INACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
  });

  return { tenantAdmin, kochiStaff, inactiveStaff };
}

export async function seedKycCustomers(tenantId, hqId, kochiId, nextCustomerNumber) {
  const rows = [];
  const specs = [
    { name: "KYC Pending Amal", mobile: "9847030001", kyc: { status: KycStatus.NOT_SUBMITTED } },
    { name: "KYC Submitted Beena", mobile: "9847030002", kyc: { status: KycStatus.SUBMITTED, type: "AADHAAR", submittedAt: new Date() } },
    { name: "KYC Rejected Cyrus", mobile: "9847030003", kyc: { status: KycStatus.REJECTED, rejectionReason: "Document unreadable — re-upload", submittedAt: dayjs().subtract(2, "day").toDate() } },
    { name: "Blocked Customer", mobile: "9847030004", status: CustomerStatus.BLOCKED, kyc: { status: KycStatus.VERIFIED, verifiedAt: new Date() } },
  ];

  for (const spec of specs) {
    const n = await nextCustomerNumber();
    const customer = await Customer.create({
      _id: createId("customer"),
      tenantId,
      branchId: spec.mobile.endsWith("0004") ? kochiId : hqId,
      customerNumber: `CUS-${String(n).padStart(6, "0")}`,
      name: spec.name,
      mobile: spec.mobile,
      status: spec.status ?? CustomerStatus.ACTIVE,
      kyc: spec.kyc,
    });
    rows.push(customer);
  }
  return rows;
}

export async function seedExtendedFixedCash({
  ctx,
  plan,
  microPlan,
  slabPlan,
  customers,
  branches,
  deps,
}) {
  const { hq, kochi } = branches;
  const {
    createFixedScheme,
    payInstallments,
    markMatured,
    recordPayment,
    paymentReq,
    recomputeSchemeStatuses,
  } = deps;
  const summary = [];

  // DEFAULTED — long overdue trail
  const defStart = addMonthsClamped(today(), -9).format("YYYY-MM-DD");
  const { scheme: defScheme } = await createFixedScheme(ctx, {
    customer: customers[0],
    plan,
    branchId: hq._id,
    startDate: defStart,
    label: "defaulted",
  });
  await payInstallments(ctx, defScheme, 1, { mode: "CASH", backdateFrom: defStart });
  await recomputeSchemeStatuses(defScheme._id);
  await Scheme.updateOne({ _id: defScheme._id }, { $set: { status: SchemeStatus.DEFAULTED } });
  summary.push({
    enrollment: defScheme.enrollmentNumber,
    story: "FIXED · DEFAULTED · 1 paid · multiple OVERDUE instalments",
  });

  // REDEEMED maturity (cash)
  const matureStart = addMonthsClamped(today(), -14).format("YYYY-MM-DD");
  const { scheme: redeemedScheme } = await createFixedScheme(ctx, {
    customer: customers[1],
    plan,
    branchId: hq._id,
    startDate: matureStart,
    label: "redeemed-cash",
  });
  await payInstallments(ctx, redeemedScheme, 12, { mode: "UPI", backdateFrom: matureStart });
  await markMatured(redeemedScheme._id);
  const red = await openRedemption(
    ctx,
    redeemedScheme._id,
    ClosureType.MATURITY_REDEMPTION,
    RedemptionMode.CASH,
  );
  await approveRedemption(ctx, red._id);
  await completeRedemption(ctx, red._id);
  summary.push({
    enrollment: redeemedScheme.enrollmentNumber,
    story: "FIXED · MATURED → REDEEMED · cash payout completed",
  });

  // REDEEMED purchase adjustment
  const { scheme: paScheme } = await createFixedScheme(ctx, {
    customer: customers[2],
    plan,
    branchId: kochi._id,
    startDate: matureStart,
    label: "redeemed-pa",
  });
  await payInstallments(ctx, paScheme, 12, { mode: "CARD", backdateFrom: matureStart });
  await markMatured(paScheme._id);
  const paRed = await openRedemption(
    ctx,
    paScheme._id,
    ClosureType.MATURITY_REDEMPTION,
    RedemptionMode.PURCHASE_ADJUSTMENT,
  );
  await approveRedemption(ctx, paRed._id);
  await completeRedemption(ctx, paRed._id);
  summary.push({
    enrollment: paScheme.enrollmentNumber,
    story: "FIXED · REDEEMED · purchase adjustment against bill",
  });

  // Premature CLOSED_PREMATURE fixed cash
  const preStart = addMonthsClamped(today(), -5).format("YYYY-MM-DD");
  const { scheme: preScheme } = await createFixedScheme(ctx, {
    customer: customers[3],
    plan,
    branchId: hq._id,
    startDate: preStart,
    label: "premature-fixed",
  });
  await payInstallments(ctx, preScheme, 4, { mode: "CASH", backdateFrom: preStart });
  const preRed = await openRedemption(
    ctx,
    preScheme._id,
    ClosureType.PREMATURE_CLOSURE,
    RedemptionMode.CASH,
  );
  await approveRedemption(ctx, preRed._id);
  await completeRedemption(ctx, preRed._id);
  summary.push({
    enrollment: preScheme.enrollmentNumber,
    story: "FIXED · PREMATURE · CLOSED_PREMATURE · penalty applied",
  });

  // Micro saver active (3 paid)
  const microStart = addMonthsClamped(today(), -3).format("YYYY-MM-DD");
  const { scheme: microScheme } = await createFixedScheme(ctx, {
    customer: customers[4],
    plan: microPlan,
    branchId: hq._id,
    startDate: microStart,
    label: "micro-active",
  });
  await payInstallments(ctx, microScheme, 3, { mode: "CASH", backdateFrom: microStart });
  summary.push({
    enrollment: microScheme.enrollmentNumber,
    story: "MICRO12 · ACTIVE · ₹1,500/mo · 3 instalments paid",
  });

  // Slab plan — customer chose ₹3,000 slab
  const slabStart = addMonthsClamped(today(), -2).format("YYYY-MM-DD");
  const slabAmount = 300_000;
  const { scheme: slabScheme } = await createFixedScheme(ctx, {
    customer: customers[5],
    plan: slabPlan,
    branchId: kochi._id,
    startDate: slabStart,
    label: "slab-3000",
    installmentAmountPaise: slabAmount,
  });
  let slabDoc = await Scheme.findById(slabScheme._id);
  await recordPayment(
    paymentReq(ctx, slabDoc._id, {
      amountPaise: slabAmount,
      mode: "UPI",
      expectedVersion: slabDoc.version,
    }),
  );
  await recomputeSchemeStatuses(slabScheme._id);
  summary.push({
    enrollment: slabScheme.enrollmentNumber,
    story: "SLAB11 · ACTIVE · ₹3,000/mo slab · 1 paid",
  });

  return summary;
}

export async function seedExtendedFlexible({
  ownerCtx,
  staffCtx,
  flexPlan,
  customers,
  branches,
  deps,
}) {
  const { hq } = branches;
  const {
    createFlexibleScheme,
    recordFlexPayment,
    flexPhaseCycleKeys,
    recomputeSchemeStatuses,
  } = deps;
  const summary = [];

  // Early flex — only cycle 1 payment, still FLEXIBLE phase
  const earlyStart = addMonthsClamped(today(), -1).format("YYYY-MM-DD");
  const earlyScheme = await createFlexibleScheme(ownerCtx, {
    customer: customers[0],
    plan: flexPlan,
    branchId: hq._id,
    startDate: earlyStart,
  });
  let earlyDoc = await Scheme.findById(earlyScheme._id);
  const [c1] = flexPhaseCycleKeys(earlyDoc);
  earlyDoc = await recordFlexPayment(staffCtx, earlyDoc, 50_000, "CASH", c1);
  summary.push({
    enrollment: earlyDoc.enrollmentNumber,
    story: "FLEXI · FLEXIBLE phase · cycle 1 only · ₹500 paid",
  });

  // Zero flex → CLOSED_PREMATURE on lock
  const zeroStart = addMonthsClamped(today(), -4).format("YYYY-MM-DD");
  const zeroScheme = await createFlexibleScheme(ownerCtx, {
    customer: customers[1],
    plan: flexPlan,
    branchId: hq._id,
    startDate: zeroStart,
  });
  const lockResult = await applyFlexibleLock({
    ...ownerCtx,
    params: { schemeId: zeroScheme._id },
  });
  summary.push({
    enrollment: zeroScheme.enrollmentNumber,
    story: `FLEXI · zero flex total → ${lockResult.status ?? lockResult.closeReason ?? "CLOSED_PREMATURE"}`,
  });

  // Locked · capped cycle fully paid
  const capFullStart = addMonthsClamped(today(), -5).format("YYYY-MM-DD");
  const capFull = await createFlexibleScheme(ownerCtx, {
    customer: customers[2],
    plan: flexPlan,
    branchId: hq._id,
    startDate: capFullStart,
  });
  let capDoc = await Scheme.findById(capFull._id);
  const flexKeys = flexPhaseCycleKeys(capDoc);
  for (const cycle of flexKeys) {
    capDoc = await recordFlexPayment(staffCtx, capDoc, 100_000, "CASH", cycle);
  }
  await applyFlexibleLock({ ...ownerCtx, params: { schemeId: capDoc._id } });
  capDoc = await Scheme.findById(capDoc._id);
  const capAmount = capDoc.cycles.find((row) => row.cycle === monthKey())?.capPaise ?? 100_000;
  capDoc = await recordFlexPayment(staffCtx, capDoc, capAmount, "CASH", monthKey());
  summary.push({
    enrollment: capDoc.enrollmentNumber,
    story: "FLEXI · LOCKED · current capped cycle fully paid",
  });

  // Locked · expired prior capped cycle
  const expiredStart = addMonthsClamped(today(), -6).format("YYYY-MM-DD");
  const expiredScheme = await createFlexibleScheme(ownerCtx, {
    customer: customers[3],
    plan: flexPlan,
    branchId: hq._id,
    startDate: expiredStart,
  });
  let expDoc = await Scheme.findById(expiredScheme._id);
  for (const cycle of flexPhaseCycleKeys(expDoc)) {
    expDoc = await recordFlexPayment(staffCtx, expDoc, 80_000, "CASH", cycle);
  }
  await applyFlexibleLock({ ...ownerCtx, params: { schemeId: expDoc._id } });
  expDoc = await Scheme.findById(expiredScheme._id);
  const pastCycle = expDoc.cycles.find((row) => row.cycle < monthKey() && row.flexiblePhase !== FlexiblePhase.FLEXIBLE);
  if (pastCycle) {
    await Scheme.updateOne(
      { _id: expDoc._id, "cycles.cycle": pastCycle.cycle },
      {
        $set: {
          "cycles.$.status": "EXPIRED",
          "cycles.$.remainingPaise": Math.max(0, pastCycle.capPaise - pastCycle.paidPaise),
          "cycles.$.expiresAt": dayjs().subtract(15, "day").format("YYYY-MM-DD"),
        },
        $inc: { version: 1, positionVersion: 1 },
      },
    );
    await recomputeSchemeStatuses(expDoc._id);
  }
  expDoc = await Scheme.findById(expiredScheme._id);
  summary.push({
    enrollment: expDoc.enrollmentNumber,
    story: "FLEXI · LOCKED · prior capped cycle EXPIRED (partial unpaid)",
  });

  return summary;
}

export async function seedExtendedCashControl({
  ownerCtx,
  staffCtx,
  staff2Ctx,
  managerCtx,
  collectorCtx,
  hq,
  kochi,
  freeScheme,
  deps,
}) {
  const { recordFlexPayment } = deps;
  const summary = [];
  const ownerAtHq = {
    ...ownerCtx,
    scope: { tenantId: ownerCtx.auth.tenantId, branchId: hq._id },
  };

  // Cancelled handover (staff cancels before acceptance)
  let free = await Scheme.findById(freeScheme._id);
  free = await recordFlexPayment(staff2Ctx, free, 20_000, "CASH");
  const cancelHo = await createHandover(
    {
      ...staff2Ctx,
      body: { amountPaise: 20_000, remarks: "Cancelled — counted twice by mistake" },
    },
    HandoverInitiator.STAFF,
  );
  await cancelHandover({
    ...staff2Ctx,
    params: { handoverId: cancelHo._id },
  });
  summary.push("Sanjay · ₹20,000 handover CANCELLED by staff");

  // Rejected handover
  await recordFlexPayment(staffCtx, free, 30_000, "CASH");
  const rejectHo = await createHandover(
    {
      ...staffCtx,
      body: { amountPaise: 30_000, remarks: "Bundle missing ₹500 — recount requested" },
    },
    HandoverInitiator.STAFF,
  );
  await settleHandover(
    {
      ...ownerAtHq,
      params: { handoverId: rejectHo._id },
      body: { reason: "Cash count mismatch — staff to resubmit" },
    },
    "reject",
  );
  summary.push("Priya · ₹30,000 handover REJECTED by owner");

  // Collector Kochi pending handover (cash from field collection on KOC schemes)
  await createHandover(
    {
      ...collectorCtx,
      body: { amountPaise: 80_000, remarks: "Field collection — Kochi route" },
    },
    HandoverInitiator.STAFF,
  );
  summary.push("Vijay (collector KOC) · ₹800 handover PENDING (after field collection)");

  // Admin-initiated handover record (owner creates on behalf — if supported use STAFF with staff target)
  void kochi;
  void managerCtx;
  return summary;
}

export async function seedCollectorPayments(collectorCtx, kochiCustomer, flexPlan, deps) {
  const { enrolFlexible, recordFlexPayment } = deps;
  const summary = [];
  const enrol = await enrolFlexible(collectorCtx, kochiCustomer, flexPlan);
  let scheme = await Scheme.findById(enrol._id);
  scheme = await recordFlexPayment(collectorCtx, scheme, 80_000, "CASH");
  summary.push({
    enrollment: scheme.enrollmentNumber,
    story: "Collector enrol + ₹800 flex payment (KOC customer)",
  });
  return summary;
}

