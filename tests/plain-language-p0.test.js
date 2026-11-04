import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  plainLanguageSellOrderStatus,
  plainLanguageEcommerceOrderStatus,
  plainLanguageCodCustomerPaidLabel,
} from "../src/lib/plain-language-labels.js";
import { rupeesToPaise, gramsToUg, paiseToRupeesNumber, ugToGramsNumber } from "../src/lib/ui-amount-conversion.js";
import {
  createStaffHandoverChallenge,
  STAFF_HANDOVER_CHALLENGE_PURPOSE,
  consumeStaffHandoverChallengeWithStaffConfirmation,
} from "../src/lib/staff-handover-challenge.js";
import { computeEcommerceOrderNextAction } from "../src/lib/ecommerce-order-next-action.js";

describe("plain-language-labels", () => {
  it("maps sell PENDING_APPROVAL to legacy review copy", () => {
    assert.equal(plainLanguageSellOrderStatus("PENDING_APPROVAL"), "Previous request needs review");
  });

  it("maps ecommerce statuses without changing stored codes", () => {
    assert.equal(plainLanguageEcommerceOrderStatus("PROCESSING"), "Preparing order");
  });

  it("labels COD customer paid separately", () => {
    assert.equal(plainLanguageCodCustomerPaidLabel({ collectionConfirmed: true }), "Customer paid");
    assert.equal(plainLanguageCodCustomerPaidLabel({ collectionConfirmed: false }), "Payment unconfirmed");
  });
});

describe("ui-amount-conversion", () => {
  it("converts rupees to paise and back", () => {
    assert.equal(rupeesToPaise(10.5), 1050);
    assert.equal(paiseToRupeesNumber(1050), 10.5);
  });

  it("converts grams to ug and back", () => {
    assert.equal(gramsToUg(1), 1_000_000);
    assert.equal(ugToGramsNumber(1_000_000), 1);
  });
});

describe("staff-handover-challenge", () => {
  it("binds challenge to order customer purpose and consumes with staff confirmation", () => {
    const binding = {
      orderId: "ord_1",
      customerId: "cus_1",
      branchId: "br_1",
      purpose: STAFF_HANDOVER_CHALLENGE_PURPOSE.ECOMMERCE_PICKUP_LEGACY_CONFIRM,
    };
    const created = createStaffHandoverChallenge(binding);
    const consumed = consumeStaffHandoverChallengeWithStaffConfirmation(created, {
      submittedCode: created.challengeCode,
      binding,
      staffUserId: "staff_1",
      staffHandoverConfirmed: true,
    });
    assert.ok(consumed.consumedAt);
    assert.equal(consumed.handoverConfirmedByStaffUserId, "staff_1");
  });
});

describe("ecommerce-order-next-action", () => {
  it("suggests ship for paid delivery orders", () => {
    const action = computeEcommerceOrderNextAction({
      _id: "ord_x",
      status: "PAID",
      fulfilmentMode: "DELIVERY",
    });
    assert.equal(action.key, "SHIP");
  });
});
