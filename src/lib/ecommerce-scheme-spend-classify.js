import { EcommerceOrderStatus, RedemptionStatus } from "../constants/enums.js";

const FAILED_ORDER_STATUSES = new Set([
  EcommerceOrderStatus.PAYMENT_EXPIRED,
  EcommerceOrderStatus.PAYMENT_FAILED,
  EcommerceOrderStatus.CANCELLED,
]);

const FULFILMENT_IN_PROGRESS_STATUSES = new Set([
  EcommerceOrderStatus.PAID,
  EcommerceOrderStatus.PROCESSING,
  EcommerceOrderStatus.READY_FOR_PICKUP,
  EcommerceOrderStatus.SHIPPED,
]);

const SUCCESS_REDEMPTION = new Set([RedemptionStatus.COMPLETED]);
const OPEN_REDEMPTION = new Set([
  RedemptionStatus.REQUESTED,
  RedemptionStatus.PENDING_APPROVAL,
  RedemptionStatus.APPROVED,
]);

/** Whether this shop checkout actually moved scheme value (vs hold that was released). */
export function classifySchemeEcommerceSpend(redemption, order) {
  const orderStatus = order?.status ?? null;
  const redemptionStatus = redemption?.status ?? null;

  if (redemptionStatus === RedemptionStatus.REJECTED || (orderStatus && FAILED_ORDER_STATUSES.has(orderStatus))) {
    const outcomeLabel = orderStatus === EcommerceOrderStatus.PAYMENT_EXPIRED
      ? "Checkout expired — scheme balance restored"
      : orderStatus === EcommerceOrderStatus.CANCELLED
        ? "Order cancelled — scheme balance restored"
        : redemptionStatus === RedemptionStatus.REJECTED
          ? "Not completed — scheme balance restored"
          : "Did not complete — scheme balance restored";
    return {
      countsAsSpend: false,
      outcome: "FAILED",
      outcomeLabel,
      showAppliedAsDeduction: false,
    };
  }

  if (SUCCESS_REDEMPTION.has(redemptionStatus)) {
    return {
      countsAsSpend: true,
      outcome: "COMPLETED",
      outcomeLabel: "Used for this order",
      showAppliedAsDeduction: true,
    };
  }

  if (OPEN_REDEMPTION.has(redemptionStatus) && orderStatus && !FAILED_ORDER_STATUSES.has(orderStatus)) {
    const approval = order?.financialSnapshot?.schemePurchase?.approvalStatus;
    const topUpPaise = Number(order?.financialSnapshot?.schemePurchase?.topUpPaise ?? 0);
    let outcomeLabel;
    if (approval === "PENDING") {
      outcomeLabel = "Reserved — awaiting jeweller approval";
    } else if (FULFILMENT_IN_PROGRESS_STATUSES.has(orderStatus)) {
      outcomeLabel =
        topUpPaise > 0
          ? "Reserved — paid; scheme applies when order is delivered or picked up"
          : "Reserved — fulfilment in progress; scheme applies on delivery or pickup";
    } else if (orderStatus === EcommerceOrderStatus.PENDING_PAYMENT) {
      outcomeLabel = "Reserved — awaiting customer payment";
    } else {
      outcomeLabel = "Reserved — shop checkout in progress";
    }
    return {
      countsAsSpend: false,
      outcome: "PENDING",
      outcomeLabel,
      showAppliedAsDeduction: false,
    };
  }

  return {
    countsAsSpend: false,
    outcome: "UNKNOWN",
    outcomeLabel: "Shop checkout attempt",
    showAppliedAsDeduction: false,
  };
}