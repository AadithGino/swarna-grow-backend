import test from "node:test";
import assert from "node:assert/strict";
import { monthKey } from "../src/lib/date.js";
import { summarizeFreeWindowLedgerNet } from "../src/lib/flexible-free-window-net.js";
import { Customer, LedgerEntry, Scheme } from "../src/models/index.js";
import { LedgerEntryType, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { recordPayment } from "../src/services/payment.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("multiple flexible payments in one calendar month accumulate on the same cycle", async () => {
  const cycle = monthKey();
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
    mobile: `+9197${String(Date.now()).slice(-8)}`,
  });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Flex Same Month",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-SM-${Date.now()}`,
    planSnapshot: {
      valueBasis: "CASH",
      paymentPattern: "FLEXIBLE",
      flexibleRules: {
        flexiblePhaseCycles: 2,
        flexiblePhase: {
          minimumPaymentPaise: 10_000,
          maximumPaymentPaise: 2_500_000,
          paymentIncrementPaise: 1_000,
          minTotalPaise: 0,
          maxPaymentsPerCycle: 5,
          paymentsRequiredPerCycle: 0,
        },
        cappedPhase: {
          minimumPaymentPaise: 10_000,
          paymentIncrementPaise: 1_000,
          allowFinalRemainderBelowMinimum: true,
          allowFutureCyclePayment: false,
          maxAdvanceCycles: 0,
        },
      },
    },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    status: "ACTIVE",
    startDate: `${cycle}-01`,
    maturityDate: `${cycle}-28`,
    cycles: [{
      cycle,
      capPaise: 0,
      paidPaise: 0,
      remainingPaise: 0,
      status: "UPCOMING",
    }],
    flexiblePhase: "FLEXIBLE",
    positionVersion: 0,
    ledgerNextSequence: 0,
    createdBy: user._id,
  });

  const amounts = [40_000, 35_000, 25_000];
  let positionVersion = 0;
  for (const amountPaise of amounts) {
    await recordPayment({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      baseUrl: "/api/v1/admin",
      headers: { "user-agent": "test" },
      ip: "127.0.0.1",
      body: {
        schemeId: scheme._id,
        amountPaise,
        mode: "CASH",
        targetCycle: cycle,
        expectedPositionVersion: positionVersion,
      },
      query: { targetCycle: cycle },
    });
    positionVersion += 1;
  }

  const entries = await LedgerEntry.find({
    schemeId: scheme._id,
    type: LedgerEntryType.FREE_WINDOW_PAYMENT,
  }).lean();
  assert.equal(entries.length, 3);
  assert.ok(entries.every((row) => row.cycle === cycle));

  const net = summarizeFreeWindowLedgerNet(entries);
  assert.equal(net.netTotalPaise, amounts.reduce((sum, value) => sum + value, 0));
  assert.equal(net.netPositivePaymentCount, 3);

  const refreshed = await Scheme.findById(scheme._id).lean();
  const cycleRow = refreshed.cycles.find((row) => row.cycle === cycle);
  assert.equal(cycleRow.paidPaise, net.netTotalPaise);
});
