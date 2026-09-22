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

test("moneyPaiseFromWeightMg handles non-divisible mg and rate", () => {
  assert.equal(moneyPaiseFromWeightMg(333, 555_555), 185_000);
  assert.equal(moneyPaiseFromWeightMg(0, 555_555), 0);
});

test("net portfolio weight after partial refund is non-negative", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customerId = createId("customer");
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: createId("scheme"),
    customerId,
    receiptNumber: "RCP-PF",
    amountPaise: 100_000,
    weightMg: 1000,
    refundedAmountPaise: 25000,
    refundedWeightMg: 250,
    status: PaymentStatus.PARTIALLY_REFUNDED,
    mode: "ONLINE_GATEWAY",
    source: "CUSTOMER_APP",
  });
  const rows = await Payment.find({
    tenantId: tenant._id,
    customerId,
    status: { $in: [PaymentStatus.SUCCESS, PaymentStatus.PARTIALLY_REFUNDED] },
  }).lean();
  const goldMg = rows.reduce((s, p) => s + (p.weightMg ?? 0) - (p.refundedWeightMg ?? 0), 0);
  assert.equal(goldMg, 750);
  const rate = 500_000;
  assert.equal(moneyPaiseFromWeightMg(goldMg, rate), moneyPaiseFromWeightMg(750, rate));
});
