import argon2 from "argon2";
import { spawnSync } from "node:child_process";
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
  Invoice,
  LedgerEntry,
  Message,
  OutboxEvent,
  Payment,
  PaymentIntent,
  PaymentLink,
  Redemption,
  Scheme,
  SchemePlan,
  SubscriptionPlan,
  SubscriptionUpgradeRequest,
  Tenant,
  Upload,
  User,
} from "../src/models/index.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  BillingCycle,
  CustomerLoginMode,
  CustomerStatus,
  FlexiblePhase,
  PaymentPattern,
  PlanTier,
  SchemePlanStatus,
  SchemeStatus,
  TenantRole,
  TenantStatus,
  UserStatus,
  UserType,
  ValueBasis,
} from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { addMonthsClamped, monthKey, today } from "../src/lib/date.js";

const OPS_PASSWORD = "2026";
const MATRIX_TENANT_CODE = "MATRIXCORE";
const OPS_TENANT_CODE_RE = /^OPS\d{3}$/;
const OPS_BASE_MOBILE = 9700000000;

const MODEL_SCOPE = [
  LedgerEntry,
  AuditEvent,
  CashAdjustment,
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
  User,
  Branch,
  Invoice,
  SubscriptionUpgradeRequest,
];

const OP_DIMENSIONS = [
  { key: "customerSelfEnrolEnabled", values: [true, false] },
  { key: "customerSelfRegistrationEnabled", values: [true, false] },
  { key: "customerAppWriteEnabled", values: [true, false] },
  { key: "customerAppPaymentsEnabled", values: [true, false] },
  { key: "requireKycForEnrolment", values: [true, false] },
  { key: "oneActiveSchemePerCustomer", values: [true, false] },
  { key: "customerLoginMode", values: [CustomerLoginMode.OTP_ONLY, CustomerLoginMode.PASSWORD_ONLY] },
];

function combinations(dimensions, seed = [{}]) {
  return dimensions.reduce((rows, dim) => {
    const next = [];
    for (const row of rows) {
      for (const value of dim.values) {
        next.push({ ...row, [dim.key]: value });
      }
    }
    return next;
  }, seed);
}

function fixedPlanBody({ code, name, valueBasis }) {
  return {
    name,
    code,
    displayName: name,
    valueBasis,
    paymentPattern: PaymentPattern.FIXED,
    durationMonths: 12,
    installmentCount: 12,
    amountRules: {
      amountMode: "JEWELLER_FIXED",
      fixedAmountPaise: 200_000,
      minInstallmentPaise: 200_000,
      maxInstallmentPaise: 200_000,
    },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      graceDays: 5,
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
      firstInstallmentModeEditable: true,
    },
    paymentRules: {
      partialPaymentAllowed: true,
      advancePaymentAllowed: true,
      maxAdvanceInstallments: 2,
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
    status: SchemePlanStatus.ACTIVE,
  };
}

function flexPlanBody({ code, name, valueBasis }) {
  return {
    name,
    code,
    displayName: name,
    valueBasis,
    paymentPattern: PaymentPattern.FLEXIBLE,
    durationMonths: 12,
    installmentCount: 12,
    amountRules: {
      amountMode: "CUSTOMER_CHOSEN",
      minInstallmentPaise: 10_000,
      maxInstallmentPaise: 500_000,
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
      maxPaymentPerTransactionPaise: 500_000,
    },
    flexibleRules: {
      phaseMode: "FLEXIBLE_THEN_CAPPED",
      capMode: "FLEXIBLE_PHASE_AVERAGE",
      carryForwardMode: "NONE",
      flexiblePhaseCycles: 6,
      cappedPhaseCycles: 6,
      averagingDivisor: 6,
      frequencyMode: "MULTIPLE",
      flexiblePhase: {
        minimumPaymentPaise: 10_000,
        maximumPaymentPaise: 500_000,
        paymentIncrementPaise: 100,
      },
      capComputation: {
        formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
        roundingMode: "ROUND_UP",
        roundToNearestPaise: 100,
        minCycleCapPaise: 100_000,
      },
      cappedPhase: {
        minimumPaymentPaise: 10_000,
        paymentIncrementPaise: 100,
        allowFinalRemainderBelowMinimum: true,
        allowFutureCyclePayment: true,
        maxAdvanceCycles: 2,
      },
    },
    benefit: {
      type: "TEXT_ONLY",
      displayLabel: "Benefit as per plan terms",
      eligibility: { requireAllInstallmentsPaid: false, maxAllowedDefaults: 12, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      prematureClosureAllowed: true,
      lockInMonths: 3,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 2, benefitTreatment: "FORFEIT" },
      allowedModes: ["CASH", "GOLD_HANDOVER", "PURCHASE_ADJUSTMENT"],
      redeemAtAnyBranch: true,
    },
    availability: { allBranches: true, branchIds: [], visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
    status: SchemePlanStatus.ACTIVE,
  };
}

function fixedInstallmentsForStatus(status) {
  const due = addMonthsClamped(today(), -1).format("YYYY-MM-DD");
  if (status === SchemeStatus.REDEEMED || status === SchemeStatus.MATURED) {
    return [{ number: 1, dueDate: due, amountPaise: 200_000, paidPaise: 200_000, status: "PAID", graceEndsAt: due }];
  }
  if (status === SchemeStatus.DEFAULTED) {
    return [{ number: 1, dueDate: due, amountPaise: 200_000, paidPaise: 0, status: "OVERDUE", graceEndsAt: due }];
  }
  if (status === SchemeStatus.PENDING_PAYMENT) {
    return [{ number: 1, dueDate: due, amountPaise: 200_000, paidPaise: 0, status: "PENDING", graceEndsAt: due }];
  }
  return [{ number: 1, dueDate: due, amountPaise: 200_000, paidPaise: 100_000, status: "PARTIALLY_PAID", graceEndsAt: due }];
}

function flexCyclesForStatus(status, phase) {
  const current = monthKey();
  const prev = addMonthsClamped(current, -1).format("YYYY-MM");
  if (phase === FlexiblePhase.FLEXIBLE) {
    const paid = status === SchemeStatus.REDEEMED || status === SchemeStatus.MATURED ? 200_000 : 50_000;
    return [{ cycle: current, capPaise: 0, paidPaise: paid, remainingPaise: 0, status: "PARTIALLY_PAID", expiresAt: `${current}-30` }];
  }
  if (status === SchemeStatus.DEFAULTED) {
    return [{ cycle: prev, capPaise: 200_000, paidPaise: 0, remainingPaise: 200_000, status: "EXPIRED", expiresAt: `${prev}-28` }];
  }
  if (status === SchemeStatus.REDEEMED || status === SchemeStatus.MATURED) {
    return [{ cycle: prev, capPaise: 200_000, paidPaise: 200_000, remainingPaise: 0, status: "PAID", expiresAt: `${prev}-28` }];
  }
  if (status === SchemeStatus.PENDING_PAYMENT) {
    return [{ cycle: current, capPaise: 200_000, paidPaise: 0, remainingPaise: 200_000, status: "UPCOMING", expiresAt: `${current}-30` }];
  }
  return [{ cycle: current, capPaise: 200_000, paidPaise: 60_000, remainingPaise: 140_000, status: "PARTIALLY_PAID", expiresAt: `${current}-30` }];
}

async function wipeTenantsByCodeFilter(filter) {
  const tenants = await Tenant.find(filter).select("_id").lean();
  if (!tenants.length) return 0;
  const tenantIds = tenants.map((row) => row._id);

  for (const Model of MODEL_SCOPE) {
    await Model.collection.deleteMany({ tenantId: { $in: tenantIds } });
  }
  await Counter.collection.deleteMany({ _id: { $regex: `^(${tenantIds.join("|")}):` } });
  await Tenant.collection.deleteMany({ _id: { $in: tenantIds } });
  return tenantIds.length;
}

async function ensureSubscriptionPlans() {
  const defaults = [
    { tier: PlanTier.STARTER, name: "Starter", monthlyPricePaise: 300000, sortOrder: 1 },
    { tier: PlanTier.GROWTH, name: "Growth", monthlyPricePaise: 500000, sortOrder: 2 },
    { tier: PlanTier.PRO, name: "Pro", monthlyPricePaise: 800000, sortOrder: 3 },
  ];
  for (const row of defaults) {
    await SubscriptionPlan.updateOne(
      { tier: row.tier, billingCycle: BillingCycle.MONTHLY },
      {
        $set: {
          tier: row.tier,
          name: row.name,
          sortOrder: row.sortOrder,
          billingCycle: BillingCycle.MONTHLY,
          monthlyPricePaise: row.monthlyPricePaise,
          pricePaise: row.monthlyPricePaise,
          active: true,
        },
        $setOnInsert: { _id: createId("subscription") },
      },
      { upsert: true },
    );
  }
}

async function createOpsTenant(index, ops, passwordHash) {
  const code = `OPS${String(index + 1).padStart(3, "0")}`;
  const tenantId = createId("tenant");
  const branchId = createId("branch");
  const ownerId = createId("user");
  const customerId = createId("customer");
  const ownerMobile = String(OPS_BASE_MOBILE + index);
  const customerMobile = String(OPS_BASE_MOBILE + 500 + index);
  const branchCode = `B${String((index % 99) + 1).padStart(2, "0")}`;

  const tenant = await Tenant.create({
    _id: tenantId,
    code,
    name: `Operations Matrix ${String(index + 1).padStart(3, "0")}`,
    status: TenantStatus.ACTIVE,
    mobile: `+91${ownerMobile}`,
    email: `${code.toLowerCase()}@example.test`,
    settings: {
      requireKycForEnrolment: ops.requireKycForEnrolment,
      oneActiveSchemePerCustomer: ops.oneActiveSchemePerCustomer,
    },
    operations: {
      multiSchemePerCustomer: !ops.oneActiveSchemePerCustomer,
      customerSelfEnrolEnabled: ops.customerSelfEnrolEnabled,
      customerSelfRegistrationEnabled: ops.customerSelfRegistrationEnabled,
      customerLoginMode: ops.customerLoginMode,
      customerAppWriteEnabled: ops.customerAppWriteEnabled,
      customerAppPaymentsEnabled: ops.customerAppPaymentsEnabled,
      receiptPrefix: code,
      termsAndConditions: "Coverage seed tenant",
    },
    subscription: {
      tier: PlanTier.GROWTH,
      status: "ACTIVE",
      startsAt: new Date(),
      limits: { activeCustomers: 1000, branches: 5, staff: 10, schemePlans: 10, whatsappMessages: 5000 },
    },
  });

  await Branch.create({
    _id: branchId,
    tenantId,
    code: branchCode,
    name: "Main Branch",
    isHeadOffice: true,
    active: true,
  });

  await User.create({
    _id: ownerId,
    type: UserType.TENANT_USER,
    tenantId,
    branchId,
    role: TenantRole.TENANT_OWNER,
    name: `Owner ${code}`,
    mobile: ownerMobile,
    email: `${code.toLowerCase()}-owner@example.test`,
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_OWNER],
  });

  const customer = await Customer.create({
    _id: customerId,
    tenantId,
    branchId,
    customerNumber: `CUS-${String(index + 1).padStart(6, "0")}`,
    passbookNumber: `${branchCode}/OPS/${String(index + 1).padStart(5, "0")}`,
    name: `Customer ${code}`,
    mobile: customerMobile,
    status: CustomerStatus.ACTIVE,
    kyc: { status: ops.requireKycForEnrolment ? "SUBMITTED" : "VERIFIED", verifiedAt: new Date() },
    passwordHash,
    profileCompletedAt: new Date(),
  });

  const fixedPlan = await SchemePlan.create({
    _id: createId("plan"),
    tenantId,
    ...fixedPlanBody({ code: `F${String(index + 1).padStart(3, "0")}`, name: "Fixed Coverage Plan", valueBasis: ValueBasis.CASH }),
    createdBy: ownerId,
    version: 1,
  });

  const flexPlan = await SchemePlan.create({
    _id: createId("plan"),
    tenantId,
    ...flexPlanBody({ code: `X${String(index + 1).padStart(3, "0")}`, name: "Flexible Coverage Plan", valueBasis: ValueBasis.CASH }),
    createdBy: ownerId,
    version: 1,
  });

  const startDate = addMonthsClamped(today(), -2).format("YYYY-MM-DD");
  const maturityDate = addMonthsClamped(today(), 10).format("YYYY-MM-DD");

  await Scheme.create({
    _id: createId("scheme"),
    tenantId,
    branchId,
    customerId: customer._id,
    planId: fixedPlan._id,
    enrollmentNumber: `${branchCode}-FX-${String(index + 1).padStart(5, "0")}`,
    planSnapshot: fixedPlan.toObject(),
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate,
    maturityDate,
    installmentAmountPaise: 200_000,
    installments: fixedInstallmentsForStatus(SchemeStatus.ACTIVE),
    version: 1,
    createdBy: ownerId,
  });

  await Scheme.create({
    _id: createId("scheme"),
    tenantId,
    branchId,
    customerId: customer._id,
    planId: flexPlan._id,
    enrollmentNumber: `${branchCode}-FL-${String(index + 1).padStart(5, "0")}`,
    planSnapshot: flexPlan.toObject(),
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FLEXIBLE,
    status: SchemeStatus.LOCKED,
    flexiblePhase: FlexiblePhase.CAPPED,
    lockedAveragePaise: 200_000,
    startDate,
    maturityDate,
    cycles: flexCyclesForStatus(SchemeStatus.LOCKED, FlexiblePhase.CAPPED),
    positionVersion: 1,
    version: 1,
    createdBy: ownerId,
  });

  return { code, ownerMobile, customerMobile, tenant };
}

async function createMatrixCoreTenant(passwordHash) {
  const tenantId = createId("tenant");
  const branchId = createId("branch");
  const ownerId = createId("user");
  const customerId = createId("customer");

  await Tenant.create({
    _id: tenantId,
    code: MATRIX_TENANT_CODE,
    name: "Scheme Status Matrix Core",
    status: TenantStatus.ACTIVE,
    mobile: "+919799999901",
    email: "matrixcore@example.test",
    settings: { requireKycForEnrolment: true, oneActiveSchemePerCustomer: false },
    operations: {
      multiSchemePerCustomer: true,
      customerSelfEnrolEnabled: true,
      customerSelfRegistrationEnabled: true,
      customerLoginMode: CustomerLoginMode.OTP_ONLY,
      customerAppWriteEnabled: true,
      customerAppPaymentsEnabled: true,
      receiptPrefix: "MX",
    },
    subscription: {
      tier: PlanTier.PRO,
      status: "ACTIVE",
      startsAt: new Date(),
      limits: { activeCustomers: 5000, branches: 25, staff: 50, schemePlans: 50, whatsappMessages: 25000 },
    },
  });

  await Branch.create({
    _id: branchId,
    tenantId,
    code: "MX1",
    name: "Matrix HQ",
    isHeadOffice: true,
    active: true,
  });

  await User.create({
    _id: ownerId,
    type: UserType.TENANT_USER,
    tenantId,
    branchId,
    role: TenantRole.TENANT_OWNER,
    name: "Matrix Owner",
    mobile: "9799999901",
    email: "matrix-owner@example.test",
    passwordHash,
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_OWNER],
  });

  const customer = await Customer.create({
    _id: customerId,
    tenantId,
    branchId,
    customerNumber: "CUS-900001",
    passbookNumber: "MX1/MAT/00001",
    name: "Matrix Customer",
    mobile: "9799999902",
    status: CustomerStatus.ACTIVE,
    kyc: { status: "VERIFIED", verifiedAt: new Date() },
    passwordHash,
    profileCompletedAt: new Date(),
  });

  const typeSpecs = [
    {
      key: "FIXED_CASH",
      paymentPattern: PaymentPattern.FIXED,
      valueBasis: ValueBasis.CASH,
      phase: null,
      planBody: fixedPlanBody({ code: "MXFC", name: "Matrix Fixed Cash", valueBasis: ValueBasis.CASH }),
    },
    {
      key: "FIXED_GOLD",
      paymentPattern: PaymentPattern.FIXED,
      valueBasis: ValueBasis.GOLD_WEIGHT,
      phase: null,
      planBody: fixedPlanBody({ code: "MXFG", name: "Matrix Fixed Gold", valueBasis: ValueBasis.GOLD_WEIGHT }),
    },
    {
      key: "FLEX_FREE_CASH",
      paymentPattern: PaymentPattern.FLEXIBLE,
      valueBasis: ValueBasis.CASH,
      phase: FlexiblePhase.FLEXIBLE,
      planBody: flexPlanBody({ code: "MXFF", name: "Matrix Flex Free", valueBasis: ValueBasis.CASH }),
    },
    {
      key: "FLEX_CAP_CASH",
      paymentPattern: PaymentPattern.FLEXIBLE,
      valueBasis: ValueBasis.CASH,
      phase: FlexiblePhase.CAPPED,
      planBody: flexPlanBody({ code: "MXFL", name: "Matrix Flex Capped Cash", valueBasis: ValueBasis.CASH }),
    },
    {
      key: "FLEX_CAP_GOLD",
      paymentPattern: PaymentPattern.FLEXIBLE,
      valueBasis: ValueBasis.GOLD_WEIGHT,
      phase: FlexiblePhase.CAPPED,
      planBody: flexPlanBody({ code: "MXFG2", name: "Matrix Flex Capped Gold", valueBasis: ValueBasis.GOLD_WEIGHT }),
    },
  ];

  const plans = new Map();
  for (const spec of typeSpecs) {
    const plan = await SchemePlan.create({
      _id: createId("plan"),
      tenantId,
      ...spec.planBody,
      createdBy: ownerId,
      version: 1,
    });
    plans.set(spec.key, plan);
  }

  const statuses = Object.values(SchemeStatus);
  let createdSchemes = 0;
  for (const spec of typeSpecs) {
    const plan = plans.get(spec.key);
    for (const status of statuses) {
      createdSchemes += 1;
      const startDate = addMonthsClamped(today(), -6).format("YYYY-MM-DD");
      const maturityDate = addMonthsClamped(today(), 6).format("YYYY-MM-DD");
      const enrollmentNumber = `MX-${spec.key.slice(0, 2)}-${status.slice(0, 3)}-${String(createdSchemes).padStart(3, "0")}`;

      const payload = {
        _id: createId("scheme"),
        tenantId,
        branchId,
        customerId: customer._id,
        planId: plan._id,
        enrollmentNumber,
        planSnapshot: plan.toObject(),
        valueBasis: spec.valueBasis,
        paymentPattern: spec.paymentPattern,
        status,
        startDate,
        maturityDate,
        version: 1,
        createdBy: ownerId,
      };

      if (spec.paymentPattern === PaymentPattern.FIXED) {
        payload.installmentAmountPaise = 200_000;
        payload.installments = fixedInstallmentsForStatus(status);
      } else {
        payload.flexiblePhase = spec.phase;
        payload.lockedAveragePaise = spec.phase === FlexiblePhase.CAPPED ? 200_000 : 0;
        payload.cycles = flexCyclesForStatus(status, spec.phase);
        payload.positionVersion = 1;
      }

      if (status === SchemeStatus.REDEEMED || status === SchemeStatus.CLOSED_PREMATURE) {
        payload.closedAt = new Date();
      }
      if (status === SchemeStatus.REDEEMED) {
        payload.settlementRequired = false;
      }
      if (status === SchemeStatus.CLOSED_PREMATURE) {
        payload.closureReason = "Seed status coverage";
        payload.settlementRequired = true;
      }
      if (status === SchemeStatus.MATURED) {
        payload.maturityDate = addMonthsClamped(today(), -1).format("YYYY-MM-DD");
      }
      if (status === SchemeStatus.ENROLMENT_EXPIRED) {
        payload.status = SchemeStatus.ENROLMENT_EXPIRED;
      }

      await Scheme.create(payload);
    }
  }
  return { tenantCode: MATRIX_TENANT_CODE, schemeCount: createdSchemes };
}

async function main() {
  const skipDemo = process.argv.includes("--skip-demo");
  if (!skipDemo) {
    process.stdout.write("Running baseline KAIRALI demo seed first...\n");
    const run = spawnSync(process.execPath, ["--env-file=.env", "scripts/seed-demo.js"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    if (run.status !== 0) {
      throw new Error(`seed-demo failed with exit code ${run.status ?? "unknown"}`);
    }
  }

  await connectDatabase();
  try {
    await ensureSubscriptionPlans();
    const removedOps = await wipeTenantsByCodeFilter({ code: OPS_TENANT_CODE_RE });
    const removedMatrix = await wipeTenantsByCodeFilter({ code: MATRIX_TENANT_CODE });

    const passwordHash = await argon2.hash(OPS_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const opCombos = combinations(OP_DIMENSIONS);
    const opsTenants = [];
    for (let i = 0; i < opCombos.length; i += 1) {
      opsTenants.push(await createOpsTenant(i, opCombos[i], passwordHash));
    }

    const matrix = await createMatrixCoreTenant(passwordHash);

    process.stdout.write("\n=== Platform coverage seed complete ===\n");
    process.stdout.write(`Deleted existing coverage tenants: OPS=${removedOps}, MATRIX=${removedMatrix}\n`);
    process.stdout.write(`Baseline KAIRALI refreshed: ${skipDemo ? "no (skipped)" : "yes"}\n`);
    process.stdout.write(`OPS tenants created: ${opsTenants.length} (all operation combinations)\n`);
    process.stdout.write(`Matrix tenant: ${matrix.tenantCode} with ${matrix.schemeCount} scheme-status rows\n`);
    process.stdout.write(`Default password (owners + customers): ${OPS_PASSWORD}\n`);
    process.stdout.write("Sample owner logins:\n");
    for (const row of opsTenants.slice(0, 6)) {
      process.stdout.write(`  - ${row.code}: ${row.ownerMobile} / ${OPS_PASSWORD}\n`);
    }
    process.stdout.write("Matrix login: 9799999901 / 2026 · Customer: 9799999902 / 2026\n");
    process.stdout.write("Re-run anytime: npm run seed:coverage\n");
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
