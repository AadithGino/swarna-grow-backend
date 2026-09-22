import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import argon2 from "argon2";
import { Branch, Customer, Session, Tenant, User } from "../../src/models/index.js";
import { TenantRole, TenantStatus, UserStatus, UserType } from "../../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../../src/constants/permissions.js";
import { createId } from "../../src/lib/ids.js";
import { signAccessToken } from "../../src/services/token.service.js";

let replSet;
let tenantCodeSeq = 0;
/** Nested test files in one process must not tear down Mongo while siblings still run. */
let testDbRefCount = 0;

export async function startTestDb() {
  testDbRefCount += 1;
  if (testDbRefCount > 1 && mongoose.connection.readyState === 1) {
    return;
  }
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
  testDbRefCount = Math.max(0, testDbRefCount - 1);
  if (testDbRefCount > 0) return;

  const { clearIdempotencyHeartbeatsForTests } = await import("../../src/middlewares/idempotency.middleware.js");
  const { clearRateLimitStoresForTests } = await import("../../src/middlewares/security.middleware.js");
  const { disconnectRedis } = await import("../../src/config/redis.js");
  clearIdempotencyHeartbeatsForTests();
  await clearRateLimitStoresForTests();
  await disconnectRedis().catch(() => {});

  const disconnect = mongoose.connection.readyState !== 0
    ? mongoose.disconnect()
    : Promise.resolve();
  await Promise.race([
    disconnect,
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);

  if (replSet) {
    const instance = replSet;
    replSet = undefined;
    await Promise.race([
      instance.stop({ doCleanup: true, force: true }),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]).catch(() => {});
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
    securityVersion: user.securityVersion ?? 0,
    sessionId: user.$locals?.testSessionId,
  });
}

export async function seedTenantUser({
  mobile = "+919888877766",
  password = "1234",
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
    subscription: {
      status: "ACTIVE",
      tier: "STARTER",
      limits: { activeCustomers: 1000, branches: 10, staff: 50, schemePlans: 20, whatsappMessages: 1000 },
    },
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
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    tenantId: tenant._id,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals.testSessionId = session._id;
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
