import { SchemePlanStatus } from "../constants/enums.js";
import { Scheme } from "../models/index.js";
import { errors } from "./app-error.js";
import { today } from "./date.js";
import { validateCompletePlan } from "./plan-merge.js";
import {
  ENROLMENT_CAPACITY_STATUSES,
  ONE_ACTIVE_SCHEME_CONFLICT_STATUSES,
} from "./scheme-enrollment-status.js";
import { assertFeatureEntitled } from "./tenant-limits.js";
import { isKycMandatoryForEnrolment } from "./kyc-policy.js";

export async function assertOneActiveSchemePolicy(session, tenantId, customerId) {
  const conflicts = await Scheme.countDocuments({
    tenantId,
    customerId,
    status: { $in: ONE_ACTIVE_SCHEME_CONFLICT_STATUSES },
  }).session(session);
  if (conflicts > 0) {
    throw errors.business("ONE_SCHEME_POLICY", "This customer already has an active scheme.");
  }
}

export async function assertPlanEnrolmentCapacityInSession(
  session,
  tenantId,
  planId,
  maxEnrolments,
) {
  if (maxEnrolments == null) return;
  const occupied = await Scheme.countDocuments({
    tenantId,
    planId,
    status: { $in: ENROLMENT_CAPACITY_STATUSES },
  }).session(session);
  if (occupied >= maxEnrolments) {
    throw errors.business("PLAN_ENROLMENT_LIMIT_REACHED", "This plan has reached its enrolment limit.");
  }
}

/**
 * Authoritative enrolment checks against the locked plan document inside the transaction.
 */
export async function revalidateLockedPlanForEnrolment(
  req,
  session,
  {
    plan,
    customer,
    branchId,
    installmentAmountPaise,
    firstInstallmentMode,
    validateAmount,
    assertPlanAvailableAtBranch,
    assertActiveEnrolBranch,
  },
) {
  if (plan.status !== SchemePlanStatus.ACTIVE) {
    throw errors.business("PLAN_ENROLMENT_CLOSED", "This plan is not accepting enrolments.");
  }
  validateCompletePlan(plan);
  const availability = plan.availability ?? {};
  const calendarToday = today();
  if (availability.enrolmentOpenFrom && calendarToday < availability.enrolmentOpenFrom) {
    throw errors.business("PLAN_ENROLMENT_NOT_OPEN", `Enrolment opens on ${availability.enrolmentOpenFrom}.`);
  }
  if (availability.enrolmentOpenTo && calendarToday > availability.enrolmentOpenTo) {
    throw errors.business("PLAN_ENROLMENT_CLOSED", "The enrolment window for this plan has closed.");
  }
  if (req.auth?.type === "CUSTOMER") {
    if (req.tenant?.operations?.customerSelfEnrolEnabled === false) {
      throw errors.business(
        "SELF_ENROL_DISABLED",
        "Self-enrolment is not available. Contact your branch to join a scheme.",
      );
    }
    assertFeatureEntitled(req.tenant, "customerSelfEnrol", "Your jewellery plan does not include customer self-enrolment.");
    if (availability.customerSelfEnrolAllowed !== true) {
      throw errors.business("PLAN_SELF_ENROL_DISABLED", "This plan requires branch-assisted enrolment.");
    }
  }
  await assertPlanEnrolmentCapacityInSession(
    session,
    req.auth.tenantId,
    plan._id,
    availability.maxEnrolments,
  );
  if (plan.flexibleRules?.extensionMode === "EXTEND_FLEXIBLE_PHASE") {
    throw errors.business(
      "UNSUPPORTED_PLAN_CONFIGURATION",
      "Flexible-phase extension is not supported and cannot be used in a plan.",
    );
  }
  if (customer.status !== "ACTIVE") {
    throw errors.business("CUSTOMER_NOT_ACTIVE", "This customer is not active.");
  }
  if (isKycMandatoryForEnrolment(req.tenant) && customer.kyc?.status !== "VERIFIED") {
    throw errors.business("KYC_REQUIRED", "Verified KYC is required before enrolment.");
  }
  await assertActiveEnrolBranch(req.auth.tenantId, branchId);
  assertPlanAvailableAtBranch(plan, branchId);
  validateAmount(plan, installmentAmountPaise);
  return {
    plan,
    customer,
    branchId,
    installmentAmountPaise,
    firstInstallmentMode,
  };
}
