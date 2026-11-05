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

/**
 * Open enrollments — paying + capped + defaulted (first instalment paid or account in default).
 * Excludes not-started, matured, and completed.
 */
export function openEnrollmentKpi({
  activePaying = 0,
  planCapped = 0,
  defaulted = 0,
  /** @deprecated pass activePaying + planCapped instead */
  activeAndLocked = 0,
} = {}) {
  if (activePaying || planCapped) {
    return activePaying + planCapped + defaulted;
  }
  return activeAndLocked + defaulted;
}

/** Mutually exclusive status buckets — parts sum to {@link total}. */
export function enrollmentStatusBreakdown({
  notStarted = 0,
  activePaying = 0,
  planCapped = 0,
  defaulted = 0,
  matured = 0,
  completed = 0,
} = {}) {
  const open = openEnrollmentKpi({ activePaying, planCapped, defaulted });
  const inProgress = notStarted + open;
  const total = inProgress + matured + completed;
  return {
    notStarted,
    activePaying,
    planCapped,
    defaulted,
    open,
    matured,
    completed,
    inProgress,
    total,
  };
}
