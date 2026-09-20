import { SchemeStatus } from "../constants/enums.js";

/** Still open for operations (not matured / redeemed / closed). */
export const OPEN_ENROLLMENT_STATUSES = Object.freeze([
  SchemeStatus.ACTIVE,
  SchemeStatus.LOCKED,
  SchemeStatus.DEFAULTED,
]);

/** Paying or capped — excludes defaulted. */
export const ACTIVE_AND_LOCKED_STATUSES = Object.freeze([
  SchemeStatus.ACTIVE,
  SchemeStatus.LOCKED,
]);
