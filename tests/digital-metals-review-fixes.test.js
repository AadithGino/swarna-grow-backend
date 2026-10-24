import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier, TenantRole, UserStatus, UserType } from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import {
  DigitalMetalBankDestination,
  DigitalMetalPayable,
  DigitalMetalPhysicalOutEvent,
  DigitalMetalRedemptionChargeRefundCase,
  DigitalMetalRedemptionOrder,
  DigitalMetalSellOrder,
  Session,
  Tenant,
  User,
} from "../src/models/index.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { renderSellAcknowledgementPdf } from "../src/lib/digital-metals-document-pdf.js";
import {
  formatInrFromPaise,
  resolveSellSettlementPaise,
  sellAcknowledgementPdfRows,
} from "../src/lib/digital-metals-document-pdf-fields.js";
import {
  resolveDigitalMetalsCheckoutMode,
  assertPhonePeCredentialsForLiveCheckout,
} from "../src/lib/digital-metals-demo-policy.js";
import { isMockDigitalMetalsPaymentAttempt } from "../src/lib/digital-metals-checkout-init.js";
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

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  delete process.env.DIGITAL_METALS_CHECKOUT_MODE;
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

test("sell acknowledgement PDF uses settlementPaise (50000 → ₹500.00)", async () => {
  assert.equal(formatInrFromPaise(50_000), "₹500.00");
  assert.equal(resolveSellSettlementPaise({ settlementPaise: 50_000 }), 50_000);
  const order = {
    _id: "dmso_test_settlement",
    metal: "SILVER",
    finenessPpm: 999_000,
    quantityUg: "1000000",
    settlementPaise: 50_000,
    status: "PAYABLE_OPEN",
    executedAt: new Date("2026-10-01T10:00:00.000Z"),
    snapshot: { rateSnapshot: { sellRatePerGramPaise: 50_000 } },
  };
  const rows = sellAcknowledgementPdfRows(order);
  const netRow = rows.find(([label]) => label.startsWith("Net settlement"));
  assert.ok(netRow);
  assert.equal(netRow[1], "₹500.00");
  await renderSellAcknowledgementPdf({ order, documentNumber: "SLA-2026-000001" });
});

async function branchManagerFor(tenantId, branchId) {
  const user = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId,
    branchId,
    role: TenantRole.BRANCH_MANAGER,
    name: "Branch Manager",
    mobile: "+919811122233",
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

test("branch manager sees only own-branch digital-metal sell orders and PDFs", async () => {
  const { tenant, branch: branchA, user: owner } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const branchB = await seedBranch({ tenantId: tenant._id, code: "BRB", name: "Branch B" });
  const managerA = await branchManagerFor(tenant._id, branchA._id);
  const customerA = await seedCustomer({ tenantId: tenant._id, branchId: branchA._id, mobile: "+919900000001" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919900000002" });
  await enablePlan(tenant._id);

  const sellA = createId("dmso");
  const sellB = createId("dmso");
  const sellFields = () => ({
    status: "PAYABLE_OPEN",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: "1000000",
    quoteId: createId("dmrq"),
    reservationId: createId("dmrs"),
    idempotencyKey: randomUUID(),
    quoteExpiresAt: new Date(Date.now() + 86_400_000),
    termsAcceptedAt: new Date(),
    bankDestinationId: createId("dmbd"),
  });
  await DigitalMetalSellOrder.create({
    ...sellFields(),
    _id: sellA,
    tenantId: tenant._id,
    customerId: customerA._id,
    branchId: branchA._id,
    settlementPaise: 50_000,
  });
  await DigitalMetalSellOrder.create({
    ...sellFields(),
    _id: sellB,
    tenantId: tenant._id,
    customerId: customerB._id,
    branchId: branchB._id,
    settlementPaise: 60_000,
  });

  const managerToken = `Bearer ${bearerFor(managerA, ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER])}`;
  const ownerToken = `Bearer ${bearerFor(owner, ROLE_PERMISSIONS[TenantRole.TENANT_OWNER])}`;

  const mgrList = await request(app)
    .get("/api/v1/admin/digital-metals/sell-orders")
    .set("Authorization", managerToken);
  assert.equal(mgrList.status, 200);
  const mgrIds = (mgrList.body.data.items ?? []).map((r) => r.id);
  assert.ok(mgrIds.includes(sellA));
  assert.ok(!mgrIds.includes(sellB));

  const mgrOtherDetail = await request(app)
    .get(`/api/v1/admin/digital-metals/sell-orders/${sellB}`)
    .set("Authorization", managerToken);
  assert.equal(mgrOtherDetail.status, 403);

  const mgrBypass = await request(app)
    .get("/api/v1/admin/digital-metals/sell-orders")
    .query({ customerId: customerB._id })
    .set("Authorization", managerToken);
  assert.equal(mgrBypass.status, 403);

  const ownerList = await request(app)
    .get("/api/v1/admin/digital-metals/sell-orders")
    .set("Authorization", ownerToken);
  assert.equal(ownerList.status, 200);
  const ownerIds = (ownerList.body.data.items ?? []).map((r) => r.id);
  assert.ok(ownerIds.includes(sellA));
  assert.ok(ownerIds.includes(sellB));
});

test("admin redemption PDF denied for other-branch order", async () => {
  const { tenant, user: manager } = await seedTenantUser({
    role: TenantRole.BRANCH_MANAGER,
  });
  const branchB = await seedBranch({ tenantId: tenant._id });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id });
  await enablePlan(tenant._id);
  const orderB = createId("dmro");
  await DigitalMetalRedemptionOrder.create({
    _id: orderB,
    tenantId: tenant._id,
    customerId: customerB._id,
    branchId: branchB._id,
    quoteId: createId("dmrq"),
    catalogueItemId: createId("dmrc"),
    catalogueVersion: 1,
    reservationId: createId("dmrs"),
    status: "CHARGE_PAID",
    metal: "SILVER",
    finenessPpm: 999_000,
    quantityUg: "10000000",
    unitCount: 1,
    chargeTotalPaise: 1_490_000,
    snapshot: { packagingPaise: 0, mintingPaise: 1_490_000, deliveryPaise: 0, taxLines: [] },
    fulfilmentMode: "PICKUP",
    idempotencyKey: randomUUID(),
    quoteExpiresAt: new Date(Date.now() + 86_400_000),
    chargePaymentExpiresAt: new Date(Date.now() + 86_400_000),
    termsAcceptedAt: new Date(),
    version: 1,
  });
  const token = `Bearer ${bearerFor(manager, ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER])}`;
  const res = await request(app)
    .get(`/api/v1/admin/digital-metals/redemption/orders/${orderB}/charge-receipt.pdf`)
    .set("Authorization", token);
  assert.equal(res.status, 403);
});

test("bank list GET is read-only (pending stays pending)", async () => {
  const seeded = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const { tenant, branch } = seeded;
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const destId = createId("dmbd");
  await DigitalMetalBankDestination.create({
    _id: destId,
    tenantId: tenant._id,
    customerId: customer._id,
    accountHolderName: "Test User",
    accountNumberSealed: "plain-for-test",
    accountLast4: "1234",
    ifsc: "HDFC0001234",
    status: "PENDING_VERIFICATION",
  });
  const { signAccessToken } = await import("../src/services/token.service.js");
  const { Session } = await import("../src/models/index.js");
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "c",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const customerToken = `Bearer ${signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "c",
    securityVersion: 0,
    sessionId: session._id,
  })}`;
  await request(app)
    .get("/api/v1/app/digital-metals/bank-destinations")
    .set("Authorization", customerToken);
  const row = await DigitalMetalBankDestination.findById(destId).lean();
  assert.equal(row.status, "PENDING_VERIFICATION");
});

test("admin payables list returns cursor pagination meta", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enablePlan(tenant._id);
  for (let i = 0; i < 3; i += 1) {
    await DigitalMetalPayable.create({
      _id: createId("dmpaybl"),
      tenantId: tenant._id,
      customerId: customer._id,
      sellOrderId: createId("dmso"),
      amountPaise: 100_00 + i,
      outstandingPaise: 100_00 + i,
      status: "OPEN",
    });
  }
  const ownerToken = `Bearer ${bearerFor(user, ROLE_PERMISSIONS[TenantRole.TENANT_OWNER])}`;
  const page1 = await request(app)
    .get("/api/v1/admin/digital-metals/payables")
    .set("Authorization", ownerToken)
    .query({ limit: 2 });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.items.length, 2);
  assert.equal(page1.body.data.meta.hasMore, true);
  assert.ok(page1.body.data.meta.nextCursor);
  const page2 = await request(app)
    .get("/api/v1/admin/digital-metals/payables")
    .set("Authorization", ownerToken)
    .query({ limit: 2, cursor: page1.body.data.meta.nextCursor });
  assert.equal(page2.status, 200);
  assert.equal(page2.body.data.items.length, 1);
  assert.equal(page2.body.data.meta.hasMore, false);
});

test("unknown checkout mode is rejected; demo and mock modes resolve explicitly", () => {
  process.env.PROVIDER_MODE = "live";
  process.env.DIGITAL_METALS_CHECKOUT_MODE = "not-a-mode";
  assert.throws(
    () => resolveDigitalMetalsCheckoutMode(),
    (err) => err.code === "CHECKOUT_MODE_INVALID",
  );
  process.env.DIGITAL_METALS_CHECKOUT_MODE = "demo";
  assert.equal(resolveDigitalMetalsCheckoutMode(), "DIGITAL_METALS_DEMO");
  process.env.DIGITAL_METALS_CHECKOUT_MODE = "mock";
  assert.equal(resolveDigitalMetalsCheckoutMode(), "MOCK_PROVIDER");
});

test("live checkout policy rejects missing credentials; mock attempts require persisted checkoutMode", () => {
  process.env.PROVIDER_MODE = "live";
  process.env.DIGITAL_METALS_CHECKOUT_MODE = "live";
  assert.equal(resolveDigitalMetalsCheckoutMode(), "LIVE_REQUIRED");
  assert.throws(
    () => assertPhonePeCredentialsForLiveCheckout({}),
    (err) => err.code === "PHONEPE_NOT_CONFIGURED",
  );
  assert.equal(
    isMockDigitalMetalsPaymentAttempt({
      status: "INITIATED",
      checkoutMode: "LIVE",
      providerOrderId: "mock_x",
      sdkToken: "mock-token-x",
      
    }),
    false,
  );
  assert.equal(
    isMockDigitalMetalsPaymentAttempt({
      status: "INITIATED",
      checkoutMode: "DIGITAL_METALS_DEMO",
    }),
    true,
  );
});

function redemptionOrderFields(overrides = {}) {
  return {
    quoteId: createId("dmrq"),
    catalogueItemId: createId("dmrc"),
    catalogueVersion: 1,
    reservationId: createId("dmrs"),
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: "2000000",
    unitCount: 1,
    chargeTotalPaise: 100_00,
    snapshot: { packagingPaise: 0, mintingPaise: 100_00, deliveryPaise: 0, taxLines: [] },
    fulfilmentMode: "DELIVERY",
    idempotencyKey: randomUUID(),
    quoteExpiresAt: new Date(Date.now() + 86_400_000),
    chargePaymentExpiresAt: new Date(Date.now() + 86_400_000),
    termsAcceptedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

test("physical-out idempotency replay enforces admin branch scope", async () => {
  const { tenant, branch, user: manager } = await seedTenantUser({
    role: TenantRole.BRANCH_MANAGER,
  });
  assert.equal(String(manager.branchId), String(branch._id));
  const branchB = await seedBranch({ tenantId: tenant._id, code: "BRB2", name: "Branch B" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919900000088" });
  await enablePlan(tenant._id);
  const orderId = createId("dmro");
  const idem = randomUUID();
  await DigitalMetalRedemptionOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customerB._id,
    branchId: branchB._id,
    status: "COMPLETED",
    completedAt: new Date(),
    ...redemptionOrderFields(),
  });
  await DigitalMetalPhysicalOutEvent.create({
    _id: createId("dmphy"),
    tenantId: tenant._id,
    redemptionOrderId: orderId,
    customerId: customerB._id,
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: 2_000_000,
    reservationId: createId("dmrs"),
    businessDate: "2026-10-01",
    fulfilmentMode: "DELIVERY",
    idempotencyKey: idem,
  });
  const managerToken = `Bearer ${bearerFor(manager, ROLE_PERMISSIONS[TenantRole.BRANCH_MANAGER])}`;
  const res = await request(app)
    .post(`/api/v1/admin/digital-metals/redemption/orders/${orderId}/fulfilment/complete-delivery`)
    .set("Authorization", managerToken)
    .set("X-Idempotency-Key", idem)
    .send({ expectedVersion: 1, approverAttestation: true, evidenceUploadIds: ["u1"] });
  assert.equal(res.status, 403);
});

test("additional capture refund resolution keeps charge-paid fulfilment order", async () => {
  const { tenant, branch, user: owner } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enablePlan(tenant._id);
  const orderId = createId("dmro");
  const refundId = createId("dmrref");
  await DigitalMetalRedemptionOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    branchId: branch._id,
    status: "CHARGE_PAID",
    paymentExceptionStatus: "ADDITIONAL_CAPTURE",
    successfulChargeAttemptId: createId("dmrpay"),
    ...redemptionOrderFields(),
  });
  await DigitalMetalRedemptionChargeRefundCase.create({
    _id: refundId,
    tenantId: tenant._id,
    redemptionOrderId: orderId,
    customerId: customer._id,
    paymentAttemptId: createId("dmrpay"),
    merchantOrderId: createId("dmrpay"),
    amountPaise: 100_00,
    exceptionType: "ADDITIONAL_CAPTURE",
    status: "REFUND_INITIATED",
  });
  const { confirmRedemptionChargeRefundFromProvider, recordManualRedemptionChargeRefund } = await import(
    "../src/services/digital-metals-redemption-charge-refund.service.js"
  );
  const provider = await confirmRedemptionChargeRefundFromProvider({
    tenantId: tenant._id,
    payload: { merchantRefundId: refundId, state: "COMPLETED" },
  });
  assert.equal(provider.outcome, "SUCCEEDED");
  let order = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  assert.equal(order.status, "CHARGE_PAID");
  assert.equal(order.paymentExceptionStatus, "REFUNDED");

  const orderId2 = createId("dmro");
  const refundId2 = createId("dmrref");
  await DigitalMetalRedemptionOrder.create({
    _id: orderId2,
    tenantId: tenant._id,
    customerId: customer._id,
    branchId: branch._id,
    status: "CHARGE_PAID",
    paymentExceptionStatus: "ADDITIONAL_CAPTURE",
    successfulChargeAttemptId: createId("dmrpay"),
    ...redemptionOrderFields({ idempotencyKey: randomUUID() }),
  });
  await DigitalMetalRedemptionChargeRefundCase.create({
    _id: refundId2,
    tenantId: tenant._id,
    redemptionOrderId: orderId2,
    customerId: customer._id,
    paymentAttemptId: createId("dmrpay"),
    merchantOrderId: createId("dmrpay"),
    amountPaise: 100_00,
    exceptionType: "ADDITIONAL_CAPTURE",
    status: "ASSIGNED",
  });
  const manual = await recordManualRedemptionChargeRefund({
    auth: { id: owner._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
    params: { refundCaseId: refundId2 },
    body: { resolutionNote: "NEFT reversal", evidenceUploadIds: ["upl_1"] },
  });
  assert.equal(manual.refund.status, "MANUAL_RECORDED");
  order = await DigitalMetalRedemptionOrder.findById(orderId2).lean();
  assert.equal(order.status, "CHARGE_PAID");
  assert.equal(order.paymentExceptionStatus, "REFUNDED");
});

test("redemption charge refund initiation respects branch scope and ambiguous provider errors", async () => {
  const { tenant, branch: branchA, user: manager } = await seedTenantUser({
    role: TenantRole.BRANCH_MANAGER,
  });
  const branchB = await seedBranch({ tenantId: tenant._id, code: "BRB3", name: "Branch B" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919900000077" });
  await enablePlan(tenant._id);
  const orderId = createId("dmro");
  const refundId = createId("dmrref");
  await DigitalMetalRedemptionOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customerB._id,
    branchId: branchB._id,
    status: "REFUND_REVIEW",
    paymentExceptionStatus: "LATE_SUCCESS",
    ...redemptionOrderFields(),
  });
  await DigitalMetalRedemptionChargeRefundCase.create({
    _id: refundId,
    tenantId: tenant._id,
    redemptionOrderId: orderId,
    customerId: customerB._id,
    paymentAttemptId: createId("dmrpay"),
    merchantOrderId: createId("dmrpay"),
    amountPaise: 100_00,
    exceptionType: "LATE_SUCCESS",
    status: "ASSIGNED",
  });
  const { initiateAdminRedemptionChargeRefund } = await import(
    "../src/services/digital-metals-redemption-charge-refund.service.js"
  );
  await assert.rejects(
    () =>
      initiateAdminRedemptionChargeRefund({
        auth: {
          id: manager._id,
          tenantId: tenant._id,
          type: "TENANT_USER",
          role: TenantRole.BRANCH_MANAGER,
          branchId: branchA._id,
        },
        params: { orderId },
      }),
    (err) => err.statusCode === 403,
  );

  const { tenant: tenant2, branch, user: owner } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant2._id, branchId: branch._id });
  await enablePlan(tenant2._id);
  const { configureTenantPhonePe } = await import("./helpers/gateway-http-fixture.js");
  await configureTenantPhonePe(tenant2._id);
  const orderId2 = createId("dmro");
  const refundId2 = createId("dmrref");
  await DigitalMetalRedemptionOrder.create({
    _id: orderId2,
    tenantId: tenant2._id,
    customerId: customer._id,
    branchId: branch._id,
    status: "REFUND_REVIEW",
    paymentExceptionStatus: "LATE_SUCCESS",
    ...redemptionOrderFields({ idempotencyKey: randomUUID() }),
  });
  await DigitalMetalRedemptionChargeRefundCase.create({
    _id: refundId2,
    tenantId: tenant2._id,
    redemptionOrderId: orderId2,
    customerId: customer._id,
    paymentAttemptId: createId("dmrpay"),
    merchantOrderId: createId("dmrpay"),
    amountPaise: 100_00,
    exceptionType: "LATE_SUCCESS",
    status: "ASSIGNED",
  });
  const original = phonePeProvider.initiateRefund.bind(phonePeProvider);
  phonePeProvider.initiateRefund = async () => {
    const err = new Error("network timeout");
    err.code = "ETIMEDOUT";
    throw err;
  };
  try {
    await assert.rejects(
      () =>
        initiateAdminRedemptionChargeRefund({
          auth: { id: owner._id, tenantId: tenant2._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
          params: { orderId: orderId2 },
        }),
      (err) => err.code === "REFUND_INITIATION_FAILED",
    );
    const row = await DigitalMetalRedemptionChargeRefundCase.findById(refundId2).lean();
    assert.equal(row.status, "REFUND_INITIATED");
  } finally {
    phonePeProvider.initiateRefund = original;
  }
});
