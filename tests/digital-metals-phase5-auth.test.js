import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier, TenantRole, UserStatus, UserType } from "../src/constants/enums.js";
import { Permission, ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { DigitalMetalPayable, DigitalMetalPayout, Session, Tenant, User } from "../src/models/index.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { createId } from "../src/lib/ids.js";

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

async function makerOnlyToken({ tenant, branch }) {
  const perms = (ROLE_PERMISSIONS[TenantRole.TENANT_ADMIN] ?? []).filter(
    (p) => p !== Permission.DIGITAL_METALS_PAYOUT_APPROVE && p !== Permission.DIGITAL_METALS_RISK_MANAGE,
  );
  const user = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.TENANT_ADMIN,
    name: "MakerOnly",
    mobile: "+918811199991",
    passwordHash: await argon2.hash("1234", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
    status: UserStatus.ACTIVE,
    permissions: perms,
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    tenantId: tenant._id,
    deviceId: "maker",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals.testSessionId = session._id;
  return bearerFor(user, perms);
}

test("payout settlement requires payout.approve permission", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enablePlan(tenant._id);
  const payableId = createId("dmpaybl");
  const payoutId = createId("dmpos");
  await DigitalMetalPayable.create({
    _id: payableId,
    tenantId: tenant._id,
    customerId: customer._id,
    sellOrderId: createId("dmso"),
    amountPaise: 500_00,
    outstandingPaise: 500_00,
    status: "OPEN",
  });
  await DigitalMetalPayout.create({
    _id: payoutId,
    tenantId: tenant._id,
    payableId,
    sellOrderId: createId("dmso"),
    customerId: customer._id,
    amountPaise: 500_00,
    status: "SUBMITTED",
    destinationSnapshot: { accountLast4: "9012", ifsc: "HDFC0001234", accountHolderName: "Test" },
    makerUserId: user._id,
    idempotencyKey: randomUUID(),
    statusHistory: [],
  });
  const makerToken = await makerOnlyToken({ tenant, branch });
  const settle = await request(app)
    .post(`/api/v1/admin/digital-metals/payouts/${payoutId}/record-settlement`)
    .set("Authorization", `Bearer ${makerToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      settlementDate: "2026-10-16",
      bankReference: "NEFT-X",
      evidenceUploadIds: ["upl_1"],
      approverAttestation: true,
    });
  assert.equal(settle.status, 403);
});

test("branch manager cannot read risk holds for customer in another branch", async () => {
  const { tenant, branch: branchA } = await seedTenantUser({});
  const { Branch } = await import("../src/models/index.js");
  const branchB = await Branch.create({
    _id: createId("branch"),
    tenantId: tenant._id,
    name: "Branch B",
    code: "BRB",
    active: true,
  });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id });
  await enablePlan(tenant._id);
  const managerA = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branchA._id,
    role: TenantRole.BRANCH_MANAGER,
    name: "Mgr A",
    mobile: "+918811199992",
    passwordHash: await argon2.hash("1234", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER] ?? [],
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: managerA._id,
    tenantId: tenant._id,
    deviceId: "mgr",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  managerA.$locals.testSessionId = session._id;
  const token = bearerFor(managerA);
  const res = await request(app)
    .get(`/api/v1/admin/digital-metals/customers/${customerB._id}/risk-holds`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 403);
});

test("payout detail returns permittedActions envelope", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enablePlan(tenant._id);
  const payableId = createId("dmpaybl");
  const payoutId = createId("dmpos");
  await DigitalMetalPayable.create({
    _id: payableId,
    tenantId: tenant._id,
    customerId: customer._id,
    sellOrderId: createId("dmso"),
    amountPaise: 500_00,
    outstandingPaise: 500_00,
    status: "OPEN",
  });
  await DigitalMetalPayout.create({
    _id: payoutId,
    tenantId: tenant._id,
    payableId,
    sellOrderId: createId("dmso"),
    customerId: customer._id,
    amountPaise: 500_00,
    status: "PENDING_APPROVAL",
    destinationSnapshot: { accountLast4: "9012", ifsc: "HDFC0001234", accountHolderName: "Test" },
    makerUserId: user._id,
    idempotencyKey: randomUUID(),
    statusHistory: [],
  });
  const adminToken = bearerFor(user);
  const detail = await request(app)
    .get(`/api/v1/admin/digital-metals/payouts/${payoutId}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.body.data.payout.permittedActions));
  assert.ok(detail.body.data.payable.outstandingPaise !== undefined);
});

test("risk hold resolve requires risk.manage permission", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enablePlan(tenant._id);
  const holdId = createId("dmrh");
  await (await import("../src/models/index.js")).DigitalMetalCustomerRiskHold.create({
    _id: holdId,
    tenantId: tenant._id,
    customerId: customer._id,
    status: "ACTIVE",
    reasonCode: "MANUAL",
    exposurePaise: 100,
    holdScope: "TRADING",
    blocksSell: true,
    blocksRedemption: true,
  });
  const readOnlyToken = await makerOnlyToken({ tenant, branch });
  const res = await request(app)
    .post(`/api/v1/admin/digital-metals/risk-holds/${holdId}/resolve`)
    .set("Authorization", `Bearer ${readOnlyToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ resolutionNote: "Should fail auth" });
  assert.equal(res.status, 403);
});
