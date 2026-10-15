import { MessageType } from "../constants/enums.js";

const MARKETING_MESSAGE_TYPES = new Set([
  MessageType.MANUAL_PUSH,
  MessageType.ECOMMERCE_PRODUCT_PROMOTION,
  MessageType.ECOMMERCE_CATEGORY_PROMOTION,
  MessageType.ECOMMERCE_NEW_ARRIVAL,
  MessageType.ECOMMERCE_OFFER,
  MessageType.SCHEME_GOLD_RATE_UPDATED,
  MessageType.ECOMMERCE_GOLD_RATE_UPDATED,
]);

/** Lower number = higher priority (transactional before marketing). */
export function dispatchPriorityForMessageType(type) {
  if (MARKETING_MESSAGE_TYPES.has(type)) return 10;
  return 0;
}
