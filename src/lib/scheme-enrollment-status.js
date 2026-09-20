import { SchemeStatus } from "../constants/enums.js";

/** Still open for operations (not matured / redeemed / closed). */
export const OPEN_ENROLLMENT_STATUSES = Object.freeze([
  SchemeStatus.PENDING_PAYMENT,
  SchemeStatus.ACTIVE,
  SchemeStatus.LOCKED,
  SchemeStatus.DEFAULTED,
]);

/** Schemes that consume plan enrolment capacity (excludes redeemed / closed history). */
export const ENROLMENT_CAPACITY_STATUSES = Object.freeze([
  SchemeStatus.PENDING_PAYMENT,
  SchemeStatus.ACTIVE,
  SchemeStatus.LOCKED,
  SchemeStatus.DEFAULTED,
  SchemeStatus.MATURED,
]);

/** Conflicts with one-active-scheme policy when enabled on the tenant. */
export const ONE_ACTIVE_SCHEME_CONFLICT_STATUSES = Object.freeze([
  SchemeStatus.PENDING_PAYMENT,
  SchemeStatus.ACTIVE,
  SchemeStatus.LOCKED,
  SchemeStatus.DEFAULTED,
]);

/** Paying or capped — excludes defaulted. */
export const ACTIVE_AND_LOCKED_STATUSES = Object.freeze([
  SchemeStatus.ACTIVE,
  SchemeStatus.LOCKED,
]);
