import test from "node:test";
import assert from "node:assert/strict";
import { monthKey } from "../src/lib/date.js";
import { buildFlexibleSchemeCycleRows } from "../src/lib/calendar-cycle.js";
import { LedgerEntry, Payment, PaymentIntent, Scheme } from "../src/models/index.js";
import { LedgerEntryType, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { finalizeGatewaySuccess } from "../src/services/finalize-gateway-success.service.js";
import { payableRange } from "../src/services/scheme.service.js";
import { recordPayment } from "../src/services/payment.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function seedFreePhaseScheme({ startDate, freeCycles = 2, durationMonths = 4 }) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const customerId = customer._id;
  const cycles = buildFlexibleSchemeCycleRows({
    startDate,
    durationMonths,
    firstInstallmentMode: "COLLECT_NOW",
  });
  const flexRules = {
    flexiblePhaseCycles: freeCycles,
    cappedPhaseCycles: durationMonths - freeCycles,
    flexiblePhase: {
      minimumPaymentPaise: 10_000,
      maximumPaymentPaise: 2_500_000,
      paymentIncrementPaise: 1_000,
      minTotalPaise: 0,
      paymentsRequiredPerCycle: 0,
    },
    cappedPhase: {
      minimumPaymentPaise: 10_000,
      paymentIncrementPaise: 1_000,
      allowFinalRemainderBelowMinimum: true,
      allowFutureCyclePayment: false,
      maxAdvanceCycles: 0,
    },
  };
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-FC-${Date.now()}`,
    planSnapshot: { paymentPattern: "FLEXIBLE", flexibleRules: flexRules },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    status: "ACTIVE",
    flexiblePhase: "FLEXIBLE",
    startDate,
    maturityDate: cycles[cycles.length - 1].expiresAt,
    cycles,
    positionVersion: 1,
    ledgerNextSequence: 0,
    createdBy: user._id,
  });
  const staffReq = (targetCycle, expectedPositionVersion = 1) => ({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
    body: {
      schemeId: scheme._id,
      amountPaise: 25_000,
      mode: "CASH",
      targetCycle,
      expectedPositionVersion,
    },
    query: { targetCycle },
  });
  return { tenant, branch, user, scheme, staffReq, cycles, flexRules };
}

test("payableRange uses current calendar month in free phase", async () => {
  const current = monthKey();
  const { scheme } = await seedFreePhaseScheme({
    startDate: `${current}-01`,
    freeCycles: 2,
    durationMonths: 4,
  });
  const quote = await payableRange(
    { query: {}, body: {} },
    scheme.toObject(),
  );
  assert.equal(quote.targetCycle, current);
  assert.equal(quote.phase, "FLEXIBLE");
});

test("rejects past month targetCycle in free phase", async () => {
  const current = monthKey();
  const past = shiftMonth(current, -1);
  const { scheme } = await seedFreePhaseScheme({
    startDate: `${past}-01`,
    freeCycles: 3,
    durationMonths: 5,
  });
  await assert.rejects(
    () => payableRange({ query: { targetCycle: past }, body: { targetCycle: past } }, scheme.toObject()),
    (error) => error.code === "INVALID_PAYMENT_CYCLE",
  );
});

test("rejects future month targetCycle in free phase", async () => {
  const current = monthKey();
  const future = shiftMonth(current, 1);
  const { scheme } = await seedFreePhaseScheme({
    startDate: `${current}-01`,
    freeCycles: 3,
    durationMonths: 5,
  });
  await assert.rejects(
    () => payableRange({ query: { targetCycle: future }, body: { targetCycle: future } }, scheme.toObject()),
    (error) => error.code === "INVALID_PAYMENT_CYCLE",
  );
});

test("rejects nonexistent month targetCycle", async () => {
  const current = monthKey();
  const { scheme } = await seedFreePhaseScheme({
    startDate: `${current}-01`,
    freeCycles: 2,
    durationMonths: 4,
  });
  await assert.rejects(
    () => payableRange({ query: { targetCycle: "2099-13" }, body: {} }, scheme.toObject()),
    (error) => error.code === "INVALID_PAYMENT_CYCLE",
  );
});

test("rejects payment before first scheme calendar cycle", async () => {
  const next = shiftMonth(monthKey(), 1);
  const { scheme } = await seedFreePhaseScheme({
    startDate: `${next}-15`,
    freeCycles: 2,
    durationMonths: 4,
  });
  await assert.rejects(
    () => payableRange({ query: {}, body: {} }, scheme.toObject()),
    (error) => error.code === "INVALID_PAYMENT_CYCLE",
  );
});

test("rejects free-window payment after free phase calendar window", async () => {
  const current = monthKey();
  const start = shiftMonth(current, -3);
  const { scheme } = await seedFreePhaseScheme({
    startDate: `${start}-01`,
    freeCycles: 2,
    durationMonths: 4,
  });
  await assert.rejects(
    () => payableRange({ query: {}, body: {} }, scheme.toObject()),
    (error) => error.code === "FLEXIBLE_FREE_PHASE_ENDED",
  );
});

test("manual staff payment persists authoritative cycle on ledger", async () => {
  const current = monthKey();
  const { scheme, staffReq } = await seedFreePhaseScheme({
    startDate: `${current}-01`,
    freeCycles: 2,
    durationMonths: 4,
  });
  await recordPayment(staffReq(current));
  const entry = await LedgerEntry.findOne({ schemeId: scheme._id }).lean();
  assert.equal(entry.type, LedgerEntryType.FREE_WINDOW_PAYMENT);
  assert.equal(entry.cycle, current);
});

test("invalid targetCycle creates no ledger row", async () => {
  const current = monthKey();
  const past = shiftMonth(current, -1);
  const { scheme, staffReq } = await seedFreePhaseScheme({
    startDate: `${current}-01`,
    freeCycles: 2,
    durationMonths: 4,
  });
  await assert.rejects(
    () => recordPayment(staffReq(past)),
    (error) => error.code === "INVALID_PAYMENT_CYCLE",
  );
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id }), 0);
});

test("gateway finalization uses reserved intent cycle not tampered callback cycle", async () => {
  const current = monthKey();
  const tampered = shiftMonth(current, -1);
  const { tenant, scheme } = await seedFreePhaseScheme({
    startDate: `${current}-01`,
    freeCycles: 2,
    durationMonths: 4,
  });
  const paymentId = createId("payment");
  const intentId = createId("paymentIntent");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise: 25_000,
    mode: "ONLINE_GATEWAY",
    status: "PENDING",
    source: "CUSTOMER_APP",
    paidAt: new Date(),
    targetCycle: tampered,
  });
  const intent = await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    paymentId,
    amountPaise: 25_000,
    status: "PENDING",
    targetCycle: current,
    positionVersion: 1,
    reservationExpiresAt: new Date(Date.now() + 3600_000),
    version: 1,
  }).then((row) => row.toObject());

  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 25_000,
    intent,
    paymentId,
  });

  const entry = await LedgerEntry.findOne({ schemeId: scheme._id, paymentId }).lean();
  assert.ok(entry);
  assert.equal(entry.cycle, current);
  assert.notEqual(entry.cycle, tampered);
});
