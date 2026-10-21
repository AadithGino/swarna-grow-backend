import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import {
  DigitalMetalBankDestination,
  DigitalMetalCustomerRiskHold,
  DigitalMetalPayable,
  DigitalMetalSellOrder,
  Tenant,
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
import { Session } from "../src/models/index.js";
import { withTransaction } from "../src/lib/transaction.js";
import { creditWalletForTest } from "../src/services/digital-metals-ledger.service.js";
import { seal } from "../src/lib/crypto.js";

const app = createApp();
const G4 = 4_000_000;

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
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
  const confirm = await request(app)
    .post(`/api/v1/app/digital-metals/sell-orders/${order.body.data.id}/confirm`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ bankDestinationId: dest._id });
  assert.equal(confirm.status, 200);
  return { order: order.body.data, dest, adminToken: bearerFor(user), user };
}

test("risk hold blocks sell quote", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await seedWalletGold({ tenant, customer });
  await DigitalMetalCustomerRiskHold.create({
    _id: createId("dmrh"),
    tenantId: tenant._id,
    customerId: customer._id,
    status: "ACTIVE",
    reasonCode: "CHARGEBACK",
    exposurePaise: 50_000,
  });
  const res = await request(app)
    .post("/api/v1/app/digital-metals/quotes/sell")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ metal: "GOLD", finenessPpm: 999000, quantityUg: UG_PER_G });
  assert.equal(res.status, 409);
  assert.equal(res.body.error?.code, "DIGITAL_METALS_RISK_HOLD");
});

test("sell execution creates payable; payout maker cannot approve", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order, adminToken, user: maker } = await sellThroughConfirm({ tenant, user, customer, token });
  const approve = await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  assert.equal(approve.status, 200);
  assert.equal(approve.body.data.status, "PAYABLE_OPEN");
  const payable = await DigitalMetalPayable.findOne({ sellOrderId: order.id }).lean();
  assert.ok(payable?.outstandingPaise > 0);
  const payoutCreate = await request(app)
    .post("/api/v1/admin/digital-metals/payouts")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ payableId: payable._id });
  assert.equal(payoutCreate.status, 201);
  const payoutId = payoutCreate.body.data.payout.id;
  const selfApprove = await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  assert.equal(selfApprove.status, 403);
  assert.equal(selfApprove.body.error?.code, "APPROVAL_DENIED");
  assert.ok(maker._id);
});

test("unknown payout blocks duplicate disbursement", async () => {
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
  const { user: approver } = await seedTenantUser({
    tenantId: tenant._id,
    role: "TENANT_ADMIN",
    mobile: "+918811122233",
  });
  const approverToken = bearerFor(approver);
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
    .send({ bankReference: "NEFT-001" });
  await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/mark-unknown`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ reason: "No bank confirmation" });
  const dup = await request(app)
    .post("/api/v1/admin/digital-metals/payouts")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ payableId: payable._id });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error?.code, "PAYOUT_IN_FLIGHT");
});

test("concurrent sell reservations: only one succeeds from limited balance", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await seedWalletGold({ tenant, customer, quantityUg: G4 + 1_000_000 });
  const token = await customerToken({ tenant, branch, customer });
  const run = async () => {
    const quote = await request(app)
      .post("/api/v1/app/digital-metals/quotes/sell")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({ metal: "GOLD", finenessPpm: 999000, quantityUg: G4 });
    const order = await request(app)
      .post("/api/v1/app/digital-metals/sell-orders")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        quoteId: quote.body.data.quoteId,
        termsVersionAccepted: quote.body.data.termsVersion,
        termsContentHashAccepted: quote.body.data.termsContentHash,
      });
    return order.status;
  };
  const [a, b] = await Promise.all([run(), run()]);
  const ok = [a, b].filter((s) => s === 201).length;
  assert.equal(ok, 1);
});

test("cross-tenant bank destination access returns 404", async () => {
  const { tenant: t1, branch: b1 } = await seedTenantUser({});
  const { tenant: t2, branch: b2, user: u2 } = await seedTenantUser({});
  const c1 = await seedCustomer({ tenantId: t1._id, branchId: b1._id });
  const dest = await activeBankDestination({ tenant: t1, customer: c1 });
  const res = await request(app)
    .get(`/api/v1/admin/digital-metals/customers/${c1._id}/bank-destinations`)
    .set("Authorization", `Bearer ${bearerFor(u2)}`);
  assert.equal(res.status, 404);
  const c2 = await seedCustomer({ tenantId: t2._id, branchId: b2._id, mobile: "+918877766655" });
  const token2 = await customerToken({ tenant: t2, branch: b2, customer: c2 });
  const leak = await request(app)
    .post(`/api/v1/app/digital-metals/sell-orders/fake/confirm`)
    .set("Authorization", `Bearer ${token2}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ bankDestinationId: dest._id });
  assert.ok(leak.status === 404 || leak.status === 409);
});

test("approval expiry releases reservation", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const { order } = await sellThroughConfirm({ tenant, user, customer, token });
  await DigitalMetalSellOrder.updateOne(
    { _id: order.id },
    { $set: { approvalExpiresAt: new Date(Date.now() - 60_000) } },
  );
  const approve = await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/approve`)
    .set("Authorization", `Bearer ${bearerFor(user)}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({});
  assert.equal(approve.status, 409);
  const fresh = await DigitalMetalSellOrder.findById(order.id).lean();
  assert.equal(fresh.status, "EXPIRED");
});
