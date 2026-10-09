import test from "node:test";
import assert from "node:assert/strict";
import { EcommerceOrderStatus } from "../src/constants/enums.js";
import {
  assertEcommerceOrderTransition,
} from "../src/lib/ecommerce-order-transitions.js";

test("staff cannot mark pending payment paid directly", () => {
  assert.throws(
    () =>
      assertEcommerceOrderTransition(
        "STAFF",
        EcommerceOrderStatus.PENDING_PAYMENT,
        EcommerceOrderStatus.PAID,
      ),
    (err) => err.code === "INVALID_STATE_TRANSITION",
  );
});

test("system may mark pending payment paid after gateway verify", () => {
  assert.doesNotThrow(() =>
    assertEcommerceOrderTransition(
      "SYSTEM",
      EcommerceOrderStatus.PENDING_PAYMENT,
      EcommerceOrderStatus.PAID,
    ),
  );
});

test("system may expire pending payment window", () => {
  assert.doesNotThrow(() =>
    assertEcommerceOrderTransition(
      "SYSTEM",
      EcommerceOrderStatus.PENDING_PAYMENT,
      EcommerceOrderStatus.PAYMENT_EXPIRED,
    ),
  );
});
