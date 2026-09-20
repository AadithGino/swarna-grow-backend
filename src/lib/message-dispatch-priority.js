import { MessageType } from "../constants/enums.js";

/** Lower number = higher priority (transactional before marketing). */
export function dispatchPriorityForMessageType(type) {
  if (type === MessageType.MANUAL_PUSH) return 10;
  return 0;
}
