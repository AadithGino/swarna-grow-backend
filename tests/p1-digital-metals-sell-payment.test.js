process.env.NODE_ENV = "test";

import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId } from "../src/lib/ids.js";
import { DigitalMetalPayable, DigitalMetalPayout, DigitalMetalSellOrder } from "../src/models/index.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb, bearerFor } from "./helpers/db.js";
import { sellThroughConfirm } from "./helpers/digital-metals-sell-flow.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

async function acceptSale(adminToken, orderId, version = 1) {
  return request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${orderId}/accept`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ expectedVersion: version });
}

test("same operator accepts sale and records partial then full payment", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, app });
  assert.equal(order.status, "PAYABLE_OPEN");
  const accepted = await acceptSale(adminToken, order.id, order.version);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.data.status, "PAYABLE_OPEN");
  assert.equal(accepted.body.data.paymentDisplayState?.key ?? "UNPAID", "UNPAID");

  const partialKey = randomUUID();
  const partial = await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/record-payment`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", partialKey)
    .send({
      expectedVersion: accepted.body.data.version,
      amountPaise: Math.floor(Number(order.settlementPaise) / 2),
      settlementDate: "2026-10-31",
      bankReference: "UTR-PART-1",
      evidenceUploadIds: ["upl_1"],
      staffAttestation: true,
    });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.data.payout.status, "SETTLED");

  const detail = await request(app)
    .get(`/api/v1/admin/digital-metals/sell-orders/${order.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(detail.body.data.paymentDisplayState.key, "PARTIALLY_PAID");

  const full = await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/record-payment`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      expectedVersion: detail.body.data.version,
      amountPaise: detail.body.data.payable.outstandingPaise,
      settlementDate: "2026-10-31",
      bankReference: "UTR-FULL-2",
      evidenceUploadIds: ["upl_2"],
      staffAttestation: true,
    });
  assert.equal(full.status, 200);
  const paid = await request(app)
    .get(`/api/v1/admin/digital-metals/sell-orders/${order.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(paid.body.data.paymentDisplayState.key, "PAID");
});

test("record payment idempotency replays same payout", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, app });
  const accepted = await acceptSale(adminToken, order.id, order.version);
  const key = randomUUID();
  const body = {
    expectedVersion: accepted.body.data.version,
    amountPaise: Number(order.settlementPaise),
    settlementDate: "2026-10-31",
    bankReference: "UTR-IDEM",
    evidenceUploadIds: ["upl_1"],
    staffAttestation: true,
  };
  const first = await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/record-payment`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", key)
    .send(body);
  const second = await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/record-payment`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", key)
    .send(body);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers["x-idempotent-replay"], "true");
  assert.equal(second.body.data.payout.id, first.body.data.payout.id);
  assert.equal(await DigitalMetalPayout.countDocuments({ sellOrderId: order.id }), 1);
});

test("accept returns 409 when legacy approval window expired", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, app });
  await DigitalMetalSellOrder.updateOne(
    { _id: order.id },
    {
      $set: {
        status: "PENDING_APPROVAL",
        payableId: null,
        executedAt: null,
        approvalExpiresAt: new Date(Date.now() - 60_000),
      },
    },
  );
  await DigitalMetalPayable.deleteMany({ sellOrderId: order.id });
  const res = await acceptSale(adminToken, order.id, order.version);
  assert.equal(res.status, 409);
  const fresh = await DigitalMetalSellOrder.findById(order.id).lean();
  assert.equal(fresh.status, "EXPIRED");
});

test("record payment blocked while unknown payout is in flight", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, app });
  const accepted = await acceptSale(adminToken, order.id, order.version);
  assert.equal(accepted.status, 200);
  const sell = await DigitalMetalSellOrder.findById(order.id).lean();
  await DigitalMetalPayout.create({
    _id: createId("dmpos"),
    tenantId: tenant._id,
    payableId: sell.payableId,
    sellOrderId: order.id,
    customerId: customer._id,
    amountPaise: 10_000,
    status: "UNKNOWN",
    makerUserId: user._id,
    destinationSnapshot: { accountHolderName: "A", accountLast4: "9012", ifsc: "HDFC0001234" },
    idempotencyKey: randomUUID(),
    statusHistory: [{ at: new Date(), status: "UNKNOWN", actorUserId: user._id, note: "test" }],
  });
  const blocked = await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/record-payment`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      expectedVersion: accepted.body.data.version,
      amountPaise: 10_000,
      settlementDate: "2026-10-31",
      bankReference: "UTR-BLOCK",
      evidenceUploadIds: ["upl_1"],
      staffAttestation: true,
    });
  assert.equal(blocked.status, 409);
});

test("admin sell list Paid tab filters by settled payable not sell order status", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { order, adminToken } = await sellThroughConfirm({ tenant, user, customer, app });
  const accepted = await acceptSale(adminToken, order.id, order.version);
  await request(app)
    .post(`/api/v1/admin/digital-metals/sell-orders/${order.id}/record-payment`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      expectedVersion: accepted.body.data.version,
      amountPaise: Number(order.settlementPaise),
      settlementDate: "2026-10-31",
      bankReference: "UTR-LIST-1",
      evidenceUploadIds: ["upl_1"],
      staffAttestation: true,
    });

  const owed = await request(app)
    .get("/api/v1/admin/digital-metals/sell-orders")
    .query({ status: "PAYABLE_OPEN", limit: 50 })
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(owed.status, 200);
  assert.ok(!owed.body.data.items.some((row) => row.id === order.id));

  const paid = await request(app)
    .get("/api/v1/admin/digital-metals/sell-orders")
    .query({ status: "SETTLED", limit: 50 })
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(paid.status, 200);
  assert.ok(paid.body.data.items.some((row) => row.id === order.id));
  const row = paid.body.data.items.find((r) => r.id === order.id);
  assert.equal(row.status, "PAYABLE_OPEN");
  assert.equal(row.paymentDisplayState.key, "PAID");
});

test("branch manager cannot accept sell for customer in another branch", async () => {
  const argon2 = (await import("argon2")).default;
  const { TenantRole, UserStatus, UserType } = await import("../src/constants/enums.js");
  const { ROLE_PERMISSIONS } = await import("../src/constants/permissions.js");
  const { Branch, Session, User } = await import("../src/models/index.js");
  const { createId } = await import("../src/lib/ids.js");
  const { tenant, branch: branchA, user } = await seedTenantUser({});
  const branchB = await Branch.create({
    _id: createId("branch"),
    tenantId: tenant._id,
    name: "B",
    code: "BRB",
    active: true,
  });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id });
  const { order } = await sellThroughConfirm({ tenant, user, customer, app });
  const managerA = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branchA._id,
    role: TenantRole.BRANCH_MANAGER,
    name: "Mgr A",
    mobile: "+918811199991",
    passwordHash: await argon2.hash("1234", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER] ?? [],
  });
  const mgrSession = await Session.create({
    _id: createId("session"),
    userId: managerA._id,
    tenantId: tenant._id,
    deviceId: "mgr",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  managerA.$locals = { testSessionId: mgrSession._id };
  const res = await acceptSale(bearerFor(managerA), order.id);
  assert.equal(res.status, 403);
});
