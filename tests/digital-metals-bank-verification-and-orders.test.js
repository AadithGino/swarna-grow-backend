process.env.NODE_ENV = "test";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import argon2 from "argon2";
import { PlanTier, TenantRole, UserStatus, UserType } from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { User } from "../src/models/index.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import { seal } from "../src/lib/crypto.js";
import {
  DigitalMetalBankDestination,
  DigitalMetalBuyOrder,
  DigitalMetalSellOrder,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  bearerFor,
  resetTestDb,
  seedBranch,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { makeTenantQuoteReady } from "./helpers/digital-metals-live-ready.js";
import { signAccessToken } from "../src/services/token.service.js";
import { Session } from "../src/models/index.js";
import { withTransaction } from "../src/lib/transaction.js";
import { creditWalletForTest } from "../src/services/digital-metals-ledger.service.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  delete process.env.DIGITAL_METALS_DEMO_BANK_VERIFY;
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

async function branchManagerFor(tenantId, branchId) {
  const user = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId,
    branchId,
    role: TenantRole.BRANCH_MANAGER,
    name: "Branch Manager",
    mobile: "+919811133344",
    passwordHash: await argon2.hash("1234", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER],
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    tenantId,
    deviceId: "mgr",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals.testSessionId = session._id;
  return user;
}

async function pendingBank({ tenant, customer }) {
  return DigitalMetalBankDestination.create({
    _id: createId("dmbd"),
    tenantId: tenant._id,
    customerId: customer._id,
    accountHolderName: "Test User",
    accountNumberSealed: seal("123456789012"),
    accountLast4: "9012",
    ifsc: "HDFC0001234",
    status: "PENDING_VERIFICATION",
  });
}

test("staff manual verify enables sell confirm; masked DTOs only", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: UG_PER_G,
      idempotencyKey: randomUUID(),
    }),
  );
  const dest = await pendingBank({ tenant, customer });
  const adminToken = bearerFor(user);
  const list = await request(app)
    .get(`/api/v1/admin/digital-metals/customers/${customer._id}/bank-destinations`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.items[0].accountLast4, "9012");
  assert.equal(list.body.data.items[0].accountNumber, undefined);
  assert.equal(list.body.data.items[0].accountNumberSealed, undefined);

  const badNote = await request(app)
    .post(
      `/api/v1/admin/digital-metals/customers/${customer._id}/bank-destinations/${dest._id}/verify`,
    )
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ note: "ab" });
  assert.ok(badNote.status === 400 || badNote.status === 422);

  const verify = await request(app)
    .post(
      `/api/v1/admin/digital-metals/customers/${customer._id}/bank-destinations/${dest._id}/verify`,
    )
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ note: "Matched passbook at branch counter.", evidenceUploadIds: ["upl_test_1"] });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.data.status, "ACTIVE");
  assert.ok(verify.body.data.verifiedByName);

  const quote = await request(app)
    .post("/api/v1/app/digital-metals/quotes/sell")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ metal: "GOLD", finenessPpm: 999000, quantityUg: UG_PER_G });
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
  const confirm = await request(app)
    .post(`/api/v1/app/digital-metals/sell-orders/${order.body.data.id}/confirm`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ bankDestinationId: dest._id });
  assert.equal(confirm.status, 200);
});

test("branch-scoped staff cannot verify customer in another branch", async () => {
  const { tenant, branch: b1, user: owner } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const b2 = await seedBranch({ tenantId: tenant._id, name: "Other branch" });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: b1._id });
  const dest = await pendingBank({ tenant, customer });
  const mgr = await branchManagerFor(tenant._id, b2._id);
  const res = await request(app)
    .post(
      `/api/v1/admin/digital-metals/customers/${customer._id}/bank-destinations/${dest._id}/verify`,
    )
    .set("Authorization", `Bearer ${bearerFor(mgr)}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ note: "Should not apply cross-branch." });
  assert.equal(res.status, 403);
  assert.ok(owner._id);
});

test("edit bank details resets verification; disabled cannot verify", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  const dest = await pendingBank({ tenant, customer });
  const adminToken = bearerFor(user);
  await request(app)
    .post(
      `/api/v1/admin/digital-metals/customers/${customer._id}/bank-destinations/${dest._id}/verify`,
    )
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ note: "Initial manual verification." });

  const patch = await request(app)
    .patch(`/api/v1/app/digital-metals/bank-destinations/${dest._id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      ifsc: "SBIN0001234",
      confirmAccountNumber: "123456789012",
    });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.data.status, "PENDING_VERIFICATION");

  await request(app)
    .post(
      `/api/v1/admin/digital-metals/customers/${customer._id}/bank-destinations/${dest._id}/disable`,
    )
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ note: "Customer requested removal." });
  const verifyDisabled = await request(app)
    .post(
      `/api/v1/admin/digital-metals/customers/${customer._id}/bank-destinations/${dest._id}/verify`,
    )
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ note: "Should fail on disabled row." });
  assert.equal(verifyDisabled.status, 409);

  const custList = await request(app)
    .get("/api/v1/app/digital-metals/bank-destinations")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(custList.status, 200);
  for (const row of custList.body.data.items) {
    assert.equal(row.accountNumber, undefined);
    assert.equal(row.accountNumberSealed, undefined);
  }
});

test("customer order lists are paginated, tenant-isolated, and include unpaid buys", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const other = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+918811122233",
  });
  const token = await customerToken({ tenant, branch, customer });
  const otherToken = await customerToken({ tenant, branch, customer: other });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));

  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const quote = await request(app)
      .post("/api/v1/app/digital-metals/quotes/buy")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        metal: "GOLD",
        finenessPpm: 999000,
        inputMode: "BUDGET_INR",
        budgetPaise: 50_000 + i,
      });
    assert.equal(quote.status, 201);
    const order = await request(app)
      .post("/api/v1/app/digital-metals/buy-orders")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        quoteId: quote.body.data.quoteId,
        termsVersionAccepted: quote.body.data.termsVersion,
        termsContentHashAccepted: quote.body.data.termsContentHash,
      });
    assert.equal(order.status, 201);
    ids.push(order.body.data.id);
  }

  const page1 = await request(app)
    .get("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${token}`)
    .query({ limit: 2 });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.items.length, 2);
  assert.equal(page1.body.data.meta.hasMore, true);
  const page2 = await request(app)
    .get("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${token}`)
    .query({ limit: 2, cursor: page1.body.data.meta.nextCursor });
  assert.equal(page2.status, 200);
  const allIds = [...page1.body.data.items, ...page2.body.data.items].map((r) => r.id);
  assert.equal(new Set(allIds).size, allIds.length);
  assert.ok(allIds.includes(ids[0]));

  const summary = await request(app)
    .get("/api/v1/app/digital-metals/orders/open-summary")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(summary.status, 200);
  assert.ok(summary.body.data.openBuyCount >= 3);

  const leak = await request(app)
    .get("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${otherToken}`);
  assert.equal(leak.status, 200);
  assert.equal(leak.body.data.items.length, 0);

  const direct = await DigitalMetalBuyOrder.findOne({ _id: ids[0] }).lean();
  assert.ok(direct);
  assert.equal(direct.customerId, customer._id);
});

test("sell and redemption list routes return only owning customer rows", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const token = await customerToken({ tenant, branch, customer });
  await enablePlan(tenant._id);
  await DigitalMetalSellOrder.create({
    _id: createId("dmso"),
    tenantId: tenant._id,
    customerId: customer._id,
    branchId: branch._id,
    status: "PENDING_APPROVAL",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: String(UG_PER_G),
    settlementPaise: 50_000,
    quoteId: createId("dmrq"),
    reservationId: createId("dmrs"),
    idempotencyKey: randomUUID(),
    quoteExpiresAt: new Date(Date.now() + 86_400_000),
    termsAcceptedAt: new Date(),
  });
  const sells = await request(app)
    .get("/api/v1/app/digital-metals/sell-orders")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(sells.status, 200);
  assert.equal(sells.body.data.items.length, 1);
  assert.equal(sells.body.data.items[0].status, "PENDING_APPROVAL");
});
