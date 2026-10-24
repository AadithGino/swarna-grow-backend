import test from "node:test";
import assert from "node:assert/strict";
import "./global-test-db-serial.js";
import { aggregateCollectionDailyAccounting } from "../src/lib/collection-daily-accounting.js";
import { collectionPeriodBaseMatch } from "../src/lib/collection-period-aggregation.js";
import { Payment } from "../src/models/index.js";
import { PaymentStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser } from "./helpers/db.js";

test.beforeEach(async () => {
  await resetTestDb();
});

test("daily rows zero-fill and reconcile net totals", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customerId = createId("cus");
  const schemeId = createId("sch");
  const baseMatch = collectionPeriodBaseMatch({ tenantId: tenant._id, branchId: branch._id });
  const from = "2026-10-01";
  const to = "2026-10-03";

  await Payment.create([
    {
      _id: createId("pay"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId,
      schemeId,
      receiptNumber: "RCP-TEST-1",
      amountPaise: 10_000,
      status: PaymentStatus.SUCCESS,
      mode: "CASH",
      paidAt: new Date("2026-10-01T10:00:00+05:30"),
      collectedBy: user._id,
      source: "STAFF_APP",
    },
    {
      _id: createId("pay"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId,
      schemeId,
      receiptNumber: "RCP-TEST-2",
      amountPaise: 5_000,
      status: PaymentStatus.SUCCESS,
      mode: "UPI",
      paidAt: new Date("2026-10-03T10:00:00+05:30"),
      collectedBy: user._id,
      source: "STAFF_APP",
    },
  ]);

  const rows = await aggregateCollectionDailyAccounting(baseMatch, { from, to });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].date, "2026-10-01");
  assert.equal(rows[0].paymentCount, 1);
  assert.equal(rows[0].grossReceiptsPaise, 10_000);
  assert.equal(rows[1].paymentCount, 0);
  assert.equal(rows[2].paymentCount, 1);
  const netSum = rows.reduce((acc, row) => acc + row.netCollectedPaise, 0);
  assert.equal(netSum, 15_000);
});
