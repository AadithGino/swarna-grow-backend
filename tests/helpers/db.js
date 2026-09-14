import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import argon2 from "argon2";
import { Branch, Tenant, User } from "../../src/models/index.js";
import { TenantRole, TenantStatus, UserStatus, UserType } from "../../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../../src/constants/permissions.js";
import { createId } from "../../src/lib/ids.js";

let replSet;

export async function startTestDb() {
  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri("swarnagrow_test"));
}

export async function stopTestDb() {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
  replSet = undefined;
}

export async function resetTestDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

export async function seedTenantUser({ mobile = "+919888877766", password = "SecurePass!123", role = TenantRole.TENANT_OWNER } = {}) {
  const tenant = await Tenant.create({
    _id: createId("tenant"),
    code: "TESTCO",
    name: "Test Jewellers",
    mobile: "+919700000001",
    status: TenantStatus.ACTIVE,
  });
  const branch = await Branch.create({
    _id: createId("branch"),
    tenantId: tenant._id,
    code: "HQ",
    name: "Head Office",
    isHeadOffice: true,
    active: true,
  });
  const user = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role,
    name: "Test User",
    mobile,
    passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[role] ?? [],
  });
  return { tenant, branch, user, password };
}
