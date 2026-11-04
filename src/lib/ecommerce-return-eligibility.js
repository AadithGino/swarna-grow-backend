import { EcommerceFulfilmentMode } from "../constants/enums.js";

/** Immutable anchor for return windows — never use order.updatedAt. */
export function returnEligibilityAnchorAt(order) {
  const deliveredAt = order.deliveryTracking?.deliveredAt;
  if (deliveredAt) return new Date(deliveredAt);

  const pickupVerifiedAt = order.fulfilmentHandover?.pickupVerifiedAt ?? order.fulfilmentHandover?.recordedAt;
  if (pickupVerifiedAt && order.fulfilmentMode === EcommerceFulfilmentMode.BRANCH_PICKUP) {
    return new Date(pickupVerifiedAt);
  }

  const snapshotAnchor = order.policySnapshot?.returnEligibilityAnchorAt ?? order.returnPolicySnapshot?.eligibilityAnchorAt;
  if (snapshotAnchor) return new Date(snapshotAnchor);

  return null;
}
