/**
 * Seeds one isolated tenant for ecommerce payment UI walkthrough (ECOPAYTEST).
 */
import argon2 from "argon2";
import { PlanTier, TenantRole, UserStatus, UserType } from "../../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../../src/constants/permissions.js";
import { createId } from "../../src/lib/ids.js";
import { Branch, Customer, Session, Tenant, User } from "../../src/models/index.js";
import { signAccessToken } from "../../src/services/token.service.js";
import { configureTenantPhonePe } from "../../tests/helpers/gateway-http-fixture.js";
import { runEcommerceDemoSeed } from "./ecommerce-demo-seed.js";

export const ECOPAY_TEST_TENANT_CODE = "ECOPAYTEST";
export const ECOPAY_TEST_TENANT_NAME = "Ecommerce Pay UI Test Jeweller";
export const ECOPAY_TEST_OWNER_MOBILE = "+919888877700";
export const ECOPAY_TEST_OWNER_PASSWORD = "1234";
export const ECOPAY_TEST_CUSTOMER_MOBILE = "+919888877701";
export const ECOPAY_TEST_CUSTOMER_OTP = "123456";

export async function seedEcommercePaymentTestUi() {
  const existing = await Tenant.findOne({ code: ECOPAY_TEST_TENANT_CODE });
  if (existing) {
    await Tenant.deleteOne({ _id: existing._id });
  }

  const tenant = await Tenant.create({
    _id: createId("tenant"),
    code: ECOPAY_TEST_TENANT_CODE,
    name: ECOPAY_TEST_TENANT_NAME,
    mobile: ECOPAY_TEST_OWNER_MOBILE,
    status: "ACTIVE",
    subscription: {
      status: "ACTIVE",
      tier: PlanTier.GROWTH,
      planFeaturesSnapshot: { ecommerce: true, ecommercePayments: true },
      limits: { activeCustomers: 5000, branches: 20, staff: 100, schemePlans: 50, whatsappMessages: 5000 },
    },
    operations: {
      ecommerceEnabled: true,
      ecommercePaymentsRolloutEnabled: true,
      customerAppPaymentsEnabled: true,
      customerAppWriteEnabled: true,
    },
  });

  const branch = await Branch.create({
    _id: createId("branch"),
    tenantId: tenant._id,
    code: "PAYHQ",
    name: "Pay UI Test HQ",
    isHeadOffice: true,
    active: true,
  });

  const owner = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.TENANT_OWNER,
    name: "Pay UI Owner",
    mobile: ECOPAY_TEST_OWNER_MOBILE,
    passwordHash: await argon2.hash(ECOPAY_TEST_OWNER_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_OWNER] ?? [],
  });

  await Session.create({
    _id: createId("session"),
    userId: owner._id,
    tenantId: tenant._id,
    deviceId: "pay-ui-admin",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000 * 7),
  });

  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "ECOPAY-CUST-1",
    name: "Pay UI Test Customer",
    mobile: ECOPAY_TEST_CUSTOMER_MOBILE,
  });

  await configureTenantPhonePe(tenant._id);

  const seedSummary = await runEcommerceDemoSeed({
    tenantCodes: [ECOPAY_TEST_TENANT_CODE],
    dryRun: false,
    dbLabel: "swarnagrow_ecommerce_pay_ui",
  });

  const customerSession = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "pay-ui-customer",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000 * 7),
  });

  const customerAccessToken = signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "pay-ui-customer",
    securityVersion: 0,
    sessionId: customerSession._id,
  });

  const acceptance = seedSummary.tenants.find((t) => t.tenantCode === ECOPAY_TEST_TENANT_CODE)?.acceptance;

  return {
    tenantCode: ECOPAY_TEST_TENANT_CODE,
    tenantSlug: ECOPAY_TEST_TENANT_CODE.toLowerCase(),
    tenantId: tenant._id,
    branchId: branch._id,
    owner: {
      mobile: ECOPAY_TEST_OWNER_MOBILE.replace(/^\+91/, ""),
      password: ECOPAY_TEST_OWNER_PASSWORD,
      tenantCode: ECOPAY_TEST_TENANT_CODE,
    },
    customer: {
      mobile: ECOPAY_TEST_CUSTOMER_MOBILE.replace(/^\+91/, ""),
      otp: ECOPAY_TEST_CUSTOMER_OTP,
      accessToken: customerAccessToken,
    },
    acceptance,
    seedSummary,
    isolationTag: "swarnagrow_ecommerce_pay_ui_memory",
  };
}
