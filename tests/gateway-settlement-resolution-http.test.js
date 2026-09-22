import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AlertType, PaymentMode, PaymentStatus, TenantRole } from "../src/constants/enums.js";
import { Alert, LedgerEntry, Payment, SettlementMismatch } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  runDailyGatewaySettlementForTenant,
  uploadGatewaySettlementStatement,
} from "../src/services/gateway-settlement.service.js";
import { SettlementMismatchStatus, SettlementResolutionCategory } from "../src/models/gateway-settlement.models.js";
import { seedAdminGatewayContext, seedUserOnTenant } from "./helpers/gateway-http-fixture.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedMismatch() {
  const ctx = await seedAdminGatewayContext();
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    schemeId: createId("scheme"),
    customerId: createId("customer"),
    receiptNumber: "RCP-SET",
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.SUCCESS,
    paidAt: new Date("2026-09-22T10:00:00+05:30"),
    providerTransactionId: "txn_real",
    source: "CUSTOMER_APP",
  });
  await uploadGatewaySettlementStatement({
    auth: { tenantId: ctx.tenant._id, id: ctx.user._id },
    body: {
      businessDate: "2026-09-22",
      items: [{ providerTransactionId: "txn_wrong", settledAmountPaise: 50_000 }],
    },
  });
  await runDailyGatewaySettlementForTenant({
    tenantId: ctx.tenant._id,
    businessDate: "2026-09-22",
  });
  const mismatch = await SettlementMismatch.findOne({ tenantId: ctx.tenant._id }).lean();
  assert.ok(mismatch);
  return { ctx, mismatch };
}

test("list and resolve mismatch with immutable history; ledger unchanged", async () => {
  const { ctx, mismatch } = await seedMismatch();
  const beforeLedger = await LedgerEntry.countDocuments({});
  const list = await request(app)
    .get("/api/v1/admin/gateway/settlement-mismatches?status=OPEN")
    .set("authorization", `Bearer ${ctx.token}`)
    .expect(200);
  assert.ok(list.body.data.length >= 1);
  const resolve = await request(app)
    .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
    .set("authorization", `Bearer ${ctx.token}`)
    .set("x-idempotency-key", "resolve-mismatch-1")
    .send({
      category: SettlementResolutionCategory.PROVIDER_CONFIRMED,
      reason: "Verified with PhonePe portal",
    })
    .expect(200);
  assert.equal(resolve.body.data.status, SettlementMismatchStatus.RESOLVED);
  const updated = await SettlementMismatch.findById(mismatch._id).lean();
  assert.equal(updated.resolutionHistory.length, 1);
  assert.equal(await LedgerEntry.countDocuments({}), beforeLedger);
  const alert = await Alert.findOne({
    tenantId: ctx.tenant._id,
    type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
  }).lean();
  assert.equal(alert.status, "RESOLVED");
});

test("resolve requires reason and rejects cross-tenant access", async () => {
  const { ctx, mismatch } = await seedMismatch();
  const other = await seedAdminGatewayContext();
  await request(app)
    .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
    .set("authorization", `Bearer ${other.token}`)
    .set("x-idempotency-key", "resolve-cross-tenant")
    .send({
      category: SettlementResolutionCategory.BANK_CONFIRMED,
      reason: "Should fail",
    })
    .expect(404);
  await request(app)
    .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
    .set("authorization", `Bearer ${ctx.token}`)
    .set("x-idempotency-key", "resolve-no-reason")
    .send({ category: SettlementResolutionCategory.BANK_CONFIRMED, reason: "ab" })
    .expect(400);
});

test("reopen resolved mismatch reopens alert", async () => {
  const { ctx, mismatch } = await seedMismatch();
  await request(app)
    .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
    .set("authorization", `Bearer ${ctx.token}`)
    .set("x-idempotency-key", "resolve-before-reopen")
    .send({
      category: SettlementResolutionCategory.TIMING_DIFFERENCE,
      reason: "Timing verified later",
    })
    .expect(200);
  await request(app)
    .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/reopen`)
    .set("authorization", `Bearer ${ctx.token}`)
    .set("x-idempotency-key", "reopen-mismatch-1")
    .send({ reason: "New bank statement contradicts resolution" })
    .expect(200);
  const row = await SettlementMismatch.findById(mismatch._id).lean();
  assert.equal(row.status, SettlementMismatchStatus.OPEN);
  assert.equal(row.resolutionHistory.filter((h) => h.action === "REOPEN").length, 1);
  const alert = await Alert.findOne({
    tenantId: ctx.tenant._id,
    type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
  }).lean();
  assert.equal(alert.status, "OPEN");
});

test("staff cannot resolve mismatches", async () => {
  const { ctx, mismatch } = await seedMismatch();
  const staff = await seedUserOnTenant({
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    role: TenantRole.BRANCH_STAFF,
  });
  await request(app)
    .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
    .set("authorization", `Bearer ${staff.token}`)
    .set("x-idempotency-key", "resolve-staff-deny")
    .send({
      category: SettlementResolutionCategory.INTERNAL_REFERENCE_CORRECTED,
      reason: "Staff should not resolve",
    })
    .expect(403);
});
