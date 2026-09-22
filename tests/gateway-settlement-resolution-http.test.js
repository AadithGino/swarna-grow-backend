import { describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AlertType, PaymentMode, PaymentStatus, TenantRole } from "../src/constants/enums.js";
import { Alert, LedgerEntry, Payment, SettlementItem, SettlementMismatch, SettlementRun } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  runDailyGatewaySettlementForTenant,
  uploadGatewaySettlementStatement,
} from "../src/services/gateway-settlement.service.js";
import { SettlementMismatchStatus, SettlementResolutionCategory, SettlementRunStatus } from "../src/models/gateway-settlement.models.js";
import { configureTenantPhonePe, seedAdminGatewayContext, seedUserOnTenant } from "./helpers/gateway-http-fixture.js";
import { bearerFor, resetTestDb, seedBranch, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });

function uniqueBusinessDate() {
  const token = createId("bd").slice(-6);
  const day = 1 + (parseInt(token, 36) % 27);
  return `2026-10-${String(day).padStart(2, "0")}`;
}

function paidAtOnDate(businessDate) {
  return new Date(`${businessDate}T10:00:00+05:30`);
}

describe("gateway settlement resolution HTTP", { concurrency: false }, () => {
  test.beforeEach(async () => { await resetTestDb(); });

  async function seedTenantAdminContext() {
    const seeded = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
    await configureTenantPhonePe(seeded.tenant._id);
    return { ...seeded, token: bearerFor(seeded.user) };
  }

  async function seedMismatch() {
    const businessDate = uniqueBusinessDate();
    const suffix = createId("m").slice(-10);
    const ctx = await seedTenantAdminContext();
    const paymentId = createId("payment");
    const txnReal = `txn_real_${suffix}`;
    const txnWrong = `txn_wrong_${suffix}`;
    await Payment.create({
      _id: paymentId,
      tenantId: ctx.tenant._id,
      branchId: ctx.branch._id,
      schemeId: createId("scheme"),
      customerId: createId("customer"),
      receiptNumber: `RCP-SET-${suffix}`,
      amountPaise: 50_000,
      mode: PaymentMode.ONLINE_GATEWAY,
      status: PaymentStatus.SUCCESS,
      paidAt: paidAtOnDate(businessDate),
      providerTransactionId: txnReal,
      source: "CUSTOMER_APP",
    });
    const upload = await uploadGatewaySettlementStatement({
      auth: { tenantId: ctx.tenant._id, id: ctx.user._id },
      body: {
        businessDate,
        items: [{ providerTransactionId: txnWrong, settledAmountPaise: 50_000 }],
      },
    });
    assert.equal(upload.duplicate, false, "upload must persist statement rows");
    assert.ok(upload.runId);
    const runReady = await SettlementRun.findById(upload.runId).lean();
    assert.ok(runReady, `uploaded run must be readable runId=${upload.runId}`);
    assert.equal(runReady.tenantId, ctx.tenant._id);
    assert.equal(runReady.provider, "PHONEPE");
    const itemCount = await SettlementItem.countDocuments({
      tenantId: ctx.tenant._id,
      runId: upload.runId,
    });
    assert.equal(itemCount, 1, "expected one settlement item on run");
    await SettlementRun.updateOne(
      { _id: upload.runId },
      { $unset: { leaseExpiresAt: "", leaseOwner: "", startedAt: "" } },
    );

    let batch;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      batch = await runDailyGatewaySettlementForTenant({
        tenantId: ctx.tenant._id,
        businessDate,
        leaseOwner: `test-${suffix}`,
        runId: upload.runId,
      });
      if (batch.outcome !== "RUN_NOT_FOUND") break;
    }
    assert.notEqual(batch.outcome, "LEASE_BUSY", JSON.stringify(batch));
    assert.notEqual(batch.outcome, "RUN_NOT_FOUND", JSON.stringify(batch));
    assert.equal(batch.outcome, SettlementRunStatus.MISMATCH, JSON.stringify(batch));

    const mismatch = await SettlementMismatch.findOne({
      tenantId: ctx.tenant._id,
      runId: batch.runId,
    }).lean();
    assert.ok(mismatch, `mismatch missing runId=${batch.runId}`);
    return { ctx, mismatch, runId: batch.runId, suffix };
  }

  test("list and resolve mismatch with immutable history; ledger unchanged", async () => {
    const { ctx, mismatch, runId, suffix } = await seedMismatch();
    const beforeLedger = await LedgerEntry.countDocuments({});
    const list = await request(app)
      .get("/api/v1/admin/gateway/settlement-mismatches?status=OPEN")
      .set("authorization", `Bearer ${ctx.token}`)
      .expect(200);
    assert.ok(
      list.body.data.some((row) => row.id === mismatch._id || row._id === mismatch._id),
      "list must include seeded mismatch",
    );
    const resolve = await request(app)
      .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
      .set("authorization", `Bearer ${ctx.token}`)
      .set("x-idempotency-key", `resolve-mismatch-${suffix}`)
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
      entityId: runId,
    }).lean();
    assert.equal(alert.status, "RESOLVED");
  });

  test("resolve requires reason and rejects cross-tenant access", async () => {
    const { ctx, mismatch, suffix } = await seedMismatch();
    const other = await seedAdminGatewayContext();
    await request(app)
      .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
      .set("authorization", `Bearer ${other.token}`)
      .set("x-idempotency-key", `resolve-cross-${suffix}`)
      .send({
        category: SettlementResolutionCategory.BANK_CONFIRMED,
        reason: "Should fail",
      })
      .expect(404);
    await request(app)
      .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
      .set("authorization", `Bearer ${ctx.token}`)
      .set("x-idempotency-key", `resolve-no-reason-${suffix}`)
      .send({ category: SettlementResolutionCategory.BANK_CONFIRMED, reason: "ab" })
      .expect(400);
  });

  test("reopen resolved mismatch reopens alert", async () => {
    const { ctx, mismatch, runId, suffix } = await seedMismatch();
    await request(app)
      .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
      .set("authorization", `Bearer ${ctx.token}`)
      .set("x-idempotency-key", `resolve-before-reopen-${suffix}`)
      .send({
        category: SettlementResolutionCategory.TIMING_DIFFERENCE,
        reason: "Timing verified later",
      })
      .expect(200);
    await request(app)
      .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/reopen`)
      .set("authorization", `Bearer ${ctx.token}`)
      .set("x-idempotency-key", `reopen-mismatch-${suffix}`)
      .send({ reason: "New bank statement contradicts resolution" })
      .expect(200);
    const row = await SettlementMismatch.findById(mismatch._id).lean();
    assert.equal(row.status, SettlementMismatchStatus.OPEN);
    assert.equal(row.resolutionHistory.filter((h) => h.action === "REOPEN").length, 1);
    const alert = await Alert.findOne({
      tenantId: ctx.tenant._id,
      type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
      entityId: runId,
    }).lean();
    assert.equal(alert.status, "OPEN");
  });

  async function seedTwoMismatchesSameRun() {
    const businessDate = uniqueBusinessDate();
    const suffix = createId("m2").slice(-10);
    const ctx = await seedTenantAdminContext();
    const paymentA = createId("payment");
    const paymentB = createId("payment");
    const schemeId = createId("scheme");
    const customerId = createId("customer");
    for (const [paymentId, txnId] of [[paymentA, `txn_real_a_${suffix}`], [paymentB, `txn_real_b_${suffix}`]]) {
      await Payment.create({
        _id: paymentId,
        tenantId: ctx.tenant._id,
        branchId: ctx.branch._id,
        schemeId,
        customerId,
        receiptNumber: `RCP-${paymentId}`,
        amountPaise: 50_000,
        mode: PaymentMode.ONLINE_GATEWAY,
        status: PaymentStatus.SUCCESS,
        paidAt: paidAtOnDate(businessDate),
        providerTransactionId: txnId,
        source: "CUSTOMER_APP",
      });
    }
    const upload = await uploadGatewaySettlementStatement({
      auth: { tenantId: ctx.tenant._id, id: ctx.user._id },
      body: {
        businessDate,
        items: [
          { providerTransactionId: `txn_wrong_a_${suffix}`, settledAmountPaise: 50_000 },
          { providerTransactionId: `txn_wrong_b_${suffix}`, settledAmountPaise: 50_000 },
        ],
      },
    });
    assert.equal(upload.duplicate, false);
    await SettlementRun.updateOne(
      { _id: upload.runId },
      { $unset: { leaseExpiresAt: "", leaseOwner: "", startedAt: "" } },
    );
    let batch;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      batch = await runDailyGatewaySettlementForTenant({
        tenantId: ctx.tenant._id,
        businessDate,
        leaseOwner: `test-multi-${suffix}`,
        runId: upload.runId,
      });
      if (batch.outcome !== "RUN_NOT_FOUND") break;
    }
    assert.notEqual(batch.outcome, "RUN_NOT_FOUND", JSON.stringify(batch));
    assert.equal(batch.outcome, SettlementRunStatus.MISMATCH);
    const mismatches = await SettlementMismatch.find({ tenantId: ctx.tenant._id, runId: batch.runId })
      .sort({ createdAt: 1 })
      .lean();
    assert.equal(mismatches.length, 2);
    return { ctx, mismatches, runId: batch.runId, suffix };
  }

  test("resolving one of two mismatches keeps run alert open until all are resolved", async () => {
    const { ctx, mismatches, runId, suffix } = await seedTwoMismatchesSameRun();
    const beforeLedger = await LedgerEntry.countDocuments({});
    await request(app)
      .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatches[0]._id}/resolve`)
      .set("authorization", `Bearer ${ctx.token}`)
      .set("x-idempotency-key", `resolve-multi-1-${suffix}`)
      .send({
        category: SettlementResolutionCategory.PROVIDER_CONFIRMED,
        reason: "First mismatch verified",
      })
      .expect(200);
    const alert = await Alert.findOne({
      tenantId: ctx.tenant._id,
      type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
      entityId: runId,
    }).lean();
    assert.equal(alert.status, "OPEN");
    await request(app)
      .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatches[1]._id}/resolve`)
      .set("authorization", `Bearer ${ctx.token}`)
      .set("x-idempotency-key", `resolve-multi-2-${suffix}`)
      .send({
        category: SettlementResolutionCategory.BANK_CONFIRMED,
        reason: "Second mismatch verified",
      })
      .expect(200);
    const alertDone = await Alert.findOne({
      tenantId: ctx.tenant._id,
      type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
      entityId: runId,
    }).lean();
    assert.equal(alertDone.status, "RESOLVED");
    assert.equal(await LedgerEntry.countDocuments({}), beforeLedger);
  });

  test("concurrent resolve with same idempotency key is idempotent", async () => {
    const { ctx, mismatch, suffix } = await seedMismatch();
    const body = {
      category: SettlementResolutionCategory.INTERNAL_REFERENCE_CORRECTED,
      reason: "Concurrent resolve idempotent",
    };
    const idem = `resolve-concurrent-${suffix}`;
    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
        .set("authorization", `Bearer ${ctx.token}`)
        .set("x-idempotency-key", idem)
        .send(body),
      request(app)
        .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
        .set("authorization", `Bearer ${ctx.token}`)
        .set("x-idempotency-key", idem)
        .send(body),
    ]);
    assert.ok([200, 409].includes(a.status), JSON.stringify(a.body));
    assert.ok([200, 409].includes(b.status), JSON.stringify(b.body));
    assert.ok(a.status === 200 || b.status === 200, "at least one resolve succeeds");
    const row = await SettlementMismatch.findById(mismatch._id).lean();
    const resolves = row.resolutionHistory.filter((h) => h.action === "RESOLVE");
    assert.equal(resolves.length, 1);
  });

  test("branch manager cannot resolve mismatch outside branch scope", async () => {
    const { ctx, mismatches, suffix } = await seedTwoMismatchesSameRun();
    const branchB = await seedBranch({ tenantId: ctx.tenant._id, code: "BR2", name: "Branch Two" });
    const otherBranch = await seedUserOnTenant({
      tenantId: ctx.tenant._id,
      branchId: branchB._id,
      role: TenantRole.BRANCH_MANAGER,
      mobile: `+9196${suffix.slice(-8)}`,
    });
    await request(app)
      .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatches[0]._id}/resolve`)
      .set("authorization", `Bearer ${otherBranch.token}`)
      .set("x-idempotency-key", `resolve-wrong-branch-${suffix}`)
      .send({
        category: SettlementResolutionCategory.PROVIDER_CONFIRMED,
        reason: "Should not resolve",
      })
      .expect(404);
  });

  test("regression: mismatch seed and resolve succeeds 50 times in one session", async () => {
    for (let i = 0; i < 50; i += 1) {
      await resetTestDb();
      const { ctx, mismatch, runId, suffix } = await seedMismatch();
      await request(app)
        .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
        .set("authorization", `Bearer ${ctx.token}`)
        .set("x-idempotency-key", `regression-${suffix}-${i}`)
        .send({
          category: SettlementResolutionCategory.PROVIDER_CONFIRMED,
          reason: `Regression resolve ${i}`,
        })
        .expect(200);
      const alert = await Alert.findOne({
        tenantId: ctx.tenant._id,
        type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
        entityId: runId,
      }).lean();
      assert.equal(alert.status, "RESOLVED");
    }
  });

  test("staff cannot resolve mismatches", async () => {
    const { ctx, mismatch, suffix } = await seedMismatch();
    const staff = await seedUserOnTenant({
      tenantId: ctx.tenant._id,
      branchId: ctx.branch._id,
      role: TenantRole.BRANCH_STAFF,
      mobile: `+9195${suffix.slice(-8)}`,
    });
    await request(app)
      .post(`/api/v1/admin/gateway/settlement-mismatches/${mismatch._id}/resolve`)
      .set("authorization", `Bearer ${staff.token}`)
      .set("x-idempotency-key", `resolve-staff-deny-${suffix}`)
      .send({
        category: SettlementResolutionCategory.INTERNAL_REFERENCE_CORRECTED,
        reason: "Staff should not resolve",
      })
      .expect(403);
  });
});
