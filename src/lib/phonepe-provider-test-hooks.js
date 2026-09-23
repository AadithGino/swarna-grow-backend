import { ResourceNotFound } from "@phonepe-pg/pg-sdk-node";
import { AppError } from "./app-error.js";

function enabled() {
  return process.env.NODE_ENV === "test";
}

function assertTestEnv() {
  if (!enabled()) {
    throw new Error("PhonePe provider test hooks require NODE_ENV=test");
  }
}

const orderStatusByMerchantOrderId = new Map();
const refundInitByMerchantRefundId = new Map();
const refundStatusByMerchantRefundId = new Map();

export function clearPhonePeProviderTestHooks() {
  orderStatusByMerchantOrderId.clear();
  refundInitByMerchantRefundId.clear();
  refundStatusByMerchantRefundId.clear();
}

export function armMockOrderStatus(merchantOrderId, response) {
  assertTestEnv();
  orderStatusByMerchantOrderId.set(String(merchantOrderId), response);
}

export function armMockRefundInit(merchantRefundId, handler) {
  assertTestEnv();
  refundInitByMerchantRefundId.set(String(merchantRefundId), handler);
}

export function armMockRefundStatus(merchantRefundId, response) {
  assertTestEnv();
  refundStatusByMerchantRefundId.set(String(merchantRefundId), response);
}

const ORDER_STATUS_TEMPLATES = {
  __mock_completed_49000__: (id) => ({
    state: "COMPLETED",
    merchantOrderId: id,
    amount: 49_000,
    orderId: `mock_order_${id}`,
    paymentDetails: [{ state: "COMPLETED", transactionId: `mock_txn_${id}`, amount: 49_000 }],
  }),
  __mock_completed__: (id) => ({
    state: "COMPLETED",
    merchantOrderId: id,
    amount: 50_000,
    orderId: `mock_order_${id}`,
    paymentDetails: [{ state: "COMPLETED", transactionId: `mock_txn_${id}`, amount: 50_000 }],
  }),
  __mock_failed__: (id) => ({
    state: "FAILED",
    merchantOrderId: id,
    amount: 50_000,
    orderId: `mock_order_${id}`,
    paymentDetails: [{ state: "FAILED", transactionId: `mock_txn_${id}`, amount: 50_000 }],
  }),
  __mock_completed_no_txn__: (id) => ({
    state: "COMPLETED",
    merchantOrderId: id,
    amount: 50_000,
    orderId: `mock_order_${id}`,
    paymentDetails: [{ state: "PENDING", transactionId: "", amount: 50_000 }],
  }),
  __mock_completed_zero__: (id) => ({
    state: "COMPLETED",
    merchantOrderId: id,
    amount: 0,
    orderId: `mock_order_${id}`,
    paymentDetails: [{ state: "COMPLETED", transactionId: `mock_txn_zero_${id}`, amount: 0 }],
  }),
  __mock_transient__: () => {
    throw new Error("mock transient provider error");
  },
};

/** Register a canned mock order-status outcome for an intent id (test fixtures only). */
export function armMockOrderStatusTemplate(merchantOrderId, templateKey) {
  assertTestEnv();
  if (!ORDER_STATUS_TEMPLATES[templateKey]) {
    throw new Error(`Unknown PhonePe mock order template: ${templateKey}`);
  }
  orderStatusByMerchantOrderId.set(String(merchantOrderId), { templateKey });
}

export function resolveMockOrderStatus(merchantOrderId) {
  if (!enabled()) return null;
  const id = String(merchantOrderId);
  const entry = orderStatusByMerchantOrderId.get(id);
  if (!entry) return null;
  if (entry.templateKey) {
    return ORDER_STATUS_TEMPLATES[entry.templateKey](id);
  }
  return entry;
}

export function resolveMockRefundInit(merchantRefundId, context) {
  if (!enabled()) return undefined;
  const handler = refundInitByMerchantRefundId.get(String(merchantRefundId));
  if (!handler) return undefined;
  return handler(context);
}

export function resolveMockRefundStatus(merchantRefundId) {
  if (!enabled()) return null;
  return refundStatusByMerchantRefundId.get(String(merchantRefundId)) ?? null;
}

export const REFUND_INIT_TEMPLATES = {
  __mock_init_reject__: () => {
    throw new AppError("PHONEPE_REFUND_REJECTED", "Mock PhonePe refund rejected by provider.", 422);
  },
  __mock_init_fail__: () => {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "Mock PhonePe refund initiation failure.", 503);
  },
  __mock_init_timeout__: () => {
    const err = new Error("Mock provider timeout ETIMEDOUT");
    err.code = "ETIMEDOUT";
    throw err;
  },
};

export const REFUND_STATUS_TEMPLATES = {
  __mock_refund_missing__: () => {
    throw new ResourceNotFound("Mock refund not found at provider.");
  },
  __mock_refund_failed__: (id) => ({ state: "FAILED", merchantRefundId: id, amount: 0 }),
  __mock_refund_completed__: (id) => ({ state: "COMPLETED", merchantRefundId: id, amount: 50_000 }),
};

export function armMockRefundInitTemplate(merchantRefundId, templateKey) {
  assertTestEnv();
  const template = REFUND_INIT_TEMPLATES[templateKey];
  if (!template) throw new Error(`Unknown refund init template: ${templateKey}`);
  refundInitByMerchantRefundId.set(String(merchantRefundId), template);
}

export function armMockRefundStatusTemplate(merchantRefundId, templateKey) {
  assertTestEnv();
  const template = REFUND_STATUS_TEMPLATES[templateKey];
  if (!template) throw new Error(`Unknown refund status template: ${templateKey}`);
  const id = String(merchantRefundId);
  refundStatusByMerchantRefundId.set(id, template(id));
}
