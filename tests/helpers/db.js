import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import argon2 from "argon2";
import { Branch, Customer, Tenant, User } from "../../src/models/index.js";
import { TenantRole, TenantStatus, UserStatus, UserType } from "../../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../../src/constants/permissions.js";
import { createId } from "../../src/lib/ids.js";
import { signAccessToken } from "../../src/services/token.service.js";

let replSet;
let tenantCodeSeq = 0;

export async function startTestDb() {
  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
  if (replSet) {
    try { await replSet.stop({ doCleanup: true, force: true }); } catch { /* ignore */ }
    replSet = undefined;
  }
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
      await mongoose.connect(replSet.getUri("swarnagrow_test"));
      return;
    } catch (error) {
      lastError = error;
      try { if (replSet) await replSet.stop({ doCleanup: true, force: true }); } catch { /* ignore */ }
      replSet = undefined;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function stopTestDb() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) {
    try { await replSet.stop({ doCleanup: true, force: true }); } catch { /* ignore */ }
    replSet = undefined;
  }
}

export async function resetTestDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
  tenantCodeSeq = 0;
}

export function bearerFor(user, permissions = ROLE_PERMISSIONS[user.role] ?? user.permissions ?? []) {
  return signAccessToken({
    id: user._id,
    type: user.type ?? "TENANT_USER",
    tenantId: user.tenantId,
    branchId: user.branchId,
    role: user.role,
    permissions,
    deviceId: "test-device",
  });
}

export async function seedTenantUser({
  mobile = "+919888877766",
  password = "SecurePass!123",
  role = TenantRole.TENANT_OWNER,
  tenantCode,
  branchCode = "HQ",
  name = "Test User",
} = {}) {
  tenantCodeSeq += 1;
  const code = tenantCode ?? (tenantCodeSeq === 1 ? "TESTCO" : `T${String(tenantCodeSeq).padStart(4, "0")}`);
  const tenant = await Tenant.create({
    _id: createId("tenant"),
    code,
    name: `${code} Jewellers`,
    mobile: `+9197${String(10000000 + tenantCodeSeq).slice(-8)}`,
    status: TenantStatus.ACTIVE,
  });
  const branch = await Branch.create({
    _id: createId("branch"),
    tenantId: tenant._id,
    code: branchCode,
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
    name,
    mobile,
    passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[role] ?? [],
  });
  return { tenant, branch, user, password };
}

export async function seedBranch({ tenantId, code = "BR2", name = "Second Branch" }) {
  return Branch.create({ _id: createId("branch"), tenantId, code, name, isHeadOffice: false, active: true });
}

export async function seedCustomer({ tenantId, branchId, mobile = "+918800000001", name = "Test Customer" }) {
  return Customer.create({
    _id: createId("customer"),
    tenantId,
    branchId,
    customerNumber: `C${Date.now()}${Math.floor(Math.random() * 1000)}`,
    name,
    mobile,
  });
}

/** Seeded tenant + HQ branch + staff + customer for integration tests. */
export async function seedFixture({ role = TenantRole.TENANT_OWNER, mobile } = {}) {
  const seeded = await seedTenantUser({ role, mobile: mobile ?? `+9198${String(Date.now()).slice(-8)}` });
  const customer = await seedCustomer({ tenantId: seeded.tenant._id, branchId: seeded.branch._id });
  return { ...seeded, customer, token: bearerFor(seeded.user) };
}
