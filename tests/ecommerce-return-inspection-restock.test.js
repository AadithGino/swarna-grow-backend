import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import {
  EcommerceOrderReturnRequestStatus,
  EcommerceOrderStatus,
  EcommercePaymentAttemptStatus,
  EcommercePaymentMethod,
  EcommerceStockPolicy,
} from "../src/constants/enums.js";
import {
  EcommerceFulfilmentSettings,
  EcommerceInventory,
  EcommerceOrder,
  EcommerceOrderReturnRequest,
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
} from "../src/models/index.js";
import * as returnSvc from "../src/services/ecommerce-order-return.service.js";
import { taxReadyStorePolicies } from "./helpers/ecommerce-checkout-fixtures.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedDeliveredReturnOrder({ paymentMethod = EcommercePaymentMethod.ONLINE } = {}) {
  const { tenant, user, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const productId = createId("eprd");
  const orderId = createId("eord");
  const paymentAttemptId = createId("epay");
  await EcommerceFulfilmentSettings.create({
    _id: createId("efset"),
    tenantId: tenant._id,
    version: 1,
    storePolicies: taxReadyStorePolicies(),
  });
  await EcommerceInventory.create({
    _id: createId("einv"),
    tenantId: tenant._id,
    productId,
    stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED,
    quantityOnHand: 2,
    version: 1,
  });
  await EcommerceOrder.create({
    _id: orderId,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-RET-1",
    status: EcommerceOrderStatus.DELIVERED,
    paymentMethod,
    successfulPaymentAttemptId: paymentMethod === EcommercePaymentMethod.ONLINE ? paymentAttemptId : undefined,
    totalPaise: 50_000,
    version: 1,
    deliveryTracking: { deliveredAt: new Date() },
    stockConsumptionEvidence: [
      { productId, quantityDeducted: 1, stockPolicyAtConsumption: EcommerceStockPolicy.QUANTITY_TRACKED },
    ],
    lines: [{ productId, quantity: 1 }],
  });
  if (paymentMethod === EcommercePaymentMethod.ONLINE) {
    await EcommercePaymentAttempt.create({
      _id: paymentAttemptId,
      tenantId: tenant._id,
      orderId,
      customerId: customer._id,
      status: EcommercePaymentAttemptStatus.SUCCEEDED,
      amountPaise: 50_000,
      currency: "INR",
      version: 1,
    });
  }
  const returnId = createId("eret");
  await EcommerceOrderReturnRequest.create({
    _id: returnId,
    tenantId: tenant._id,
    orderId,
    customerId: customer._id,
    kind: "RETURN",
    status: EcommerceOrderReturnRequestStatus.APPROVED,
    reason: "Item not as described for test",
    version: 1,
    statusHistory: [],
  });
  const admin = (extra) => ({
    auth: { tenantId: tenant._id, id: user._id },
    params: { returnRequestId: returnId, orderId },
    body: {},
    headers: {},
    ...extra,
  });
  return { tenant, user, branch, customer, orderId, returnId, productId, admin };
}

test("physical receipt does not restock inventory", async () => {
  const { productId, tenant, admin } = await seedDeliveredReturnOrder();
  const before = (await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean()).quantityOnHand;
  await returnSvc.recordAdminReturnReceived(
    admin({ body: { expectedVersion: 1, receiptNote: "Parcel arrived intact" } }),
  );
  const after = (await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean()).quantityOnHand;
  assert.equal(after, before);
});

test("inspection approve restocks once; retry is idempotent", async () => {
  const { productId, tenant, admin } = await seedDeliveredReturnOrder();
  await returnSvc.recordAdminReturnReceived(admin({ body: { expectedVersion: 1 } }));
  const inspectReq = admin({
    body: {
      expectedVersion: 2,
      inspectionNote: "Hallmark verified; resale OK",
      inspectionOutcome: "APPROVED_FOR_RESALE",
      confirmRestockInventory: true,
    },
  });
  const first = await returnSvc.recordAdminReturnInspection(inspectReq);
  assert.ok(Number(first.restock?.restockLineCount ?? 0) >= 1);
  const onHand = (await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean()).quantityOnHand;
  assert.equal(onHand, 3);
  const row = await EcommerceOrderReturnRequest.findById(admin().params.returnRequestId).lean();
  assert.ok(row.stockRestockedAt);
  await assert.rejects(
    () =>
      returnSvc.recordAdminReturnInspection({
        ...inspectReq,
        body: { ...inspectReq.body, expectedVersion: 3 },
      }),
    (err) => err.statusCode === 422 || err.code === "RETURN_NOT_RECEIVED",
  );
});

test("rejected inspection never restocks", async () => {
  const { productId, tenant, admin } = await seedDeliveredReturnOrder();
  await returnSvc.recordAdminReturnReceived(admin({ body: { expectedVersion: 1 } }));
  await returnSvc.recordAdminReturnInspection(
    admin({
      body: {
        expectedVersion: 2,
        inspectionNote: "Damage beyond resale",
        inspectionOutcome: "REJECTED_NOT_RESALABLE",
      },
    }),
  );
  const onHand = (await EcommerceInventory.findOne({ tenantId: tenant._id, productId }).lean()).quantityOnHand;
  assert.equal(onHand, 2);
});

test("online refund case is idempotent; manual refund records once", async () => {
  const ctx = await seedDeliveredReturnOrder({ paymentMethod: EcommercePaymentMethod.ONLINE });
  const { admin, tenant, orderId } = ctx;
  await returnSvc.recordAdminReturnReceived(admin({ body: { expectedVersion: 1 } }));
  await returnSvc.recordAdminReturnInspection(
    admin({
      body: {
        expectedVersion: 2,
        inspectionNote: "Approved for refund path",
        inspectionOutcome: "REJECTED_NOT_RESALABLE",
      },
    }),
  );
  const refundReq = admin({ body: { expectedVersion: 3 } });
  const a = await returnSvc.createAdminReturnRefundCase(refundReq);
  assert.equal(a.created, true);
  const b = await returnSvc.createAdminReturnRefundCase(refundReq);
  assert.equal(b.created, false);
  assert.equal(String(b.refund._id), String(a.refund._id));
  assert.equal(
    await EcommercePaymentExceptionRefund.countDocuments({ tenantId: tenant._id, orderId }),
    1,
  );
});

test("manual COD return refund is exactly-once", async () => {
  const ctx = await seedDeliveredReturnOrder({ paymentMethod: EcommercePaymentMethod.COD });
  const { admin } = ctx;
  await returnSvc.recordAdminReturnReceived(admin({ body: { expectedVersion: 1 } }));
  await returnSvc.recordAdminReturnInspection(
    admin({
      body: {
        expectedVersion: 2,
        inspectionNote: "Refund via bank transfer",
        inspectionOutcome: "REJECTED_NOT_RESALABLE",
      },
    }),
  );
  const body = {
    expectedVersion: 3,
    amountPaise: 50_000,
    recipient: "Customer Name",
    method: "NEFT",
    reference: "UTR123456789",
    proofNote: "Bank screenshot on file",
  };
  const first = await returnSvc.recordAdminReturnManualRefund(
    admin({ body, headers: { "x-idempotency-key": "manual-1" } }),
  );
  assert.equal(first.recorded, true);
  const second = await returnSvc.recordAdminReturnManualRefund(
    admin({ body, headers: { "x-idempotency-key": "manual-1" } }),
  );
  assert.equal(second.recorded, false);
});

test("replacement order must match customer and cannot be reused", async () => {
  const ctx = await seedDeliveredReturnOrder();
  const { tenant, branch, customer, admin, orderId } = ctx;
  const replacementOrderId = createId("eord");
  const otherCustomer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+918800000099",
  });
  await EcommerceOrder.create({
    _id: replacementOrderId,
    tenantId: tenant._id,
    customerId: otherCustomer._id,
    orderNumber: "EC-REP",
    status: EcommerceOrderStatus.PAID,
    totalPaise: 10_000,
    version: 1,
    lines: [],
  });
  await returnSvc.recordAdminReturnReceived(admin({ body: { expectedVersion: 1 } }));
  await returnSvc.recordAdminReturnInspection(
    admin({
      body: {
        expectedVersion: 2,
        inspectionNote: "Exchange approved after check",
        inspectionOutcome: "REJECTED_NOT_RESALABLE",
      },
    }),
  );
  await assert.rejects(
    () =>
      returnSvc.resolveAdminReturnRequest(
        admin({
          body: {
            expectedVersion: 3,
            resolutionNote: "Exchange linked to replacement order",
            replacementOrderId,
          },
        }),
      ),
    (err) => err.code === "REPLACEMENT_CUSTOMER_MISMATCH",
  );
  const goodReplacement = createId("eord");
  await EcommerceOrder.create({
    _id: goodReplacement,
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-REP-OK",
    status: EcommerceOrderStatus.PAID,
    totalPaise: 10_000,
    version: 1,
    lines: [],
  });
  await returnSvc.resolveAdminReturnRequest(
    admin({
      body: {
        expectedVersion: 3,
        resolutionNote: "Exchange linked to valid replacement order",
        replacementOrderId: goodReplacement,
      },
    }),
  );
  const secondReturn = createId("eret2");
  await EcommerceOrderReturnRequest.create({
    _id: secondReturn,
    tenantId: tenant._id,
    orderId,
    customerId: customer._id,
    kind: "EXCHANGE",
    status: EcommerceOrderReturnRequestStatus.INSPECTED,
    reason: "Second exchange attempt",
    version: 1,
    statusHistory: [],
  });
  await assert.rejects(
    () =>
      returnSvc.resolveAdminReturnRequest({
        auth: admin().auth,
        params: { returnRequestId: secondReturn },
        body: {
          expectedVersion: 1,
          resolutionNote: "Try reusing same replacement order id",
          replacementOrderId: goodReplacement,
        },
      }),
    (err) => err.code === "REPLACEMENT_ORDER_ALREADY_LINKED",
  );
});
