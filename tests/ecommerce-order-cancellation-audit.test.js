import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceCancellationStockDisposition,
  EcommerceOrderCancellationRequestStatus,
  EcommerceOrderRefundSource,
  EcommerceOrderStatus,
  EcommercePaymentExceptionRefundStatus,
  TenantRole,
} from "../src/constants/enums.js";
import { Permission } from "../src/constants/permissions.js";
import {
  EcommerceInventory,
  EcommerceInventoryAdjustment,
  EcommerceOrder,
  EcommerceOrderCancellationRequest,
  EcommercePaymentExceptionRefund,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { enableEcommercePaymentsTestHarness } from "./helpers/ecommerce-checkout-fixtures.js";
import {
  postCompletedWebhookHttp,
  quoteAndOrder,
  seedReady,
} from "./helpers/ecommerce-payment-test-flow.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.describe("ecommerce order cancellation audit", () => {
  test.beforeEach(async () => {
    await resetTestDb();
    enableEcommercePaymentsTestHarness();
  });

function staffHeaders(user, permissions = ROLE_PERMISSIONS[TenantRole.TENANT_ADMIN]) {
  return {
    authorization: `Bearer ${bearerFor(user, permissions)}`,
    "x-idempotency-key": createId("idem"),
  };
}

async function paidOnlineOrder({ tenant, user, branch }) {
  const { product, adminHeaders } = await seedReady({ tenant, user, branch, app, qty: 10 });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { token, orderId, totalPaise, productId } = await quoteAndOrder({
    tenant,
    branch,
    product,
    customer,
    app,
  });
  const invBefore = await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean();
  const created = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/payment-intents`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("pay") })
    .send({ redirectUrl: "https://example.com/return" });
  await postCompletedWebhookHttp({
    app,
    tenantId: tenant._id,
    merchantOrderId: created.body.data.paymentIntent.merchantOrderId,
    amountPaise: totalPaise,
  });
  const paid = await EcommerceOrder.findById(orderId).lean();
  assert.equal(paid.status, EcommerceOrderStatus.PAID);
  assert.ok(paid.stockConsumedAt);
  assert.equal(invBefore.quantityOnHand - 1, (await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean()).quantityOnHand);
  return { token, orderId, totalPaise, productId, product, customer, adminHeaders };
}

test("PAID online approval requires stock disposition and restocks once", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { token, orderId, productId } = await paidOnlineOrder({ tenant, user, branch });

  const req = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("creq") })
    .send({ reason: "Please cancel this paid order" });
  assert.ok(req.status === 200 || req.status === 201);

  const noDisp = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cancellation/decision`)
    .set(staffHeaders(user))
    .send({ decision: "APPROVE", expectedVersion: req.body.data.request.version });
  assert.equal(noDisp.status, 400);

  const onHandBeforeRestock = (await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean())
    .quantityOnHand;
  const approve = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cancellation/decision`)
    .set(staffHeaders(user))
    .send({
      decision: "APPROVE",
      expectedVersion: req.body.data.request.version,
      stockDisposition: EcommerceCancellationStockDisposition.RESTOCK_CONFIRMED,
    });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.data.refundCaseCreated, true);
  assert.equal(approve.body.data.refundInitiationRequired, true);

  const after = await EcommerceOrder.findById(orderId).lean();
  assert.equal(after.status, EcommerceOrderStatus.REFUND_PENDING);
  assert.ok(after.stockRestockedAt);
  const onHandAfter = (await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean()).quantityOnHand;
  assert.equal(onHandAfter, onHandBeforeRestock + 1);
  const adjCount = await EcommerceInventoryAdjustment.countDocuments({ tenantId: tenant._id, productId });
  assert.equal(adjCount, 1);

  const approveAgain = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cancellation/decision`)
    .set(staffHeaders(user))
    .send({
      decision: "APPROVE",
      expectedVersion: 99,
      stockDisposition: EcommerceCancellationStockDisposition.RESTOCK_CONFIRMED,
    });
  assert.ok(approveAgain.status >= 400);
  assert.equal(
    (await EcommerceInventoryAdjustment.countDocuments({ tenantId: tenant._id, productId })),
    1,
  );
});

test("fulfilment-only staff cannot initiate provider refund on cancellation case", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { orderId, token } = await paidOnlineOrder({ tenant, user, branch });
  const req = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("creq") })
    .send({ reason: "Cancel after payment please" });
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cancellation/decision`)
    .set(staffHeaders(user))
    .send({
      decision: "APPROVE",
      expectedVersion: req.body.data.request.version,
      stockDisposition: EcommerceCancellationStockDisposition.STOCK_EXCEPTION,
    });

  let initiateCalls = 0;
  const original = phonePeProvider.initiateRefund?.bind(phonePeProvider);
  if (original) {
    phonePeProvider.initiateRefund = async (...args) => {
      initiateCalls += 1;
      return original(...args);
    };
  }

  const fulfilmentOnly = [
    Permission.ECOMMERCE_READ,
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
  ];
  const blocked = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/payment-exception-refund/initiate`)
    .set(staffHeaders(user, fulfilmentOnly));
  assert.equal(blocked.status, 403);
  assert.equal(initiateCalls, 0);

  const refundOp = [
    Permission.ECOMMERCE_READ,
    Permission.ECOMMERCE_REFUND_OPERATE,
  ];
  const allowed = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/payment-exception-refund/initiate`)
    .set(staffHeaders(user, refundOp));
  assert.ok(allowed.status === 200 || allowed.status === 422);
  if (original) phonePeProvider.initiateRefund = original;
});

test("manual online refund completes cancellation request", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const { orderId, token, totalPaise } = await paidOnlineOrder({ tenant, user, branch });
  const req = await request(app)
    .post(`/api/v1/app/shop/orders/${orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token}`, "x-idempotency-key": createId("creq") })
    .send({ reason: "Manual refund path test order" });
  await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/cancellation/decision`)
    .set(staffHeaders(user))
    .send({
      decision: "APPROVE",
      expectedVersion: req.body.data.request.version,
      stockDisposition: EcommerceCancellationStockDisposition.STOCK_EXCEPTION,
    });

  const manual = await request(app)
    .post(`/api/v1/admin/ecommerce/orders/${orderId}/payment-exception-refund/record-manual`)
    .set(staffHeaders(user, [Permission.ECOMMERCE_READ, Permission.ECOMMERCE_REFUND_OPERATE]))
    .send({
      providerRefundReference: "BANK-REF-12345678",
      reason: "Verified bank transfer to customer",
      evidenceNote: "UTR screenshot attached in ops folder",
    });
  assert.equal(manual.status, 200);
  const order = await EcommerceOrder.findById(orderId).lean();
  assert.equal(order.status, EcommerceOrderStatus.REFUNDED);
  const refund = await EcommercePaymentExceptionRefund.findOne({ orderId }).lean();
  assert.equal(refund.status, EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED);
  assert.equal(refund.refundSource, EcommerceOrderRefundSource.ORDER_CANCELLATION);
  const cancelReq = await EcommerceOrderCancellationRequest.findOne({ orderId }).lean();
  assert.equal(cancelReq.status, EcommerceOrderCancellationRequestStatus.COMPLETED);
  assert.equal(cancelReq.onlineRefundId, refund._id);
  assert.equal(Number(refund.amountPaise), totalPaise);
});

test("cancellation idempotency key cannot replay across orders", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const a = await paidOnlineOrder({ tenant, user, branch });
  const customer2 = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+918811122233",
  });
  const b = await quoteAndOrder({ tenant, branch, product: a.product, customer: customer2, app });
  const key = createId("shared-key");
  const body = { reason: "Same key different orders test" };
  const first = await request(app)
    .post(`/api/v1/app/shop/orders/${a.orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${a.token}`, "x-idempotency-key": key })
    .send(body);
  assert.ok(first.status === 200 || first.status === 201);
  const token2 = b.token;
  const second = await request(app)
    .post(`/api/v1/app/shop/orders/${b.orderId}/cancellation-requests`)
    .set({ authorization: `Bearer ${token2}`, "x-idempotency-key": key })
    .send(body);
  assert.equal(second.status, 409);
  assert.equal(second.body.error?.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(await EcommerceOrderCancellationRequest.countDocuments({ idempotencyKey: key }), 1);
});
});
