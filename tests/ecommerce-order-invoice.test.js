import test from "node:test";
import assert from "node:assert/strict";
import { isEcommerceOrderInvoiceAvailable } from "../src/lib/ecommerce-order-invoice-eligibility.js";
import { EcommerceOrderStatus } from "../src/constants/enums.js";

test("invoice unavailable before payment or COD acceptance", () => {
  for (const status of [
    EcommerceOrderStatus.PENDING_PAYMENT,
    EcommerceOrderStatus.PAYMENT_EXPIRED,
    EcommerceOrderStatus.COD_PENDING_ACCEPTANCE,
    EcommerceOrderStatus.CANCELLED,
  ]) {
    assert.equal(isEcommerceOrderInvoiceAvailable({ status }), false);
  }
});

test("invoice available after order is confirmed", () => {
  for (const status of [
    EcommerceOrderStatus.PAID,
    EcommerceOrderStatus.PROCESSING,
    EcommerceOrderStatus.SHIPPED,
    EcommerceOrderStatus.DELIVERED,
  ]) {
    assert.equal(isEcommerceOrderInvoiceAvailable({ status }), true);
  }
});
