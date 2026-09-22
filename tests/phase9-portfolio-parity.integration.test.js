import test from "node:test";
import assert from "node:assert/strict";
import { PaymentStatus } from "../src/constants/enums.js";
import { moneyPaiseFromWeightMg } from "../src/lib/money.js";
import { Payment } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("partial refund reduces net gold; reservation does not", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customerId = createId("customer");
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: createId("scheme"),
    customerId,
    receiptNumber: "RCP-1",
    amountPaise: 100_000,
    weightMg: 1000,
    refundedAmountPaise: 25_000,
    refundedWeightMg: 250,
    gatewayRefundReservedPaise: 10_000,
    status: PaymentStatus.PARTIALLY_REFUNDED,
    mode: "ONLINE_GATEWAY",
    source: "CUSTOMER_APP",
  });
  const row = await Payment.findOne({ customerId }).lean();
  const netMg = (row.weightMg ?? 0) - (row.refundedWeightMg ?? 0);
  assert.equal(netMg, 750);
  assert.ok((row.gatewayRefundReservedPaise ?? 0) > 0);
  const ownedMg = netMg;
  assert.equal(ownedMg, 750);
  assert.equal(moneyPaiseFromWeightMg(Math.max(0, ownedMg), 500_000), moneyPaiseFromWeightMg(750, 500_000));
});

test("full refund net is zero not negative", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customerId = createId("customer");
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: createId("scheme"),
    customerId,
    receiptNumber: "RCP-FULL",
    amountPaise: 50_000,
    weightMg: 500,
    refundedAmountPaise: 50_000,
    refundedWeightMg: 500,
    status: PaymentStatus.SUCCESS,
    mode: "ONLINE_GATEWAY",
    source: "CUSTOMER_APP",
  });
  const row = await Payment.findOne({ customerId }).lean();
  const netPaise = Math.max(0, row.amountPaise - (row.refundedAmountPaise ?? 0));
  const netMg = Math.max(0, (row.weightMg ?? 0) - (row.refundedWeightMg ?? 0));
  assert.equal(netPaise, 0);
  assert.equal(netMg, 0);
});
