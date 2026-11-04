import test from "node:test";
import assert from "node:assert/strict";
import { returnEligibilityAnchorAt } from "../src/lib/ecommerce-return-eligibility.js";
import { EcommerceFulfilmentMode, EcommerceOrderStatus } from "../src/constants/enums.js";

test("return anchor uses delivery milestone not updatedAt", () => {
  const deliveredAt = new Date("2026-10-01T10:00:00.000Z");
  const updatedAt = new Date("2026-11-01T10:00:00.000Z");
  const anchor = returnEligibilityAnchorAt({
    status: EcommerceOrderStatus.DELIVERED,
    deliveryTracking: { deliveredAt },
    updatedAt,
  });
  assert.equal(anchor?.toISOString(), deliveredAt.toISOString());
});

test("pickup collected anchor uses pickupVerifiedAt", () => {
  const pickupVerifiedAt = new Date("2026-10-05T08:00:00.000Z");
  const anchor = returnEligibilityAnchorAt({
    status: EcommerceOrderStatus.DELIVERED,
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
    fulfilmentHandover: { pickupVerifiedAt, recordedAt: pickupVerifiedAt },
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  });
  assert.equal(anchor?.toISOString(), pickupVerifiedAt.toISOString());
});
