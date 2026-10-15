import test from "node:test";
import assert from "node:assert/strict";
import {
  categoryShopDeepLink,
  offerRevisionKey,
  productShopDeepLink,
  suggestCategoryPromotionCopy,
} from "../src/services/ecommerce-promotion.service.js";
import { dispatchPriorityForMessageType } from "../src/lib/message-dispatch-priority.js";
import { MessageType } from "../src/constants/enums.js";

test("typed shop deep links", () => {
  assert.equal(productShopDeepLink("gold-ring"), "/shop/gold-ring");
  assert.equal(categoryShopDeepLink("ecat_1"), "/shop?categoryId=ecat_1");
});

test("offer revision changes when offer changes", () => {
  const base = {
    _id: "eprd_1",
    priceMode: "GOLD_RATE_BASED",
    offer: { type: "PERCENT_OFF", percentBps: 500 },
    fixedPricing: null,
  };
  const a = offerRevisionKey(base);
  const b = offerRevisionKey({
    ...base,
    offer: { type: "PERCENT_OFF", percentBps: 1000 },
  });
  assert.notEqual(a, b);
  assert.equal(offerRevisionKey(base), a);
});

test("marketing message types dispatch below transactional", () => {
  assert.ok(dispatchPriorityForMessageType(MessageType.PAYMENT_SUCCESS) < dispatchPriorityForMessageType(MessageType.ECOMMERCE_PRODUCT_PROMOTION));
});

test("category promotion copy does not invent pricing", () => {
  const copy = suggestCategoryPromotionCopy({ name: "Chains" });
  assert.match(copy.body, /Chains/);
  assert.doesNotMatch(copy.body, /₹/);
});
