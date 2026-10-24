import { randomUUID } from "node:crypto";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import test from "node:test";
import assert from "node:assert/strict";
import { PlanTier, TenantRole } from "../src/constants/enums.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { resolveDigitalMetalsCheckoutMode } from "../src/lib/digital-metals-demo-policy.js";
import {
  DigitalMetalBuyPaymentAttempt,
  DigitalMetalRedemptionChargeRefundCase,
  DigitalMetalRedemptionOrder,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  resetTestDb,
  seedBranch,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";

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

test("in-flight refund initiation does not call provider again", async () => {
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
    status: "REFUND_REVIEW",
    paymentExceptionStatus: "LATE_SUCCESS",
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
    exceptionType: "LATE_SUCCESS",
    status: "REFUND_INITIATED",
  });
  let providerCalls = 0;
  const original = phonePeProvider.initiateRefund.bind(phonePeProvider);
  phonePeProvider.initiateRefund = async () => {
    providerCalls += 1;
    return { refundId };
  };
  try {
    const { initiateAdminRedemptionChargeRefund } = await import(
      "../src/services/digital-metals-redemption-charge-refund.service.js"
    );
    const res = await initiateAdminRedemptionChargeRefund({
      auth: { id: owner._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
      params: { orderId },
    });
    assert.equal(res.initiated, false);
    assert.equal(res.inFlight, true);
    assert.equal(providerCalls, 0);
  } finally {
    phonePeProvider.initiateRefund = original;
  }
});

test("provider success callback cannot overwrite manual terminal refund", async () => {
  const { tenant, branch } = await seedTenantUser({});
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
    status: "MANUAL_RECORDED",
    resolvedAt: new Date(),
  });
  const { confirmRedemptionChargeRefundFromProvider } = await import(
    "../src/services/digital-metals-redemption-charge-refund.service.js"
  );
  const outcome = await confirmRedemptionChargeRefundFromProvider({
    tenantId: tenant._id,
    payload: { merchantRefundId: refundId, state: "COMPLETED" },
  });
  assert.equal(outcome.outcome, "ALREADY_TERMINAL");
  const row = await DigitalMetalRedemptionChargeRefundCase.findById(refundId).lean();
  assert.equal(row.status, "MANUAL_RECORDED");
});

test("reconcileRedemptionChargeRefundCase resolves in-flight refund from provider poll", async () => {
  const { tenant, branch } = await seedTenantUser({});
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
  const original = phonePeProvider.getRefundStatus.bind(phonePeProvider);
  phonePeProvider.getRefundStatus = async () => ({ state: "COMPLETED" });
  try {
    const { reconcileRedemptionChargeRefundCase } = await import(
      "../src/services/digital-metals-redemption-charge-refund.service.js"
    );
    const result = await reconcileRedemptionChargeRefundCase({
      tenantId: tenant._id,
      refundCaseId: refundId,
    });
    assert.equal(result.outcome, "SUCCEEDED");
    const row = await DigitalMetalRedemptionChargeRefundCase.findById(refundId).lean();
    assert.equal(row.status, "SUCCEEDED");
    const order = await DigitalMetalRedemptionOrder.findById(orderId).lean();
    assert.equal(order.status, "CHARGE_PAID");
    assert.equal(order.paymentExceptionStatus, "REFUNDED");
  } finally {
    phonePeProvider.getRefundStatus = original;
  }
});

test("additional capture refund on dispatched order preserves fulfilment status", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enablePlan(tenant._id);
  const orderId = createId("dmro");
  const refundId = createId("dmrref");
  await DigitalMetalRedemptionOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    branchId: branch._id,
    status: "DISPATCHED",
    paymentExceptionStatus: "ADDITIONAL_CAPTURE",
    ...redemptionOrderFields(),
  });
  await DigitalMetalRedemptionChargeRefundCase.create({
    _id: refundId,
    tenantId: tenant._id,
    redemptionOrderId: orderId,
    customerId: customer._id,
    paymentAttemptId: createId("dmrpay"),
    merchantOrderId: createId("dmrpay"),
    amountPaise: 50_00,
    exceptionType: "ADDITIONAL_CAPTURE",
    status: "ASSIGNED",
  });
  const { recordManualRedemptionChargeRefund } = await import(
    "../src/services/digital-metals-redemption-charge-refund.service.js"
  );
  await recordManualRedemptionChargeRefund({
    auth: { id: createId("user"), tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
    params: { refundCaseId: refundId },
    body: { resolutionNote: "Extra capture reversed", evidenceUploadIds: ["u1"] },
  });
  const order = await DigitalMetalRedemptionOrder.findById(orderId).lean();
  assert.equal(order.status, "DISPATCHED");
  assert.equal(order.paymentExceptionStatus, "REFUNDED");
});

test("buy payment attempt idempotency is customer-bound on duplicate key", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customerA = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+919900000301" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+919900000302" });
  const orderA = createId("dmbo");
  const orderB = createId("dmbo");
  const sharedKey = "shared-pay-idem";
  await DigitalMetalBuyPaymentAttempt.create({
    _id: createId("dmpay"),
    tenantId: tenant._id,
    orderId: orderA,
    customerId: customerA._id,
    status: "PENDING",
    amountPaise: 100_00,
    currency: "INR",
    provider: "PHONEPE",
    merchantOrderId: createId("dmpay"),
    idempotencyKey: sharedKey,
    redirectUrl: "https://example.com/return",
  });
  const { initiateDigitalMetalBuyPaymentAttempt } = await import(
    "../src/services/digital-metals-buy-payment.service.js"
  );
  await assert.rejects(
    () =>
      initiateDigitalMetalBuyPaymentAttempt({
        auth: { id: customerB._id, tenantId: tenant._id, type: "CUSTOMER" },
        params: { orderId: orderB },
        headers: { "x-idempotency-key": sharedKey },
        body: { redirectUrl: "https://example.com/return" },
      }),
    (err) => err.statusCode === 404,
  );
});

test("explicit live checkout mode selects LIVE_REQUIRED (never demo simulation)", () => {
  process.env.DIGITAL_METALS_CHECKOUT_MODE = "live";
  assert.equal(resolveDigitalMetalsCheckoutMode(), "LIVE_REQUIRED");
  process.env.DIGITAL_METALS_CHECKOUT_MODE = "demo";
  assert.equal(resolveDigitalMetalsCheckoutMode(), "DIGITAL_METALS_DEMO");
});

test("getAdminRedemptionOrderChargeRefund denies cross-branch manager", async () => {
  const { tenant, branch, user: manager } = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER });
  const branchB = await seedBranch({ tenantId: tenant._id, code: "BRX", name: "Branch X" });
  const customerB = await seedCustomer({ tenantId: tenant._id, branchId: branchB._id, mobile: "+919900000401" });
  await enablePlan(tenant._id);
  const orderId = createId("dmro");
  await DigitalMetalRedemptionOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customerB._id,
    branchId: branchB._id,
    status: "REFUND_REVIEW",
    ...redemptionOrderFields(),
  });
  const { getAdminRedemptionOrderChargeRefund } = await import(
    "../src/services/digital-metals-redemption-charge-refund.service.js"
  );
  await assert.rejects(
    () =>
      getAdminRedemptionOrderChargeRefund({
        auth: {
          id: manager._id,
          tenantId: tenant._id,
          type: "TENANT_USER",
          role: TenantRole.BRANCH_MANAGER,
          branchId: branch._id,
        },
        params: { orderId },
      }),
    (err) => err.statusCode === 403,
  );
});
