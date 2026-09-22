import test from "node:test";
import assert from "node:assert/strict";
import { PaymentMode, PaymentStatus } from "../src/constants/enums.js";
import { Alert, Payment, SettlementItem, SettlementRun } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  runDailyGatewaySettlementForTenant,
  uploadGatewaySettlementStatement,
} from "../src/services/gateway-settlement.service.js";
import { SettlementRunStatus } from "../src/models/gateway-settlement.models.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function mockReq(tenantId, body = {}) {
  return {
    auth: { tenantId, id: "usr_test" },
    body,
  };
}

test("duplicate settlement upload with same checksum is idempotent", async () => {
  const { tenant } = await seedTenantUser();
  const body = {
    businessDate: "2026-09-22",
    items: [{ providerTransactionId: "tx1", settledAmountPaise: 50_000 }],
  };
  const first = await uploadGatewaySettlementStatement(mockReq(tenant._id, body));
  const second = await uploadGatewaySettlementStatement(mockReq(tenant._id, body));
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(await SettlementItem.countDocuments({ tenantId: tenant._id }), 1);
});

test("missing upload creates MISSING_STATEMENT alert without touching payments", async () => {
  const { tenant } = await seedTenantUser();
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: createId("branch"),
    schemeId: createId("scheme"),
    customerId: createId("customer"),
    receiptNumber: "RCP-1",
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.SUCCESS,
    source: "CUSTOMER_APP",
    paidAt: new Date("2026-09-22T10:00:00+05:30"),
  });
  const result = await runDailyGatewaySettlementForTenant({
    tenantId: tenant._id,
    businessDate: "2026-09-22",
  });
  assert.equal(result.outcome, SettlementRunStatus.MISSING_STATEMENT);
  const alert = await Alert.findOne({ tenantId: tenant._id, type: "GATEWAY_SETTLEMENT_MISSING" }).lean();
  assert.ok(alert);
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
});

test("scheduler replay for same tenant/date is idempotent on lease", async () => {
  const { tenant } = await seedTenantUser();
  const first = await runDailyGatewaySettlementForTenant({
    tenantId: tenant._id,
    businessDate: "2026-09-21",
    leaseOwner: "a",
  });
  const second = await runDailyGatewaySettlementForTenant({
    tenantId: tenant._id,
    businessDate: "2026-09-21",
    leaseOwner: "b",
  });
  assert.ok(first.runId);
  assert.equal(second.outcome, "LEASE_BUSY");
  assert.equal(await SettlementRun.countDocuments({ tenantId: tenant._id, businessDate: "2026-09-21" }), 1);
});
