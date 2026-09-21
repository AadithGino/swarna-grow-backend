import { SchemeStatus } from "../constants/enums.js";

export const SYSTEM_POLICY_CLOSURE_REASONS = Object.freeze([
  "ZERO_FLEXIBLE_PHASE_TOTAL",
  "BELOW_MINIMUM_FLEXIBLE_PHASE_TOTAL",
]);

/** @deprecated use SYSTEM_POLICY_CLOSURE_REASONS */
export const FLEX_SYSTEM_CLOSURE_REASONS = SYSTEM_POLICY_CLOSURE_REASONS;

/** Scheme closed by flexible lock policy (includes zero-principal closures). */
export function isFlexSystemPolicyClosure(scheme) {
  return (
    scheme?.status === SchemeStatus.CLOSED_PREMATURE
    && SYSTEM_POLICY_CLOSURE_REASONS.includes(scheme.closureReason)
  );
}

/**
 * Staff settlement of net allocated principal after automatic flex-policy closure.
 * Requires persisted settlementRequired — not derivable from request input.
 */
export function isSystemPolicyClosureSettlement(scheme) {
  return (
    isFlexSystemPolicyClosure(scheme)
    && scheme.settlementRequired === true
  );
}
