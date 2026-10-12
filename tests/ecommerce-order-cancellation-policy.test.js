import test from "node:test";
import assert from "node:assert/strict";
import {
  customerDirectCancelEligible,
  customerCancellationRequestEligible,
  paymentAttemptBlocksCustomerCancel,
} from "../src/lib/ecommerce-order-cancellation-policy.js";
import { EcommerceOrderStatus } from "../src/constants/enums.js";

test("direct cancel blocked when payment in flight", () => {
  const order = { status: EcommerceOrderStatus.PENDING_PAYMENT };
  const attempt = { status: "INITIATED", operationalStatus: "NORMAL", providerOrderId: "x" };
  assert.equal(
    customerDirectCancelEligible(order, {
      paymentInFlightBlocked: paymentAttemptBlocksCustomerCancel(attempt),
    }).allowed,
    false,
  );
});

test("direct cancel allowed for COD pending acceptance", () => {
  const order = { status: EcommerceOrderStatus.COD_PENDING_ACCEPTANCE };
  assert.equal(
    customerDirectCancelEligible(order, { paymentInFlightBlocked: false }).allowed,
    true,
  );
});

test("cancellation request blocked after shipped", () => {
  const order = { status: EcommerceOrderStatus.SHIPPED };
  const cap = customerCancellationRequestEligible(order);
  assert.equal(cap.allowed, false);
  assert.equal(cap.code, "CONTACT_STORE_FOR_RETURN");
});

test("cancellation request allowed when processing", () => {
  const order = { status: EcommerceOrderStatus.PROCESSING };
  assert.equal(customerCancellationRequestEligible(order).allowed, true);
});
