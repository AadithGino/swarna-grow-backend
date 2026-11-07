import argon2 from "argon2";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CustomerLoginMode,
  TenantRole,
  TenantStatus,
  UserStatus,
  UserType,
} from "../../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../../src/constants/permissions.js";
import { createId } from "../../src/lib/ids.js";
import { Branch, Customer, Session, Tenant, User } from "../../src/models/index.js";
import { signAccessToken } from "../../src/services/token.service.js";

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../evidence/remediation/phase1-browser-fixture.json",
);

export async function seedPhase1BrowserFixture() {
  const password = "1234";
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  async function seedTenant({ code, name, customerName, customerMobile }) {
    const tenant = await Tenant.create({
      _id: createId("tenant"),
      code,
      name,
      mobile: `+9197${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
      status: TenantStatus.ACTIVE,
      subscription: {
        status: "ACTIVE",
        tier: "STARTER",
        limits: { activeCustomers: 1000, branches: 10, staff: 50, schemePlans: 20, whatsappMessages: 1000 },
      },
      operations: {
        customerLoginMode: CustomerLoginMode.OTP_ONLY,
        customerAppWriteEnabled: true,
        customerAppPaymentsEnabled: true,
      },
    });
    const branch = await Branch.create({
      _id: createId("branch"),
      tenantId: tenant._id,
      code: "HQ",
      name: `${code} HQ`,
      isHeadOffice: true,
      active: true,
    });
    const customer = await Customer.create({
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerNumber: `C-${code}`,
      passbookNumber: `PB-${code}`,
      name: customerName,
      mobile: customerMobile,
      passwordHash,
    });
    const session = await Session.create({
      _id: createId("session"),
      customerId: customer._id,
      tenantId: tenant._id,
      deviceId: "phase1-browser",
      familyId: createId("family"),
      refreshTokenHash: createId("refresh"),
      platform: "web",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const accessToken = signAccessToken({
      id: customer._id,
      type: "CUSTOMER",
      tenantId: tenant._id,
      branchId: branch._id,
      role: "CUSTOMER",
      permissions: [],
      deviceId: "phase1-browser",
      securityVersion: 0,
      sessionId: session._id,
    });
    return {
      tenantId: String(tenant._id),
      tenantCode: code,
      tenantSlug: code.toLowerCase().replace(/_/g, "-"),
      tenantName: name,
      customerId: String(customer._id),
      customerName,
      customerMobile,
      accessToken,
      refreshToken: createId("refresh-token"),
    };
  }

  const tenantA = await seedTenant({
    code: "PHASE1A",
    name: "Phase1 Jewellers A",
    customerName: "Alice TenantA",
    customerMobile: "+919810000001",
  });
  const tenantB = await seedTenant({
    code: "PHASE1B",
    name: "Phase1 Jewellers B",
    customerName: "Bob TenantB",
    customerMobile: "+919810000002",
  });

  const fixture = {
    seededAt: new Date().toISOString(),
    otpCode: "123456",
    tenantA,
    tenantB,
  };
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  return fixture;
}

export async function seedPhase1EcommerceAdminRoles({ tenant, branchA, branchB: _branchB }) {
  async function staffUser({ role, branchId, mobile, name }) {
    const user = await User.create({
      _id: createId("user"),
      type: UserType.TENANT_USER,
      tenantId: tenant._id,
      branchId,
      role,
      name,
      mobile,
      passwordHash: await argon2.hash("1234", {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      }),
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
    user.$locals = { testSessionId: session._id };
    return user;
  }

  return {
    staffA: await staffUser({
      role: TenantRole.BRANCH_STAFF,
      branchId: branchA._id,
      mobile: "+919820000001",
      name: "Staff A",
    }),
    agentA: await staffUser({
      role: TenantRole.COLLECTION_AGENT,
      branchId: branchA._id,
      mobile: "+919820000002",
      name: "Agent A",
    }),
  };
}
