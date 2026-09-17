import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/lib/app-error.js";
import { monthKey } from "../src/lib/date.js";
import { recordPayment } from "../src/services/payment.service.js";
import { Customer, Scheme } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { TenantRole } from "../src/constants/enums.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

const cycle = monthKey();

async function seedFlexibleScheme({ positionVersion = 0, remainingPaise = 250000, paidPaise = 0, maxPaymentsPerCycle = 2 } = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER, mobile: `+9197${String(Date.now()).slice(-8)}` });
  const customer = await Customer.create({
    _id: createId("customer"), tenantId: tenant._id, branchId: branch._id, customerNumber: `C${Date.now()}`, name: "Pay Customer", mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-${Date.now()}`,
    planSnapshot: {
      valueBasis: "CASH",
      paymentPattern: "FLEXIBLE",
      flexibleRules: {
        flexiblePhase: { minimumPaymentPaise: 10000, maximumPaymentPaise: 2500000, paymentIncrementPaise: 1000, minTotalPaise: 0, maxPaymentsPerCycle, paymentsRequiredPerCycle: 0 },
        cappedPhase: { minimumPaymentPaise: 10000, paymentIncrementPaise: 1000, allowFinalRemainderBelowMinimum: true, allowFutureCyclePayment: false, maxAdvanceCycles: 0 },
      },
    },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    status: "ACTIVE",
    startDate: `${cycle}-01`,
    maturityDate: `${cycle}-28`,
    cycles: [{ cycle, capPaise: paidPaise + remainingPaise, paidPaise, remainingPaise, status: remainingPaise ? "UPCOMING" : "PAID" }],
    flexiblePhase: "FLEXIBLE",
    positionVersion,
    createdBy: user._id,
  });
  return { tenant, branch, user, customer, scheme };
}

function paymentReq({ scheme, user, amountPaise, expectedPositionVersion, targetCycle = cycle }) {
  return {
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "phase2-test" },
    ip: "127.0.0.1",
    body: { schemeId: scheme._id, amountPaise, mode: "CASH", targetCycle, expectedPositionVersion },
    query: { targetCycle },
  };
}

test("first payment on a brand-new flexible scheme accepts expectedPositionVersion 0", async () => {
  const { scheme, user } = await seedFlexibleScheme({ positionVersion: 0 });
  const result = await recordPayment(paymentReq({ scheme, user, amountPaise: 10000, expectedPositionVersion: 0 }));
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.positionVersion, 1);
});

test("stale expectedPositionVersion returns 409 PAYMENT_POSITION_CHANGED", async () => {
  const { scheme, user } = await seedFlexibleScheme({ positionVersion: 0 });
  await assert.rejects(
    () => recordPayment(paymentReq({ scheme, user, amountPaise: 10000, expectedPositionVersion: 3 })),
    (error) => error instanceof AppError && error.code === "PAYMENT_POSITION_CHANGED" && error.statusCode === 409,
  );
});

test("fully consumed flexible cycle returns CURRENT_CYCLE_CAP_REACHED", async () => {
  const { scheme, user } = await seedFlexibleScheme({ remainingPaise: 0, paidPaise: 250000 });
  // force capped phase so payable can be false for the cycle
  scheme.flexiblePhase = "CAPPED";
  scheme.planSnapshot.flexibleRules.cappedPhase.minimumPaymentPaise = 10000;
  await scheme.save();
  await assert.rejects(
    () => recordPayment(paymentReq({ scheme, user, amountPaise: 10000, expectedPositionVersion: 0 })),
    (error) => error.code === "CURRENT_CYCLE_CAP_REACHED" && error.details?.remainingThisCyclePaise === 0,
  );
});

test("maxPaymentsPerCycle applies on recordPayment after confirmed payments", async () => {
  const { scheme, user } = await seedFlexibleScheme({ maxPaymentsPerCycle: 1 });
  await recordPayment(paymentReq({ scheme, user, amountPaise: 10000, expectedPositionVersion: 0 }));
  const refreshed = await Scheme.findById(scheme._id);
  await assert.rejects(
    () => recordPayment(paymentReq({ scheme: refreshed, user, amountPaise: 10000, expectedPositionVersion: refreshed.positionVersion })),
    (error) => error.code === "PAYMENT_COUNT_LIMIT_REACHED",
  );
});

async function seedLockedCappedScheme(options = {}) {
  const seeded = await seedFlexibleScheme(options);
  await Scheme.updateOne(
    { _id: seeded.scheme._id },
    { $set: { flexiblePhase: "CAPPED", status: "LOCKED", positionVersion: 1 } },
  );
  seeded.scheme = await Scheme.findById(seeded.scheme._id);
  return seeded;
}

test("capped cycle payment rejects amounts that are not a multiple of the increment", async () => {
  const { scheme, user } = await seedLockedCappedScheme();
  await assert.rejects(
    () => recordPayment(paymentReq({ scheme, user, amountPaise: 125500, expectedPositionVersion: 1 })),
    (error) => error.code === "AMOUNT_NOT_MULTIPLE",
  );
});

test("capped cycle final remainder below minimum still records when configured", async () => {
  const { scheme, user } = await seedLockedCappedScheme({ paidPaise: 190000, remainingPaise: 60000 });
  const payment = await recordPayment(paymentReq({ scheme, user, amountPaise: 60000, expectedPositionVersion: 1 }));
  assert.equal(payment.amountPaise, 60000);
});
