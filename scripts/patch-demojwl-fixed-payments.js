/**
 * Repair Demo Jewellery (DEMOJWL): unlimited flexible 3/6/12-month plans with clean checkout state.
 *
 * Usage: npm run patch:demojwl-payments
 */
import dayjs from "dayjs";
import {
  IdempotencyRecord,
  LedgerEntry,
  Payment,
  PaymentIntent,
  PaymentLink,
  Scheme,
  SchemePlan,
  Tenant,
} from "../src/models/index.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  FlexiblePhase,
  LinkStatus,
  PaymentIntentStatus,
  PaymentMode,
  PaymentPattern,
  PaymentStatus,
  SchemePlanStatus,
  ValueBasis,
} from "../src/constants/enums.js";
import { normalizeFeatureFlags } from "../src/constants/platform-feature-flags.js";
import { buildFlexibleSchemeCycleRows } from "../src/lib/calendar-cycle.js";
import { monthKey } from "../src/lib/date.js";
import { rebuildSchemeProjection } from "../src/services/scheme.service.js";

const TENANT_CODE = "DEMOJWL";

const PLAN_PATCH = {
  DEMO_3M: { durationMonths: 3, installmentCount: 3, name: "3 Month Savings" },
  DEMO_6M: { durationMonths: 6, installmentCount: 6, name: "6 Month Savings" },
  DEMO_12M: { durationMonths: 12, installmentCount: 12, name: "12 Month Savings" },
};

function unlimitedFlexPlanFields({ code, name, durationMonths, installmentCount }) {
  return {
    name,
    code,
    displayName: name,
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FLEXIBLE,
    durationMonths,
    installmentCount,
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 100_000_000,
      multipleOfPaise: 100,
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
      maxPaymentPerTransactionPaise: 100_000_000,
    },
    flexibleRules: {
      phaseMode: "FLEXIBLE_THEN_CAPPED",
      capMode: "FLEXIBLE_PHASE_AVERAGE",
      carryForwardMode: "NONE",
      flexiblePhaseCycles: durationMonths,
      cappedPhaseCycles: 0,
      averagingDivisor: durationMonths,
      frequencyMode: "MULTIPLE",
      flexiblePhase: {
        minimumPaymentPaise: 10_000,
        maximumPaymentPaise: 100_000_000,
        paymentIncrementPaise: 100,
        minTotalPaise: 10_000,
        maxPaymentsPerCycle: null,
        paymentsRequiredPerCycle: 0,
      },
      capComputation: {
        formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
        roundingMode: "ROUND_UP",
        roundToNearestPaise: 100,
        minCycleCapPaise: 10_000,
        onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
        onBelowMinimumTotal: "USE_MINIMUM",
      },
      cappedPhase: {
        minimumPaymentPaise: 10_000,
        paymentIncrementPaise: 100,
        allowFinalRemainderBelowMinimum: true,
        allowFutureCyclePayment: false,
        maxAdvanceCycles: 0,
      },
    },
    benefit: {
      type: "TEXT_ONLY",
      displayLabel: "No maturity bonus",
      eligibility: {
        requireAllInstallmentsPaid: false,
        maxAllowedDefaults: durationMonths,
        minMonthsCompleted: 0,
      },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: {
      allBranches: true,
      branchIds: [],
      visibleInCustomerApp: true,
      customerSelfEnrolAllowed: true,
    },
    termsText: `Choose your monthly contribution (₹100–₹10,00,000). Unlimited payments each month for ${durationMonths} months. No maturity bonus.`,
    status: SchemePlanStatus.ACTIVE,
  };
}

async function patchPlans(tenantId) {
  const plans = await SchemePlan.find({ tenantId, code: { $in: Object.keys(PLAN_PATCH) } });
  let updated = 0;
  for (const plan of plans) {
    const spec = PLAN_PATCH[plan.code];
    if (!spec) continue;
    Object.assign(plan, unlimitedFlexPlanFields({ code: plan.code, ...spec }));
    plan.markModified("amountRules");
    plan.markModified("paymentRules");
    plan.markModified("scheduleRules");
    plan.markModified("flexibleRules");
    plan.markModified("benefit");
    plan.markModified("redemptionRules");
    await plan.save();
    updated += 1;
  }
  return updated;
}

async function cleanCheckoutState(tenantId) {
  const now = new Date();
  const intents = await PaymentIntent.updateMany(
    { tenantId, status: PaymentIntentStatus.PENDING },
    {
      $set: {
        status: PaymentIntentStatus.CANCELLED,
        reservationExpiresAt: now,
      },
    },
  );
  const payments = await Payment.updateMany(
    {
      tenantId,
      status: PaymentStatus.PENDING,
      mode: PaymentMode.ONLINE_GATEWAY,
    },
    {
      $set: {
        status: PaymentStatus.FAILED,
        providerPayload: { repair: "patch-demojwl-unlimited-flex", at: now.toISOString() },
      },
    },
  );
  const links = await PaymentLink.updateMany(
    {
      tenantId,
      status: { $in: [LinkStatus.CREATED, LinkStatus.SENT, LinkStatus.OPENED] },
    },
    { $set: { status: LinkStatus.EXPIRED } },
  );
  const idem = await IdempotencyRecord.deleteMany({
    tenantId,
    endpoint: { $regex: /payment-intents/ },
  });
  return {
    intents: intents.modifiedCount,
    payments: payments.modifiedCount,
    links: links.modifiedCount,
    idempotencyRows: idem.deletedCount,
  };
}

function firstInstallmentModeForScheme(scheme) {
  return (
    scheme.firstInstallmentMode
    ?? scheme.planSnapshot?.scheduleRules?.firstInstallmentModeDefault
    ?? "START_NEXT_CYCLE"
  );
}

function cycleFromDate(date, allowedCycles) {
  const key = monthKey(date);
  return allowedCycles.has(key) ? key : null;
}

async function backfillLedgerCycles(scheme) {
  const allowed = new Set((scheme.cycles ?? []).map((row) => row.cycle));
  const entries = await LedgerEntry.find({
    tenantId: scheme.tenantId,
    schemeId: scheme._id,
    $or: [{ cycle: null }, { cycle: { $exists: false } }, { cycle: "" }],
  });
  let updated = 0;
  for (const entry of entries) {
    let cycle;
    if (entry.paymentId) {
      const payment = await Payment.findById(entry.paymentId)
        .select("targetCycle paidAt")
        .lean();
      cycle =
        payment?.targetCycle
        ?? (payment?.paidAt ? cycleFromDate(payment.paidAt, allowed) : null);
    }
    if (!cycle) {
      cycle = cycleFromDate(entry.effectiveAt ?? entry.createdAt ?? new Date(), allowed);
    }
    if (!cycle && allowed.size) {
      cycle = [...allowed][0];
    }
    if (!cycle) continue;
    await LedgerEntry.collection.updateOne({ _id: entry._id }, { $set: { cycle } });
    if (entry.paymentId) {
      await Payment.updateOne(
        { _id: entry.paymentId, $or: [{ targetCycle: null }, { targetCycle: { $exists: false } }, { targetCycle: "" }] },
        { $set: { targetCycle: cycle } },
      );
    }
    updated += 1;
  }
  return updated;
}

async function migrateSchemeToUnlimitedFlex(scheme, plan) {
  const startDate =
    scheme.startDate
    ?? scheme.createdAt?.toISOString?.().slice(0, 10)
    ?? dayjs().format("YYYY-MM-DD");
  const firstInstallmentMode = firstInstallmentModeForScheme(scheme);
  const cycles = buildFlexibleSchemeCycleRows({
    startDate,
    durationMonths: plan.durationMonths,
    firstInstallmentMode,
  });
  const installmentAmountPaise = Math.max(
    plan.amountRules?.minInstallmentPaise ?? 10_000,
    scheme.installmentAmountPaise ?? plan.amountRules?.minInstallmentPaise ?? 10_000,
  );

  scheme.paymentPattern = PaymentPattern.FLEXIBLE;
  scheme.planSnapshot =
    typeof plan.toObject === "function" ? plan.toObject() : { ...plan, _id: plan._id };
  scheme.valueBasis = plan.valueBasis;
  scheme.startDate = startDate;
  scheme.installmentAmountPaise = installmentAmountPaise;
  scheme.cycles = cycles;
  scheme.flexiblePhase = FlexiblePhase.FLEXIBLE;
  scheme.installments = undefined;
  scheme.positionVersion = 0;
  scheme.markModified("cycles");
  scheme.markModified("planSnapshot");
  await scheme.save();

  const ledgerPatched = await backfillLedgerCycles(scheme);

  const entries = await LedgerEntry.find({
    tenantId: scheme.tenantId,
    schemeId: scheme._id,
  })
    .sort({ sequence: 1 })
    .lean();
  rebuildSchemeProjection(scheme, entries);

  const hadPaid = await Payment.exists({
    tenantId: scheme.tenantId,
    schemeId: scheme._id,
    status: PaymentStatus.SUCCESS,
  });
  if (scheme.status === "PENDING_PAYMENT" && hadPaid) {
    scheme.status = "ACTIVE";
  }

  scheme.version += 1;
  await scheme.save();
  return { ledgerPatched };
}

async function patchTenantFlags(tenant) {
  const featureFlags = normalizeFeatureFlags(tenant.featureFlags);
  featureFlags.customerAppEnabled = true;
  featureFlags.customerSelfEnrol = true;
  featureFlags.onlinePayments = true;
  featureFlags.flexibleScheme = true;

  await Tenant.findByIdAndUpdate(tenant._id, {
    $set: {
      featureFlags,
      "subscription.tier": "GROWTH",
      "operations.customerAppPaymentsEnabled": true,
      "operations.customerAppWriteEnabled": true,
      "operations.customerSelfEnrolEnabled": true,
    },
  });
}

/** Force-remove FIXED leftovers (e.g. after an earlier FIXED patch run on another environment). */
async function hardEnforceFlexibleShape(tenantId) {
  const planCodes = Object.keys(PLAN_PATCH);
  await SchemePlan.updateMany(
    { tenantId, code: { $in: planCodes } },
    { $set: { paymentPattern: PaymentPattern.FLEXIBLE, "amountRules.amountMode": "CUSTOMER_CHOSEN" } },
  );
  const schemeRes = await Scheme.updateMany(
    { tenantId },
    {
      $set: {
        paymentPattern: PaymentPattern.FLEXIBLE,
        flexiblePhase: FlexiblePhase.FLEXIBLE,
      },
      $unset: { installments: "" },
    },
  );
  return { schemesTouched: schemeRes.modifiedCount };
}

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: TENANT_CODE });
  if (!tenant) {
    console.error(`Tenant ${TENANT_CODE} not found.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Patching ${TENANT_CODE} → unlimited FLEXIBLE…\n`);

  const plansUpdated = await patchPlans(tenant._id);
  console.log(`Plans set to unlimited FLEXIBLE: ${plansUpdated}`);

  const checkout = await cleanCheckoutState(tenant._id);
  console.log("Checkout cleanup:", checkout);

  await patchTenantFlags(tenant);
  const hard = await hardEnforceFlexibleShape(tenant._id);
  console.log("Hard FLEXIBLE enforce:", hard);

  const plansById = new Map(
    (await SchemePlan.find({ tenantId: tenant._id })).map((p) => [String(p._id), p]),
  );
  const schemes = await Scheme.find({ tenantId: tenant._id });
  let migrated = 0;
  let ledgerRows = 0;
  for (const scheme of schemes) {
    const plan = plansById.get(String(scheme.planId));
    if (!plan) {
      console.warn(`  skip scheme ${scheme.enrollmentNumber}: plan missing`);
      continue;
    }
    const { ledgerPatched } = await migrateSchemeToUnlimitedFlex(scheme, plan);
    ledgerRows += ledgerPatched;
    migrated += 1;
  }
  console.log(`Schemes migrated to FLEXIBLE: ${migrated} (ledger cycle backfills: ${ledgerRows})`);

  const patterns = await Scheme.aggregate([
    { $match: { tenantId: tenant._id } },
    { $group: { _id: "$paymentPattern", n: { $sum: 1 } } },
  ]);
  const pendingIntents = await PaymentIntent.countDocuments({
    tenantId: tenant._id,
    status: PaymentIntentStatus.PENDING,
  });
  console.log("\nVerify:", { schemePatterns: patterns, pendingIntents });
  console.log("Pay path: POST /app/schemes/:id/payment-intents (expectedPositionVersion optional — defaults from quote).");
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exitCode = 1;
});