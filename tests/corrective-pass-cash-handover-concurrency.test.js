import test from "node:test";
import assert from "node:assert/strict";
import { Payment } from "../src/models/index.js";
import { HandoverInitiator, PaymentMode, PaymentSource, PaymentStatus, TenantRole } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { cashBalance, createHandover } from "../src/services/cash.service.js";
import { AppError } from "../src/lib/app-error.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("concurrent handovers serialize so only one succeeds when sum exceeds available", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.BRANCH_STAFF });
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: createId("scheme"),
    customerId: createId("customer"),
    receiptNumber: "RCP-CONC",
    amountPaise: 100_000,
    mode: PaymentMode.CASH,
    status: PaymentStatus.SUCCESS,
    source: PaymentSource.STAFF_APP,
    collectedBy: user._id,
    paidAt: new Date(),
  });
  const baseReq = {
    auth: { id: user._id, tenantId: tenant._id, branchId: branch._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    body: { amountPaise: 60_000 },
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
  };
  const outcomes = await Promise.allSettled([
    createHandover(baseReq, HandoverInitiator.STAFF),
    createHandover({ ...baseReq, body: { amountPaise: 60_000 } }, HandoverInitiator.STAFF),
  ]);
  const fulfilled = outcomes.filter((row) => row.status === "fulfilled");
  const rejected = outcomes.filter((row) => row.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const err = rejected[0].reason;
  assert.ok(err instanceof AppError);
  assert.equal(err.code, "CASH_HANDOVER_AMOUNT_EXCEEDS_BALANCE");
  const balance = await cashBalance({ tenantId: tenant._id, branchId: branch._id, staffId: user._id });
  assert.equal(balance.cashPendingAcceptancePaise, 60_000);
  assert.equal(balance.availableForHandoverPaise, 40_000);
});
