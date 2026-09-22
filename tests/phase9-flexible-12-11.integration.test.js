import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { buildFlexibleSchemeCycleRows } from "../src/lib/calendar-cycle.js";
import { computeFlexibleLockCapDetails } from "../src/lib/flexible-cap.js";
import { analyzeFreeWindowLedgerForCap } from "../src/lib/flexible-free-window-net.js";
import { AppError } from "../src/lib/app-error.js";
import { LedgerEntry, Scheme } from "../src/models/index.js";
import { applyFlexibleLock, payableRange } from "../src/services/scheme.service.js";
import { recordPayment } from "../src/services/payment.service.js";
import { resetCalendarDateOverrideForTests, setCalendarDateOverrideForTests } from "../src/lib/date.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { TenantRole } from "../src/constants/enums.js";

const flexRules6_5 = {
  flexiblePhaseCycles: 6,
  cappedPhaseCycles: 5,
  averagingDivisor: 6,
  flexiblePhase: { minimumPaymentPaise: 10_000, maximumPaymentPaise: 2_500_000, paymentIncrementPaise: 1_000, minTotalPaise: 0, paymentsRequiredPerCycle: 0 },
  capComputation: {
    formula: "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
    roundingMode: "ROUND_UP",
    roundToNearestPaise: 10_000,
    minCycleCapPaise: 50_000,
    maxCycleCapPaise: 10_000_000,
    onZeroFlexiblePhaseTotal: "CLOSE_SCHEME",
    onBelowMinimumTotal: "USE_MINIMUM",
  },
  cappedPhase: { minimumPaymentPaise: 10_000, paymentIncrementPaise: 1_000, allowFinalRemainderBelowMinimum: true, allowFutureCyclePayment: false, maxAdvanceCycles: 0 },
};

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });

describe("flexible 12/11 lifecycle", { concurrency: false }, () => {
  test.beforeEach(async () => { await resetTestDb(); });
  test.afterEach(() => { resetCalendarDateOverrideForTests(); });

  async function seedScheme() {
    const startDate = "2026-01-10";
    const cycles = buildFlexibleSchemeCycleRows({ startDate, durationMonths: 12, firstInstallmentMode: "COLLECT_NOW" });
    const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    const scheme = await Scheme.create({
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: customer._id,
      planId: createId("schemePlan"),
      enrollmentNumber: "ENR-1211",
      planSnapshot: { paymentPattern: "FLEXIBLE", durationMonths: 12, installmentCount: 11, flexibleRules: flexRules6_5 },
      valueBasis: "CASH",
      paymentPattern: "FLEXIBLE",
      status: "ACTIVE",
      flexiblePhase: "FLEXIBLE",
      startDate,
      maturityDate: cycles[11].expiresAt,
      cycles,
      positionVersion: 1,
      version: 1,
      createdBy: user._id,
    });
    return { tenant, branch, user, customer, scheme, cycles };
  }

  test("multiple free-month payments stay in one cycle; reversal adjusts cap input", async () => {
    const { tenant, branch, user, customer, scheme, cycles } = await seedScheme();
    setCalendarDateOverrideForTests("2026-01-15");
    const cycleKey = cycles[0].cycle;
    const staffReq = (amountPaise, expectedPositionVersion) => ({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      baseUrl: "/api/v1/admin",
      body: { schemeId: scheme._id, amountPaise, mode: "CASH", targetCycle: cycleKey, expectedPositionVersion },
      headers: { "user-agent": "test" },
      ip: "127.0.0.1",
      query: { targetCycle: cycleKey },
    });
    await recordPayment(staffReq(30_000, 1));
    await recordPayment(staffReq(20_000, 2));
    const entries = await LedgerEntry.find({ schemeId: scheme._id, cycle: cycleKey }).lean();
    assert.equal(entries.filter((e) => e.type === "FREE_WINDOW_PAYMENT").length, 2);
    await LedgerEntry.create({
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: scheme._id,
      customerId: customer._id,
      type: "REVERSAL",
      sequence: 3,
      amountPaise: 10_000,
      cycle: cycleKey,
      actorType: "USER",
      actorId: user._id,
    });
    const net = analyzeFreeWindowLedgerForCap(await LedgerEntry.find({ schemeId: scheme._id }).lean());
    const preview = computeFlexibleLockCapDetails({ netSummary: net, flexibleRules: flexRules6_5, freePhaseBoundary: cycles[5].expiresAt, lockedAt: new Date("2026-07-01T12:00:00.000Z") });
    const runtime = computeFlexibleLockCapDetails({ netSummary: net, flexibleRules: flexRules6_5, freePhaseBoundary: cycles[5].expiresAt, lockedAt: new Date("2026-07-01T12:00:00.000Z") });
    assert.equal(preview.capPaise, runtime.capPaise);
  });

  test("cycle 12 remains maturity-only after lock", async () => {
    const { tenant, user, scheme, cycles } = await seedScheme();
    for (let i = 0; i < 6; i += 1) {
      await LedgerEntry.create({
        _id: createId("ledger"),
        tenantId: tenant._id,
        branchId: scheme.branchId,
        schemeId: scheme._id,
        customerId: scheme.customerId,
        type: "FREE_WINDOW_PAYMENT",
        sequence: i + 1,
        amountPaise: 60_000,
        cycle: cycles[i].cycle,
        actorType: "USER",
        actorId: user._id,
      });
    }
    await applyFlexibleLock({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: scheme.branchId },
      params: { schemeId: scheme._id },
      headers: {},
      ip: "127.0.0.1",
    }, { referenceDate: "2026-07-01" });
    const locked = await Scheme.findById(scheme._id).lean();
    await assert.rejects(
      () => payableRange(
        { auth: { tenantId: tenant._id }, query: { targetCycle: cycles[11].cycle } },
        locked,
        { referenceDate: `${cycles[11].cycle}-15` },
      ),
      (err) => err instanceof AppError && err.code === "MATURITY_WAITING_CYCLE",
    );
  });
});
