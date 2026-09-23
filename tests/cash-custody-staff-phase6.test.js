import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { CashAdjustment, User } from "../src/models/index.js";
import {
  CashAdjustmentDirection,
  HandoverInitiator,
  TenantRole,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { createCashAdjustment, createHandover } from "../src/services/cash.service.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { resetTestDb, seedBranch, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function adjustmentReq({ tenant, branch, manager, staffId, body = {} }) {
  return {
    auth: { id: manager._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.BRANCH_MANAGER },
    scope: { tenantId: tenant._id, branchId: branch._id },
    body: {
      staffId,
      direction: CashAdjustmentDirection.CREDIT,
      amountPaise: 1_000,
      reason: "Test adjustment",
      ...body,
    },
  };
}

test("cash adjustment rejects inactive staff without write", async () => {
  const { tenant, branch, user: manager } = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER });
  const staff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Inactive staff",
    mobile: "+919811100001",
    passwordHash: await argon2.hash("1234"),
    status: UserStatus.INACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
  });
  await assert.rejects(
    () => createCashAdjustment(adjustmentReq({ tenant, branch, manager, staffId: staff._id })),
    (error) => error.code === "STAFF_NOT_ACTIVE",
  );
  assert.equal(await CashAdjustment.countDocuments({ tenantId: tenant._id }), 0);
});

test("cash adjustment rejects non-cash-role staff", async () => {
  const { tenant, branch, user: manager } = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER });
  const staff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.TENANT_OWNER,
    name: "Owner staff",
    mobile: "+919811100002",
    passwordHash: await argon2.hash("1234"),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_OWNER],
  });
  await assert.rejects(
    () => createCashAdjustment(adjustmentReq({ tenant, branch, manager, staffId: staff._id })),
    (error) => error.code === "STAFF_NOT_CASH_HANDLER",
  );
});

test("branch-scoped handover returns 404 for off-branch staff id", async () => {
  const { tenant, branch, user: manager } = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER });
  const otherBranch = await seedBranch({ tenantId: tenant._id, code: "OFF" });
  const offBranchStaff = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: otherBranch._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Off branch",
    mobile: "+919811100003",
    passwordHash: await argon2.hash("1234"),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
  });
  await assert.rejects(
    () => createHandover({
      auth: { id: manager._id, tenantId: tenant._id, type: "TENANT_USER" },
      scope: { tenantId: tenant._id, branchId: branch._id },
      body: { staffId: offBranchStaff._id, amountPaise: 1_000 },
    }, HandoverInitiator.ADMIN),
    (error) => error.code === "RESOURCE_NOT_FOUND",
  );
});
