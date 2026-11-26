/**
 * Shazana demo: flex 6+5 showcase customer, sample payments, self-enrol flags, demo entry pointers.
 */
import argon2 from "argon2";
import {
  FlexiblePhase,
  SchemeStatus,
  TenantRole,
  UserStatus,
  UserType,
} from "../../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../../src/constants/permissions.js";
import { addMonthsClamped, monthKey, today } from "../../src/lib/date.js";
import { buildFlexibleSchemeCycleRows } from "../../src/lib/calendar-cycle.js";
import { createId } from "../../src/lib/ids.js";
import {
  Branch,
  Customer,
  Payment,
  Scheme,
  SchemePlan,
  Tenant,
  User,
} from "../../src/models/index.js";
import { recordPayment } from "../../src/services/payment.service.js";
import { nextSequence } from "../../src/services/sequence.service.js";

const SHOWCASE_NAME = "Flexi Amal";

function flexPaymentReq(ctx, schemeId, { amountPaise, expectedPositionVersion, targetCycle }) {
  return {
    ...ctx,
    body: {
      schemeId,
      amountPaise,
      mode: "CASH",
      targetCycle,
      expectedPositionVersion,
    },
    query: { targetCycle },
    auth: ctx.auth,
    scope: ctx.scope,
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "shazana-flex-demo-showcase" },
    ip: "127.0.0.1",
  };
}

async function ensurePatchOwner(tenantId, branchId) {
  let owner = await User.findOne({
    tenantId,
    role: TenantRole.TENANT_OWNER,
    status: UserStatus.ACTIVE,
  });
  if (owner) return owner;
  owner = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId,
    branchId,
    role: TenantRole.TENANT_OWNER,
    name: "Demo Owner",
    mobile: `+9197000${String(Date.now()).slice(-6)}`,
    passwordHash: await argon2.hash("patch-owner", { type: argon2.argon2id }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_OWNER] ?? [],
  });
  return owner;
}

async function findShowcaseCustomer(tenantId) {
  return (
    (await Customer.findOne({ tenantId, name: SHOWCASE_NAME }).lean())
    ?? (await Customer.findOne({ tenantId, isDemo: true }).sort({ createdAt: 1 }).lean())
  );
}

export async function seedShazanaFlexDemoShowcase(tenantId, flexPlanId) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

  const plan = await SchemePlan.findOne({ _id: flexPlanId, tenantId }).lean();
  if (!plan || plan.code !== "FLEXI11") {
    throw new Error("Active FLEXI11 plan required before showcase seed.");
  }

  const branch =
    (await Branch.findOne({ tenantId, isHeadOffice: true, active: true }).lean())
    ?? (await Branch.findOne({ tenantId, active: true }).lean());
  if (!branch) throw new Error("No active branch for showcase enrolment.");

  const owner = await ensurePatchOwner(tenantId, branch._id);
  const ownerCtx = {
    auth: {
      id: owner._id,
      tenantId,
      type: UserType.TENANT_USER,
      role: TenantRole.TENANT_OWNER,
    },
    scope: { tenantId, branchId: branch._id },
    tenant,
  };

  let customer = await findShowcaseCustomer(tenantId);
  if (!customer) {
    throw new Error(`Showcase customer ${SHOWCASE_NAME} not found on tenant.`);
  }
  await Customer.updateOne(
    { _id: customer._id },
    { $set: { isDemo: true, createdAt: new Date("2020-01-01T00:00:00.000Z") } },
  );
  customer = await Customer.findById(customer._id).lean();

  const startDate = addMonthsClamped(today(), -2).format("YYYY-MM-DD");
  const cycles = buildFlexibleSchemeCycleRows({
    startDate,
    durationMonths: plan.durationMonths,
    firstInstallmentMode: "COLLECT_NOW",
  });
  const maturityDate = cycles.at(-1)?.expiresAt?.slice(0, 10) ?? startDate;

  let scheme = await Scheme.findOne({
    tenantId,
    customerId: customer._id,
    paymentPattern: "FLEXIBLE",
  }).sort({ createdAt: -1 });

  if (scheme) {
    scheme.set({
      planId: plan._id,
      planSnapshot: plan,
      valueBasis: plan.valueBasis,
      paymentPattern: plan.paymentPattern,
      status: SchemeStatus.ACTIVE,
      startDate,
      maturityDate,
      cycles,
      flexiblePhase: FlexiblePhase.FLEXIBLE,
      positionVersion: 0,
    });
    scheme.version += 1;
    await scheme.save();
  } else {
    const enrolNo = await nextSequence(tenantId, "scheme");
    scheme = await Scheme.create({
      _id: createId("scheme"),
      tenantId,
      branchId: branch._id,
      customerId: customer._id,
      planId: plan._id,
      enrollmentNumber: `ENR-${String(enrolNo).padStart(7, "0")}`,
      planSnapshot: plan,
      valueBasis: plan.valueBasis,
      paymentPattern: plan.paymentPattern,
      status: SchemeStatus.ACTIVE,
      startDate,
      maturityDate,
      cycles,
      flexiblePhase: FlexiblePhase.FLEXIBLE,
      positionVersion: 0,
      version: 1,
      createdBy: owner._id,
    });
  }

  await Scheme.updateMany(
    {
      tenantId,
      customerId: customer._id,
      _id: { $ne: scheme._id },
      status: { $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED, SchemeStatus.PENDING_PAYMENT] },
    },
    {
      $set: { status: SchemeStatus.CLOSED_PREMATURE, closedAt: new Date() },
      $inc: { version: 1 },
    },
  );

  const [cycle1, cycle2] = cycles.slice(0, 2).map((row) => row.cycle);
  const priorPayments = await Payment.countDocuments({ tenantId, schemeId: scheme._id });
  if (priorPayments === 0) {
    try {
      let doc = scheme;
      const pay = async (amountPaise, targetCycle) => {
        doc = await Scheme.findById(doc._id);
        await recordPayment(
          flexPaymentReq(ownerCtx, doc._id, {
            amountPaise,
            expectedPositionVersion: doc.positionVersion ?? 0,
            targetCycle,
          }),
          {
            referenceDate: `${targetCycle}-15`,
            internalReferenceDateOverride: true,
          },
        );
      };
      await pay(10_000, cycle1);
      await pay(50_000, cycle1);
      await pay(25_000, cycle2);
    } catch (err) {
      console.warn(
        `Showcase: sample payments skipped (${err?.message ?? err}); plan + cycles still refreshed.`,
      );
    }
  } else {
    console.log(`Showcase: kept ${priorPayments} existing payment(s) on ${scheme.enrollmentNumber}`);
  }

  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "operations.customerSelfEnrolEnabled": true,
        "operations.customerSelfRegistrationEnabled": true,
        "operations.multiSchemePerCustomer": true,
        "subscription.tier": "GROWTH",
        "subscription.planFeaturesSnapshot.flexibleScheme": true,
        "subscription.planFeaturesSnapshot.customerSelfEnrol": true,
        "subscription.planFeaturesSnapshot.customerSelfRegistration": true,
        demoEntryCustomerId: customer._id,
        demoEntrySchemeId: scheme._id,
        demoEntryPlanId: plan._id,
      },
      $inc: { version: 1 },
    },
  );

  console.log(
    `Showcase: ${customer.name} → ${scheme.enrollmentNumber} (free phase, cycles ${cycle1}, ${cycle2}; current month ${monthKey()})`,
  );
  return { customer, scheme, plan };
}