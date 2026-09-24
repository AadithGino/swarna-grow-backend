import test from "node:test";
import assert from "node:assert/strict";
import { monthKey } from "../src/lib/date.js";
import { Customer, LedgerEntry, Redemption, Scheme } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  ClosureType,
  LedgerEntryType,
  RedemptionMode,
  RedemptionStatus,
  SchemeStatus,
  TenantRole,
} from "../src/constants/enums.js";
import { withTransaction } from "../src/lib/transaction.js";
import { nextSchemeLedgerSequence } from "../src/services/sequence.service.js";
import { recordPayment } from "../src/services/payment.service.js";
import {
  initiateRedemption,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("parallel ledger allocations receive unique sequences", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-SEQ-${Date.now()}`,
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    ledgerNextSequence: 1,
    version: 1,
    createdBy: user._id,
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    sequence: 1,
    amountPaise: 10000,
    actorType: "USER",
    actorId: user._id,
    description: "seed",
  });

  const allocate = () => withTransaction(async (session) => {
    const sequence = await nextSchemeLedgerSequence(tenant._id, scheme._id, session);
    await LedgerEntry.create(
      [{
        _id: createId("ledger"),
        tenantId: tenant._id,
        branchId: branch._id,
        schemeId: scheme._id,
        customerId: customer._id,
        type: LedgerEntryType.INSTALLMENT_PAYMENT,
        sequence,
        amountPaise: 1000,
        actorType: "USER",
        actorId: user._id,
        description: `seq-${sequence}`,
      }],
      { session },
    );
    return sequence;
  });

  const sequences = await Promise.all(Array.from({ length: 8 }, () => allocate()));
  assert.equal(new Set(sequences).size, sequences.length);
  assert.deepEqual([...sequences].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9]);
});

test("concurrent payment and redemption completion allocate unique ledger sequences", async () => {
  const cycle = monthKey();
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Seq Race",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
    kyc: { status: "VERIFIED", type: "PAN", numberMasked: "XXXX1234" },
  });
  const paid = 200_000;
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-MIX-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FLEXIBLE",
      valueBasis: "CASH",
      flexibleRules: {
        flexiblePhaseCycles: 2,
        flexiblePhase: {
          minimumPaymentPaise: 10_000,
          maximumPaymentPaise: 2_500_000,
          paymentIncrementPaise: 1_000,
          minTotalPaise: 0,
          maxPaymentsPerCycle: 5,
        },
        cappedPhase: {
          minimumPaymentPaise: 10_000,
          paymentIncrementPaise: 1_000,
          allowFinalRemainderBelowMinimum: true,
          allowFutureCyclePayment: false,
          maxAdvanceCycles: 0,
        },
      },
      redemptionRules: {
        allowedModes: [RedemptionMode.CASH],
        prematureClosureAllowed: true,
        lockInMonths: 0,
        prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      },
      benefit: { type: "TEXT_ONLY", displayLabel: "None" },
    },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    status: SchemeStatus.ACTIVE,
    startDate: "2024-01-01",
    maturityDate: "2027-12-01",
    cycles: [{ cycle, capPaise: 0, paidPaise: 0, remainingPaise: 0, status: "UPCOMING" }],
    flexiblePhase: "FLEXIBLE",
    positionVersion: 0,
    version: 1,
    ledgerNextSequence: 1,
    createdBy: user._id,
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    type: LedgerEntryType.FREE_WINDOW_PAYMENT,
    sequence: 1,
    amountPaise: paid,
    paymentId: createId("payment"),
    cycle,
    actorType: "USER",
    actorId: user._id,
    description: "Seed free-window",
  });

  const redemptionReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    body: {
      mode: RedemptionMode.CASH,
      expectedVersion: scheme.version,
      modeDetails: { acknowledgeBenefitForfeit: true },
    },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
  const initiated = await initiateRedemption(
    redemptionReq,
    ClosureType.PREMATURE_CLOSURE,
  );
  const redemptionId = initiated._id;
  await transitionRedemption({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "approve");

  const refreshed = await Scheme.findById(scheme._id).lean();
  const [payResult, redeemResult] = await Promise.allSettled([
    recordPayment({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      baseUrl: "/api/v1/admin",
      headers: { "user-agent": "test" },
      ip: "127.0.0.1",
      body: {
        schemeId: scheme._id,
        amountPaise: 10_000,
        mode: "CASH",
        targetCycle: cycle,
        expectedPositionVersion: refreshed.positionVersion,
      },
      query: { targetCycle: cycle },
    }),
    transitionRedemption({
      auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { redemptionId },
      body: {},
      query: {},
      headers: {},
      ip: "127.0.0.1",
    }, "complete"),
  ]);

  const sequences = await LedgerEntry.find({ schemeId: scheme._id })
    .sort({ sequence: 1 })
    .lean();
  const seqValues = sequences.map((row) => row.sequence);
  assert.equal(new Set(seqValues).size, seqValues.length);
  assert.ok(sequences.length >= 2);
  assert.ok(
    payResult.status === "fulfilled" || redeemResult.status === "fulfilled",
    "expected payment and/or redemption write to succeed",
  );
  const redemptionRows = sequences.filter((row) => row.redemptionId === redemptionId);
  const completed = await Redemption.findById(redemptionId).lean();
  if (redeemResult.status === "fulfilled") {
    assert.ok(redemptionRows.some((row) => row.type === LedgerEntryType.REDEMPTION_DEBIT));
    assert.equal(completed.status, RedemptionStatus.COMPLETED);
  }
});
