import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  LedgerEntry,
  PostSettlementRefundCase,
  Scheme,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { SchemeStatus, PostSettlementRefundCaseStatus } from "../src/constants/enums.js";
import { recordPostSettlementGatewayRefund } from "../src/lib/post-settlement-gateway-refund.js";
import {
  getPostSettlementRefundCase,
  listPostSettlementRefundCases,
  resolvePostSettlementRefundCase,
} from "../src/services/post-settlement-refund-case.service.js";
import { withTransaction } from "../src/lib/transaction.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedRedeemedScheme(ctx) {
  const schemeId = createId("scheme");
  const paymentId = createId("payment");
  const customerId = createId("customer");
  await Scheme.create({
    _id: schemeId,
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: "EN-PS-1",
    planSnapshot: { name: "Plan" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.REDEEMED,
    startDate: "2025-01-01",
    maturityDate: "2026-01-01",
    settlementCompletedAt: new Date("2026-01-10T10:00:00+05:30"),
    settlementPrincipalPaise: 500_000,
    ledgerNextSequence: 0,
  });
  const payment = {
    _id: paymentId,
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    schemeId,
    customerId,
    amountPaise: 100_000,
    weightMg: 0,
    targetCycle: "2026-01",
  };
  const paymentRefund = {
    _id: createId("paymentRefund"),
    tenantId: ctx.tenant._id,
    paymentId,
    amountPaise: 25_000,
    completedAt: new Date("2026-02-15T12:00:00+05:30"),
  };
  return { schemeId, payment, paymentRefund };
}

test("post-settlement refund creates one pending case and ledger; replay is idempotent", async () => {
  const ctx = await seedTenantUser();
  const { schemeId, payment, paymentRefund } = await seedRedeemedScheme(ctx);
  const args = {
    payment,
    scheme: await Scheme.findById(schemeId),
    paymentRefund,
    refundAmountPaise: 25_000,
    weightDeltaMg: 0,
    providerRefundId: "ref-1",
  };
  await withTransaction(async (session) => {
    args.scheme = await Scheme.findById(schemeId).session(session);
    await recordPostSettlementGatewayRefund({ session, ...args });
  });
  await withTransaction(async (session) => {
    args.scheme = await Scheme.findById(schemeId).session(session);
    await recordPostSettlementGatewayRefund({ session, ...args });
  });
  const cases = await PostSettlementRefundCase.find({ tenantId: ctx.tenant._id }).lean();
  assert.equal(cases.length, 1);
  assert.equal(cases[0].status, PostSettlementRefundCaseStatus.PENDING_RESOLUTION);
  assert.equal(cases[0].refundAmountPaise, 25_000);
  const updated = await Scheme.findById(schemeId).lean();
  assert.equal(updated.postSettlementRefundedPaise, 25_000);
  assert.equal(updated.status, SchemeStatus.REDEEMED);
  const ledger = await LedgerEntry.find({ schemeId }).lean();
  assert.equal(ledger.length, 1);
});

test("authorized admin can resolve case; other tenant cannot read", async () => {
  const ctx = await seedTenantUser();
  const other = await seedTenantUser();
  const { schemeId, payment, paymentRefund } = await seedRedeemedScheme(ctx);
  await withTransaction(async (session) => {
    const scheme = await Scheme.findById(schemeId).session(session);
    await recordPostSettlementGatewayRefund({
      session,
      payment,
      scheme,
      paymentRefund,
      refundAmountPaise: 25_000,
      weightDeltaMg: 0,
      providerRefundId: "ref-2",
    });
  });
  const caseRow = await PostSettlementRefundCase.findOne({ tenantId: ctx.tenant._id }).lean();
  const listReq = {
    auth: { id: ctx.user._id, tenantId: ctx.tenant._id, type: "TENANT_USER" },
    scope: { tenantId: ctx.tenant._id },
    query: {},
  };
  const listed = await listPostSettlementRefundCases(listReq);
  assert.equal(listed.data.length, 1);
  const resolveReq = {
    auth: { id: ctx.user._id, tenantId: ctx.tenant._id, type: "TENANT_USER" },
    scope: { tenantId: ctx.tenant._id },
    params: { caseId: caseRow._id },
    body: { disposition: "WRITE_OFF", reason: "Provider refund after closure" },
  };
  const resolved = await resolvePostSettlementRefundCase(resolveReq);
  assert.equal(resolved.status, PostSettlementRefundCaseStatus.RESOLVED);
  assert.equal(resolved.disposition, "WRITE_OFF");
  await assert.rejects(
    () =>
      getPostSettlementRefundCase({
        auth: { id: other.user._id, tenantId: other.tenant._id, type: "TENANT_USER" },
        scope: { tenantId: other.tenant._id },
        params: { caseId: caseRow._id },
      }),
    (err) => err?.code === "RESOURCE_NOT_FOUND",
  );
});

test("post-settlement refund cases HTTP list and resolve", async () => {
  const ctx = await seedTenantUser();
  const token = bearerFor(ctx.user);
  const { schemeId, payment, paymentRefund } = await seedRedeemedScheme(ctx);
  await withTransaction(async (session) => {
    const scheme = await Scheme.findById(schemeId).session(session);
    await recordPostSettlementGatewayRefund({
      session,
      payment,
      scheme,
      paymentRefund,
      refundAmountPaise: 10_000,
      weightDeltaMg: 0,
      providerRefundId: "ref-http",
    });
  });
  const caseRow = await PostSettlementRefundCase.findOne({ tenantId: ctx.tenant._id }).lean();
  const list = await request(app)
    .get("/api/v1/admin/post-settlement-refund-cases")
    .set("authorization", `Bearer ${token}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.data?.length >= 1);
  const resolve = await request(app)
    .post(`/api/v1/admin/post-settlement-refund-cases/${caseRow._id}/resolve`)
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", createId("idem"))
    .send({ disposition: "RECOVERABLE", reason: "Collect from customer" });
  assert.equal(resolve.status, 200);
  assert.equal(resolve.body.data.disposition, "RECOVERABLE");
});
