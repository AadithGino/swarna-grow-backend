import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier, TenantRole, UserStatus, UserType } from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import {
  clearDigitalMetalSellFinalizeTestHooksForTests,
  armPauseAfterDigitalMetalSellDebitForTests,
} from "../src/lib/digital-metals-sell-finalize-test-hooks.js";
import {
  DigitalMetalBankDestination,
  DigitalMetalCustomerRiskHold,
  DigitalMetalPaymentExceptionRefund,
  DigitalMetalPayable,
  Session,
  Tenant,
  User,
} from "../src/models/index.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { makeTenantQuoteReady } from "./helpers/digital-metals-live-ready.js";
import { createId } from "../src/lib/ids.js";
import { signAccessToken } from "../src/services/token.service.js";
import { withTransaction } from "../src/lib/transaction.js";
import { creditWalletForTest } from "../src/services/digital-metals-ledger.service.js";
import { seal } from "../src/lib/crypto.js";
import { ensureDigitalMetalPaymentExceptionRefundCase } from "../src/services/digital-metals-payment-exception.service.js";
import { DigitalMetalBuyOrder } from "../src/models/index.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  clearDigitalMetalSellFinalizeTestHooksForTests();
  await resetTestDb();
});

async function enablePlan(tenantId) {
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "subscription.planFeaturesSnapshot.digitalMetals": true,
        "subscription.tier": PlanTier.GROWTH,
        "operations.digitalMetalsEnabled": true,
      },
    },
  );
}

async function customerToken({ tenant, branch, customer }) {
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "cust",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "cust",
    securityVersion: 0,
    sessionId: session._id,
  });
}

async function seedWalletGold({ tenant, customer, quantityUg = UG_PER_G }) {
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg,
      idempotencyKey: `seed-${randomUUID()}`,
    }),
  );
}

async function approverTokenFor({ tenant, branch, mobile = "+918811122233" }) {
  const user = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.TENANT_ADMIN,
    name: "Approver",
    mobile,
    passwordHash: await argon2.hash("1234", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_ADMIN] ?? [],
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    tenantId: tenant._id,
    deviceId: "approver",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals.testSessionId = session._id;
  return bearerFor(user);
}

async function activeBankDestination({ tenant, customer }) {
  return DigitalMetalBankDestination.create({
    _id: createId("dmbd"),
    tenantId: tenant._id,
    customerId: customer._id,
    accountHolderName: "Test User",
    accountNumberSealed: seal("123456789012"),
    accountLast4: "9012",
    ifsc: "HDFC0001234",
    status: "ACTIVE",
    verifiedAt: new Date(),
  });
}

async function sellThroughConfirm({ tenant, user, customer, token, quantityUg = UG_PER_G }) {
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedWalletGold({ tenant, customer, quantityUg });
  const quote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/sell")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ metal: "GOLD", finenessPpm: 999000, quantityUg });
  assert.equal(quote.status, 201);
  const order = await request(app)
    .post("/api/v1/app/digital-metals/sell-orders")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(order.status, 201);
  const dest = await activeBankDestination({ tenant, customer });
  const confirmKey = randomUUID();
  const confirm = await request(app)
    .post(`/api/v1/app/digital-metals/sell-orders/${order.body.data.id}/confirm`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", confirmKey)
    .send({ bankDestinationId: dest._id });
  assert.equal(confirm.status, 200);
  return { order: order.body.data, dest, adminToken: bearerFor(user), confirmKey };
}

test("duplicate sell confirm is idempotent for pending approval", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, dest, confirmKey } = await sellThroughConfirm({ tenant, user, customer, token });
  const again = await request(app)
    .post(`/api/v1/app/digital-metals/sell-orders/${order.id}/confirm`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", confirmKey)
    .send({ bankDestinationId: dest._id });
  assert.equal(again.status, 200);
  assert.equal(again.headers["x-idempotent-replay"], "true");
  const dupState = await request(app)
    .post(`/api/v1/app/digital-metals/sell-orders/${order.id}/confirm`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ bankDestinationId: dest._id });
  assert.equal(dupState.status, 200);
  assert.equal(dupState.body.data.status, "PENDING_APPROVAL");
});

test("concurrent duplicate sell approval: one execution", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, token });
  const run = () =>
    request(app)
      .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({});
  const [a, b] = await Promise.all([run(), run()]);
  const ok = [a.status, b.status].filter((s) => s === 200).length;
  assert.ok(ok >= 1);
  const payables = await DigitalMetalPayable.find({ sellOrderId: order.id }).lean();
  assert.equal(payables.length, 1);
});

test("rollback after metal debit then retry creates single payable", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, token });
  armPauseAfterDigitalMetalSellDebitForTests();
  const fail = await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  assert.equal(fail.status, 500);
  clearDigitalMetalSellFinalizeTestHooksForTests();
  const retry = await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  assert.equal(retry.status, 200);
  assert.equal((await DigitalMetalPayable.countDocuments({ sellOrderId: order.id })), 1);
});

test("risk hold between confirm and execution blocks approval", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, token });
  await DigitalMetalCustomerRiskHold.create({
    _id: createId("dmrh"),
    tenantId: tenant._id,
    customerId: customer._id,
    status: "ACTIVE",
    reasonCode: "REFUND_EXPOSURE",
    exposurePaise: 10_000,
  });
  const approve = await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  assert.equal(approve.status, 409);
  assert.equal(approve.body.error?.code, "DIGITAL_METALS_RISK_HOLD");
});

test("payment exception refund case auto-creates durable risk hold", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const order = await DigitalMetalBuyOrder.create({
    _id: createId("dmbo"),
    tenantId: tenant._id,
    customerId: customer._id,
    branchId: branch._id,
    quoteId: createId("dmq"),
    status: "REFUND_REVIEW",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: UG_PER_G,
    totalPayablePaise: 50_000,
    quoteExpiresAt: new Date(Date.now() + 86_400_000),
    paymentAcceptanceExpiresAt: new Date(Date.now() - 60_000),
    termsVersion: "v1",
    termsContentHash: "hash",
    termsAcceptedAt: new Date(),
    idempotencyKey: randomUUID(),
  });
  await withTransaction((session) =>
    ensureDigitalMetalPaymentExceptionRefundCase(session, {
      tenantId: tenant._id,
      order,
      paymentAttemptId: createId("dmpay"),
      merchantOrderId: "m1",
      amountPaise: 50_000,
      exceptionType: "LATE_SUCCESS",
    }),
  );
  const hold = await DigitalMetalCustomerRiskHold.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    status: "ACTIVE",
  }).lean();
  assert.ok(hold);
  assert.equal(hold.reasonCode, "REFUND_EXPOSURE");
  const refund = await DigitalMetalPaymentExceptionRefund.findOne({ orderId: order._id }).lean();
  assert.ok(refund);
});

test("deactivated destination blocks bank submission", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, dest, adminToken } = await sellThroughConfirm({ tenant, user, customer, token });
  await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  const payable = await DigitalMetalPayable.findOne({ sellOrderId: order.id }).lean();
  const approverToken = await approverTokenFor({ tenant, branch, mobile: "+918811122244" });
  const p1 = await request(app)
    .post("/api/v1/admin/digital-metals/payouts")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ payableId: payable._id });
  const payoutId = p1.body.data.payout.id;
  await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/approve`)
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  await DigitalMetalBankDestination.updateOne({ _id: dest._id }, { $set: { status: "DISABLED" } });
  const submit = await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/submit`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ bankReference: "NEFT-X" });
  assert.equal(submit.status, 409);
  assert.equal(submit.body.error?.code, "DESTINATION_UNAVAILABLE");
});

test("unknown payout requires evidenced resolution before retry", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, token });
  await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  const payable = await DigitalMetalPayable.findOne({ sellOrderId: order.id }).lean();
  const approverToken = await approverTokenFor({ tenant, branch, mobile: "+918811122255" });
  const p1 = await request(app)
    .post("/api/v1/admin/digital-metals/payouts")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ payableId: payable._id });
  const payoutId = p1.body.data.payout.id;
  await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/approve`)
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/submit`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ bankReference: "NEFT-UNK" });
  await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/mark-unknown`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ reason: "No confirmation" });
  const dup = await request(app)
    .post("/api/v1/admin/digital-metals/payouts")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ payableId: payable._id });
  assert.equal(dup.status, 409);
  const resolve = await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/resolve-unknown`)
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      outcome: "FAILED",
      resolutionNote: "Bank confirmed debit did not land",
      evidenceUploadIds: ["upl_1"],
    });
  assert.equal(resolve.status, 200);
  const retry = await request(app)
    .post("/api/v1/admin/digital-metals/payouts")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ payableId: payable._id });
  assert.equal(retry.status, 201);
});

test("overpayment prevented across payout attempts", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, token });
  await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  const payable = await DigitalMetalPayable.findOne({ sellOrderId: order.id }).lean();
  const approverToken = await approverTokenFor({ tenant, branch, mobile: "+918811122266" });
  const firstSlice = Math.floor(payable.amountPaise * 0.6);
  const p1 = await request(app)
    .post("/api/v1/admin/digital-metals/payouts")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ payableId: payable._id, amountPaise: firstSlice });
  const payoutId = p1.body.data.payout.id;
  await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/approve`)
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/submit`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ bankReference: "NEFT-PART" });
  await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/record-settlement`)
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      settlementDate: "2026-10-16",
      bankReference: "NEFT-PART",
      evidenceUploadIds: ["upl_part"],
      approverAttestation: true,
    });
  const freshPayable = await DigitalMetalPayable.findById(payable._id).lean();
  const over = await request(app)
    .post("/api/v1/admin/digital-metals/payouts")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ payableId: payable._id, amountPaise: freshPayable.outstandingPaise + 1 });
  assert.notEqual(over.status, 201);
  assert.ok([400, 409].includes(over.status));
});

test("tenant pause does not block settling open payable", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, token });
  await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "operations.digitalMetalsPaused": true, "operations.digitalMetalsPauseReason": "test" } },
  );
  const payable = await DigitalMetalPayable.findOne({ sellOrderId: order.id }).lean();
  const approverToken = await approverTokenFor({ tenant, branch, mobile: "+918811122277" });
  const p1 = await request(app)
    .post("/api/v1/admin/digital-metals/payouts")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ payableId: payable._id });
  const payoutId = p1.body.data.payout.id;
  await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/approve`)
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/submit`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ bankReference: "NEFT-PAUSE" });
  const settle = await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/record-settlement`)
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      settlementDate: "2026-10-16",
      bankReference: "NEFT-PAUSE",
      evidenceUploadIds: ["upl_settle"],
      approverAttestation: true,
    });
  assert.equal(settle.status, 200);
  assert.equal(settle.body.data.payout.settlementVerification, "STAFF_ATTESTED");
  const freshPayable = await DigitalMetalPayable.findById(payable._id).lean();
  assert.equal(freshPayable.status, "SETTLED");
});

test("customer payout status distinguishes sale executed from bank settled", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, token });
  await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  const status = await request(app)
    .get(`/api/v1/app/digital-metals/sell-orders/${order.id}/payout-status`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.data.saleExecuted, true);
  assert.equal(status.body.data.bankPayoutSettled, false);
  assert.ok(status.body.data.payoutDestinationMasked?.accountLast4);
});

test("scoped REFUND_CASE hold from uncredited LATE_SUCCESS does not block sell quote", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedWalletGold({ tenant, customer, quantityUg: UG_PER_G });
  const order = await DigitalMetalBuyOrder.create({
    _id: createId("dmbo"),
    tenantId: tenant._id,
    customerId: customer._id,
    branchId: branch._id,
    quoteId: createId("dmq"),
    status: "PAYMENT_PENDING",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: UG_PER_G,
    totalPayablePaise: 50_000,
    quoteExpiresAt: new Date(Date.now() + 86_400_000),
    paymentAcceptanceExpiresAt: new Date(Date.now() - 60_000),
    termsVersion: "v1",
    termsContentHash: "hash",
    termsAcceptedAt: new Date(),
    idempotencyKey: randomUUID(),
  });
  await withTransaction((session) =>
    ensureDigitalMetalPaymentExceptionRefundCase(session, {
      tenantId: tenant._id,
      order,
      paymentAttemptId: createId("dmpay"),
      merchantOrderId: "m1",
      amountPaise: 50_000,
      exceptionType: "LATE_SUCCESS",
    }),
  );
  const hold = await DigitalMetalCustomerRiskHold.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    status: "ACTIVE",
  }).lean();
  assert.equal(hold.holdScope, "REFUND_CASE");
  assert.equal(hold.blocksSell, false);
  const sellQuote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/sell")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ metal: "GOLD", finenessPpm: 999000, quantityUg: UG_PER_G });
  assert.equal(sellQuote.status, 201);
});
