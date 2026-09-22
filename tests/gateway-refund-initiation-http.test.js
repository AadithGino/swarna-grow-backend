import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import argon2 from "argon2";
import {
  PlatformRole,
  TenantRole,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { AuditEvent, LedgerEntry, Payment, PaymentRefund, Session, User } from "../src/models/index.js";
import { bearerFor, seedCustomer } from "./helpers/db.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { signAccessToken } from "../src/services/token.service.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRefundInitiationCheckpoint,
  clearRefundInitiationTestHooks,
} from "../src/lib/gateway-refund-initiation-test-hooks.js";
import {
  PaymentMode,
  PaymentStatus,
} from "../src/constants/enums.js";
import {
  refundHeaders,
  seedAdminGatewayContext,
  seedBranchManagerContext,
  seedUserOnTenant,
} from "./helpers/gateway-http-fixture.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearRefundInitiationTestHooks();
});

async function postRefund(token, paymentId, body, idempotencyKey) {
  return request(app)
    .post(`/api/v1/admin/payments/${paymentId}/refunds`)
    .set("authorization", `Bearer ${token}`)
    .set(refundHeaders(idempotencyKey))
    .send(body);
}

test("tenant admin initiates refund and persists reservation without ledger reversal", async () => {
  const ctx = await seedAdminGatewayContext({ role: TenantRole.TENANT_ADMIN });
  const res = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 25_000, reason: "Customer request" }, "idem-refund-001");
  assert.equal(res.status, 202);
  assert.equal(res.body.data.refundId?.startsWith("pref_"), true);
  assert.equal(await PaymentRefund.countDocuments({ paymentId: ctx.paymentId }), 1);
  assert.equal(await LedgerEntry.countDocuments({ paymentId: ctx.paymentId, type: "REVERSAL" }), 0);
  const audit = await AuditEvent.findOne({ action: "GATEWAY_REFUND_INITIATED", entityId: ctx.paymentId }).lean();
  assert.ok(audit);
  assert.equal(audit.metadata?.idempotencyKey, "idem-refund-001");
  assert.equal(JSON.stringify(audit).includes("mock-secret"), false);
});

test("branch manager may refund within branch; not another branch", async () => {
  const { ownerCtx, otherPayment, manager } = await seedBranchManagerContext();
  const ok = await postRefund(
    manager.token,
    ownerCtx.paymentId,
    { amountPaise: 10_000, reason: "Branch approved" },
    "idem-bm-ok",
  );
  assert.equal(ok.status, 202);
  const denied = await postRefund(
    manager.token,
    otherPayment.paymentId,
    { amountPaise: 10_000, reason: "Cross branch" },
    "idem-bm-deny",
  );
  assert.equal(denied.status, 404);
});

test("staff role without PAYMENT_REVERSE is rejected", async () => {
  const ctx = await seedAdminGatewayContext();
  const staff = await seedUserOnTenant({
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    role: TenantRole.BRANCH_STAFF,
  });
  const res = await postRefund(staff.token, ctx.paymentId, { amountPaise: 1000, reason: "Nope" }, "idem-staff");
  assert.equal(res.status, 403);
});

async function seedPlatformBearer() {
  const user = await User.create({
    _id: createId("user"),
    type: UserType.PLATFORM_USER,
    role: PlatformRole.SUPER_ADMIN,
    name: "Platform",
    passwordHash: await argon2.hash("9876", { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
    status: UserStatus.ACTIVE,
    permissions: ["*"],
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    deviceId: "platform",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals = { testSessionId: session._id };
  return bearerFor(user);
}

async function seedCustomerBearer(tenantId, branchId, customerId) {
  const session = await Session.create({
    _id: createId("session"),
    customerId,
    tenantId,
    deviceId: "customer-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return signAccessToken({
    id: customerId,
    type: "CUSTOMER",
    tenantId,
    branchId,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "customer-device",
    securityVersion: 0,
    sessionId: session._id,
  });
}

test("customer bearer is denied on admin refund initiation", async () => {
  const ctx = await seedAdminGatewayContext();
  const customer = await seedCustomer({
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    mobile: `+91988${String(Date.now()).slice(-8)}`,
  });
  const customerToken = await seedCustomerBearer(ctx.tenant._id, ctx.branch._id, customer._id);
  const beforeAudit = await AuditEvent.countDocuments({});
  const beforeRefunds = await PaymentRefund.countDocuments({});
  const beforeLedger = await LedgerEntry.countDocuments({});
  let providerCalled = false;
  const original = phonePeProvider.initiateRefund.bind(phonePeProvider);
  phonePeProvider.initiateRefund = async () => {
    providerCalled = true;
    return {};
  };
  try {
    const res = await postRefund(customerToken, ctx.paymentId, { amountPaise: 1000, reason: "Customer try" }, "idem-customer");
    assert.ok([401, 403].includes(res.status));
    assert.equal(await PaymentRefund.countDocuments({}), beforeRefunds);
    assert.equal(await AuditEvent.countDocuments({}), beforeAudit);
    assert.equal(await LedgerEntry.countDocuments({}), beforeLedger);
    assert.equal(providerCalled, false);
  } finally {
    phonePeProvider.initiateRefund = original;
  }
});

test("customer app routes do not expose admin refund initiation", () => {
  const appRoutes = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/routes/app.routes.js"),
    "utf8",
  );
  assert.equal(appRoutes.includes("initiateAdminPaymentRefund"), false);
  assert.equal(appRoutes.includes("/payments/:paymentId/refunds"), false);
});

test("platform and staff roles cannot initiate gateway refunds", async () => {
  const ctx = await seedAdminGatewayContext();
  const platformToken = await seedPlatformBearer();
  assert.equal(
    (await postRefund(platformToken, ctx.paymentId, { amountPaise: 1000, reason: "Platform try" }, "idem-platform")).status,
    403,
  );
  const staff = await seedUserOnTenant({
    tenantId: ctx.tenant._id,
    branchId: ctx.branch._id,
    role: TenantRole.BRANCH_STAFF,
  });
  assert.equal(
    (await postRefund(staff.token, ctx.paymentId, { amountPaise: 1000, reason: "Staff try" }, "idem-staff-2")).status,
    403,
  );
});

test("non-gateway manual modes and fully reversed payments rejected", async () => {
  const ctx = await seedAdminGatewayContext();
  for (const mode of [PaymentMode.CASH, PaymentMode.UPI, PaymentMode.CARD, PaymentMode.BANK_TRANSFER]) {
    await Payment.updateOne({ _id: ctx.paymentId }, { $set: { mode, status: PaymentStatus.SUCCESS } });
    assert.equal(
      (await postRefund(ctx.token, ctx.paymentId, { amountPaise: 1000, reason: `${mode} try` }, `idem-${mode}`)).status,
      422,
    );
  }
  await Payment.updateOne(
    { _id: ctx.paymentId },
    {
      $set: {
        mode: PaymentMode.ONLINE_GATEWAY,
        status: PaymentStatus.REVERSED,
        refundedAmountPaise: 100_000,
      },
    },
  );
  assert.equal(
    (await postRefund(ctx.token, ctx.paymentId, { amountPaise: 1000, reason: "Already reversed" }, "idem-reversed")).status,
    422,
  );
});

test("non-gateway and failed payments rejected", async () => {
  const ctx = await seedAdminGatewayContext();
  await Payment.updateOne({ _id: ctx.paymentId }, { $set: { mode: PaymentMode.CASH } });
  assert.equal((await postRefund(ctx.token, ctx.paymentId, { amountPaise: 1000, reason: "Cash try" }, "idem-cash")).status, 422);
  await Payment.updateOne({ _id: ctx.paymentId }, { $set: { mode: PaymentMode.ONLINE_GATEWAY, status: PaymentStatus.FAILED } });
  assert.equal((await postRefund(ctx.token, ctx.paymentId, { amountPaise: 1000, reason: "Failed try" }, "idem-fail")).status, 422);
});

test("amount and reason validation", async () => {
  const ctx = await seedAdminGatewayContext();
  assert.equal((await postRefund(ctx.token, ctx.paymentId, { amountPaise: 0, reason: "Bad" }, "idem-zero")).status, 400);
  assert.equal((await postRefund(ctx.token, ctx.paymentId, { amountPaise: 200_000, reason: "Too much" }, "idem-high")).status, 422);
  assert.equal((await postRefund(ctx.token, ctx.paymentId, { amountPaise: 1000, reason: "ab" }, "idem-short-reason")).status, 400);
  assert.equal((await postRefund(ctx.token, ctx.paymentId, { amountPaise: 1000, reason: "Valid reason" }, "")).status, 400);
});

test("idempotency same key returns same refund; different body conflicts", async () => {
  const ctx = await seedAdminGatewayContext();
  const first = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 15_000, reason: "Same" }, "idem-same");
  const second = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 15_000, reason: "Same" }, "idem-same");
  assert.equal(first.body.data.refundId, second.body.data.refundId);
  assert.equal(await PaymentRefund.countDocuments({ paymentId: ctx.paymentId }), 1);
  const conflict = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 16_000, reason: "Same" }, "idem-same");
  assert.equal(conflict.status, 409);
});

test("concurrent same-key creates one refund", async () => {
  const ctx = await seedAdminGatewayContext();
  const body = { amountPaise: 12_000, reason: "Concurrent same key" };
  const [a, b] = await Promise.all([
    postRefund(ctx.token, ctx.paymentId, body, "idem-concurrent-same"),
    postRefund(ctx.token, ctx.paymentId, body, "idem-concurrent-same"),
  ]);
  assert.ok([202, 409].includes(a.status));
  assert.ok([202, 409].includes(b.status));
  assert.equal(await PaymentRefund.countDocuments({ paymentId: ctx.paymentId, idempotencyKey: "idem-concurrent-same" }), 1);
});

test("concurrent different keys cannot reserve beyond remaining", async () => {
  const ctx = await seedAdminGatewayContext({ role: TenantRole.TENANT_OWNER });
  await Payment.updateOne({ _id: ctx.paymentId }, { $set: { amountPaise: 50_000 } });
  const body = { amountPaise: 30_000, reason: "Partial reservation" };
  await Promise.allSettled([
    postRefund(ctx.token, ctx.paymentId, body, "idem-res-a"),
    postRefund(ctx.token, ctx.paymentId, body, "idem-res-b"),
  ]);
  const reserved = await PaymentRefund.aggregate([
    { $match: { paymentId: ctx.paymentId } },
    { $group: { _id: null, total: { $sum: "$amountPaise" } } },
  ]);
  assert.ok((reserved[0]?.total ?? 0) <= 50_000);
});

test("PhonePe initiation runs after Mongo commit", async () => {
  const ctx = await seedAdminGatewayContext();
  await postRefund(ctx.token, ctx.paymentId, { amountPaise: 5000, reason: "Order check" }, "idem-post-commit");
  assert.ok(assertRefundInitiationCheckpoint("post-commit"));
});

test("provider failure keeps one retryable reservation", async () => {
  const ctx = await seedAdminGatewayContext();
  const original = phonePeProvider.initiateRefund.bind(phonePeProvider);
  phonePeProvider.initiateRefund = async () => {
    throw new Error("transient provider");
  };
  try {
    const fail = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 8000, reason: "Retry me" }, "idem-provider-fail");
    assert.equal(fail.status, 503);
    assert.equal(await PaymentRefund.countDocuments({ paymentId: ctx.paymentId }), 1);
    assert.equal(await LedgerEntry.countDocuments({ paymentId: ctx.paymentId, type: "REVERSAL" }), 0);
    phonePeProvider.initiateRefund = original;
    const retry = await postRefund(ctx.token, ctx.paymentId, { amountPaise: 8000, reason: "Retry me" }, "idem-provider-fail");
    assert.equal(retry.status, 202);
    const row = await PaymentRefund.findOne({ paymentId: ctx.paymentId }).lean();
    assert.equal(row.providerRefundId, row._id);
  } finally {
    phonePeProvider.initiateRefund = original;
  }
});
