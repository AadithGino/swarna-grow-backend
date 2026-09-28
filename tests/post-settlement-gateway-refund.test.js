import test from "node:test";
import assert from "node:assert/strict";
import { LedgerEntry, Scheme } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { SchemeStatus } from "../src/constants/enums.js";
import { recordPostSettlementGatewayRefund } from "../src/lib/post-settlement-gateway-refund.js";
import { withTransaction } from "../src/lib/transaction.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("post-settlement gateway refund writes ledger reversal and scheme totals", async () => {
  const { tenant, branch } = await seedTenantUser();
  const schemeId = createId("scheme");
  const paymentId = createId("payment");
  const customerId = createId("customer");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: "EN-PS-1",
    planSnapshot: { name: "Plan" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.REDEEMED,
    startDate: "2025-01-01",
    maturityDate: "2026-01-01",
    settlementCompletedAt: new Date(),
    ledgerNextSequence: 0,
  });
  const payment = {
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId,
    amountPaise: 100_000,
    weightMg: 0,
    targetCycle: "2026-01",
  };
  const paymentRefund = {
    _id: createId("paymentRefund"),
    tenantId: tenant._id,
    paymentId,
    amountPaise: 25_000,
    completedAt: new Date(),
  };
  await withTransaction(async (session) => {
    const scheme = await Scheme.findById(schemeId).session(session);
    await recordPostSettlementGatewayRefund({
      session,
      payment,
      scheme,
      paymentRefund,
      refundAmountPaise: 25_000,
      weightDeltaMg: 0,
      providerRefundId: "ref-1",
    });
  });
  const updated = await Scheme.findById(schemeId).lean();
  assert.equal(updated.postSettlementRefundedPaise, 25_000);
  const ledger = await LedgerEntry.find({ schemeId, tenantId: tenant._id }).lean();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].metadata?.postSettlementRefund, true);
  assert.equal(updated.status, SchemeStatus.REDEEMED);
});
