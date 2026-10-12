import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  BillingCycle,
  EcommerceFulfilmentMode,
  EcommercePriceMode,
  EcommerceStockPolicy,
  PlanTier,
} from "../src/constants/enums.js";
import { DEFAULT_PLAN_FEATURES } from "../src/constants/plan-features.js";
import { attachSubscriptionCatalogPlan } from "../src/lib/subscription-plan-for-tenant.js";
import { tenantForEcommerceCheckout } from "../src/lib/ecommerce-checkout-tenant.js";
import { isPlanFeatureEnabled } from "../src/lib/feature-entitlements.js";
import { Branch, Session, SubscriptionPlan, Tenant, User } from "../src/models/index.js";
import { TenantRole, UserStatus, UserType } from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import argon2 from "argon2";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { loadPaymentCapability } from "../src/services/ecommerce-payment-intent.service.js";
import {
  disableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";
import { bearerFor, resetTestDb, seedCustomer, startTestDb, stopTestDb } from "./helpers/db.js";
import { configureTenantPhonePe } from "./helpers/gateway-http-fixture.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  disableEcommercePaymentsTestHarness();
});

async function customerToken({ tenant, branch, customer }) {
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "dev",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const { signAccessToken } = await import("../src/services/token.service.js");
  return signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "dev",
    securityVersion: 0,
    sessionId: session._id,
  });
}

/** Mirrors KAIRALI: store on, ecommerce entitlement only via live subscription catalog plan (no snapshot). */
async function seedCatalogEntitledStoreTenant({ payments = false } = {}) {
  const planId = createId("subscription");
  await SubscriptionPlan.create({
    _id: planId,
    tier: PlanTier.GROWTH,
    name: "Growth catalog",
    billingCycle: BillingCycle.MONTHLY,
    active: true,
    features: { ...DEFAULT_PLAN_FEATURES[PlanTier.GROWTH], ecommerce: true, ecommercePayments: payments },
  });
  const tenantId = createId("tenant");
  const branch = await Branch.create({
    _id: createId("branch"),
    tenantId,
    code: "HQ",
    name: "HQ",
    isHeadOffice: true,
    active: true,
  });
  const tenant = await Tenant.create({
    _id: tenantId,
    code: "CATSTORE",
    name: "Catalog store tenant",
    mobile: "+919877766655",
    subscription: {
      tier: PlanTier.GROWTH,
      planId,
      features: [],
      planFeaturesSnapshot: null,
      status: "ACTIVE",
    },
    operations: {
      ecommerceEnabled: true,
      ecommercePaymentsRolloutEnabled: payments,
      customerAppPaymentsEnabled: true,
    },
    status: "ACTIVE",
  });
  const user = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId,
    branchId: branch._id,
    role: TenantRole.TENANT_OWNER,
    name: "Owner",
    mobile: "+919877766656",
    passwordHash: await argon2.hash("1234", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_OWNER] ?? [],
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    tenantId,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals = { testSessionId: session._id };
  return { tenant, branch, user };
}

test("GET quote does not report store/plan blockers when entitlement is catalog-only (development payment gates remain)", async () => {
  const { tenant, branch, user } = await seedCatalogEntitledStoreTenant();
  const tenantWithCatalog = await attachSubscriptionCatalogPlan(tenant.toObject());
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await ecommerce.putTaxSettings({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: tenantWithCatalog,
    body: taxReadyCatalogBody(),
  });
  const adminHeaders = {
    authorization: `Bearer ${bearerFor(user)}`,
    "x-idempotency-key": createId("idem"),
  };
  const fulfilRes = await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set(adminHeaders)
    .send(taxReadyFulfilmentBody(branch._id));
  assert.equal(fulfilRes.status, 200, JSON.stringify(fulfilRes.body));
  const product = await ecommerce.createProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: tenantWithCatalog,
    body: {
      name: "Catalog ring",
      slug: `ring-${createId("p").slice(-4)}`,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 50_000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    auth: { tenantId: tenant._id, id: user._id },
    tenant: tenantWithCatalog,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set(adminHeaders)
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 5 });

  const token = await customerToken({ tenant, branch, customer });
  await request(app)
    .put("/api/v1/app/shop/cart")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("c") })
    .send({ lines: [{ productId: product.id, quantity: 1 }] });
  const quoteRes = await request(app)
    .post("/api/v1/app/shop/quotes")
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("q") })
    .send({
      fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
      pickupBranchId: branch._id,
    });
  assert.equal(quoteRes.status, 201, JSON.stringify(quoteRes.body));
  const codes = (quoteRes.body.data.blockers ?? []).map((b) => b.code);
  assert.equal(codes.includes("STORE_NOT_OPERATIONAL"), false);
  assert.equal(codes.includes("PLAN_ECOMMERCE_DISABLED"), false);
  assert.equal(quoteRes.body.data.checkoutTaxReady, true);
  assert.equal(quoteRes.body.data.paymentAllowed, false);
  assert.equal(codes.includes("PLAN_ECOMMERCE_PAYMENTS_DISABLED"), true);

  const getRes = await request(app)
    .get(`/api/v1/app/shop/quotes/${quoteRes.body.data.id}`)
    .set({
      authorization: `Bearer ${token}`,
      "x-swarna-client-api-base": "http://127.0.0.1:4000/api/v1",
    });
  assert.equal(getRes.status, 200);
  const getCodes = (getRes.body.data.blockers ?? []).map((b) => b.code);
  assert.equal(getCodes.includes("STORE_NOT_OPERATIONAL"), false);
  assert.equal(getCodes.includes("PLAN_ECOMMERCE_DISABLED"), false);
});

test("payment intent preserves catalog-only payment entitlement when loading gateway secrets", async () => {
  const { tenant } = await seedCatalogEntitledStoreTenant({ payments: true });
  await configureTenantPhonePe(tenant._id);
  const withCatalog = await attachSubscriptionCatalogPlan(tenant.toObject());
  const checkoutTenant = await tenantForEcommerceCheckout(tenant._id, withCatalog);
  assert.equal(isPlanFeatureEnabled(checkoutTenant, "ecommercePayments"), true);
  assert.ok(checkoutTenant.integrationSecrets?.phonepe);

  const capability = await loadPaymentCapability(tenant._id, withCatalog);
  const codes = capability.blockers.map((blocker) => blocker.code);
  assert.equal(codes.includes("STORE_NOT_OPERATIONAL"), false);
  assert.equal(codes.includes("PLAN_ECOMMERCE_DISABLED"), false);
  assert.equal(codes.includes("PLAN_ECOMMERCE_PAYMENTS_DISABLED"), false);
  assert.equal(codes.includes("PAYMENT_GATEWAY_NOT_CONFIGURED"), false);
  assert.equal(codes.includes("ECOMMERCE_PAYMENTS_ROLLOUT_OFF"), true);
});
