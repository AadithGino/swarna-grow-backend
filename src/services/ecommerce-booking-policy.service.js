import { createHash } from "node:crypto";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { assertBranchEligible, pickPolicyAssignment } from "../lib/ecommerce-booking-policy.js";
import {
  EcommerceBookingAdvanceMode,
  EcommerceBookingPolicyScope,
  EcommerceBookingPolicyStatus,
  EcommerceBookingRateRule,
} from "../constants/enums.js";
import {
  Branch,
  EcommerceBookingPolicyAssignment,
  EcommerceBookingPolicyVersion,
  EcommerceCategory,
  EcommerceProduct,
} from "../models/index.js";

/**
 * Booking policy management and resolution. Versions are immutable once published; changing a
 * policy means publishing a new version and moving assignments to it. Routes and permissions
 * (ECOMMERCE_BOOKING_POLICY_PUBLISH) wrap these functions in a later change.
 */

const sha256 = (text) => createHash("sha256").update(String(text ?? "")).digest("hex");

function validateDraftFields(fields) {
  const issues = [];
  const advance = fields.advance ?? {};
  if (advance.mode === EcommerceBookingAdvanceMode.PERCENT) {
    if (!Number.isInteger(advance.percentBps) || advance.percentBps < 1 || advance.percentBps > 10_000) {
      issues.push({ field: "advance.percentBps", message: "A percentage advance needs 1 to 10000 basis points." });
    }
  } else if (advance.mode === EcommerceBookingAdvanceMode.FIXED) {
    if (!Number.isInteger(advance.fixedPaise) || advance.fixedPaise < 1) {
      issues.push({ field: "advance.fixedPaise", message: "A fixed advance needs a positive whole number of paise." });
    }
  } else {
    issues.push({ field: "advance.mode", message: "Advance mode must be PERCENT or FIXED." });
  }
  if (!Object.values(EcommerceBookingRateRule).includes(fields.rateRule)) {
    issues.push({ field: "rateRule", message: "A gold-rate rule is required." });
  }
  if (issues.length) throw errors.validation(issues);
}

/** Every id must be a branch of this tenant, so a policy can never name another tenant's branch. */
async function assertBranchesBelongToTenant(tenantId, branchIds) {
  const wanted = [...new Set((branchIds ?? []).map(String))];
  if (!wanted.length) return;
  const found = await Branch.countDocuments({ tenantId, _id: { $in: wanted } });
  if (found !== wanted.length) {
    throw errors.validation([{ field: "eligiblePickupBranchIds", message: "Every eligible pickup branch must be a branch of this jeweller." }]);
  }
}

export async function createPolicyDraft({ tenantId, policyKey, name, fields }) {
  validateDraftFields(fields);
  await assertBranchesBelongToTenant(tenantId, fields.eligiblePickupBranchIds);
  const last = await EcommerceBookingPolicyVersion.findOne({ tenantId, policyKey }).sort({ version: -1 }).lean();
  return EcommerceBookingPolicyVersion.create({
    tenantId,
    policyKey,
    name,
    version: (last?.version ?? 0) + 1,
    status: EcommerceBookingPolicyStatus.DRAFT,
    ...fields,
    terms: { text: fields.terms?.text ?? "", hash: "" },
  }).then((doc) => doc.toObject());
}

/** Publishing freezes the version and fingerprints its terms. Only a draft can be published. */
export async function publishPolicyVersion({ tenantId, policyVersionId, publishedBy = null, at = new Date() }) {
  const draft = await EcommerceBookingPolicyVersion.findOne({ _id: policyVersionId, tenantId }).lean();
  if (!draft) throw errors.notFound("Booking policy version");
  if (draft.status !== EcommerceBookingPolicyStatus.DRAFT) {
    throw errors.conflict("BOOKING_POLICY_NOT_DRAFT", "Only a draft policy version can be published.");
  }
  validateDraftFields(draft);
  const published = await EcommerceBookingPolicyVersion.findOneAndUpdate(
    { _id: policyVersionId, tenantId, status: EcommerceBookingPolicyStatus.DRAFT },
    {
      $set: {
        status: EcommerceBookingPolicyStatus.PUBLISHED,
        publishedAt: at,
        ...(publishedBy ? { publishedBy } : {}),
        "terms.hash": sha256(draft.terms?.text),
      },
    },
    { new: true },
  ).lean();
  if (!published) throw errors.conflict("BOOKING_POLICY_NOT_DRAFT", "Only a draft policy version can be published.");
  return published;
}

/**
 * Point a scope at a published version, or switch booking off for it. One active assignment per
 * (scope type, scope id): setting it again replaces the previous one.
 */
export async function setPolicyAssignment({
  tenantId,
  scopeType,
  scopeId,
  bookingEnabled,
  policyVersionId = null,
  updatedBy = null,
}) {
  if (!Object.values(EcommerceBookingPolicyScope).includes(scopeType) || !scopeId) {
    throw errors.validation([{ field: "scope", message: "A scope type and scope id are required." }]);
  }
  const target = scopeType === EcommerceBookingPolicyScope.PRODUCT
    ? await EcommerceProduct.exists({ _id: scopeId, tenantId })
    : scopeType === EcommerceBookingPolicyScope.CATEGORY
      ? await EcommerceCategory.exists({ _id: scopeId, tenantId })
      : await Branch.exists({ _id: scopeId, tenantId });
  if (!target) {
    throw errors.validation([{ field: "scopeId", message: "The scope must be a product, category or branch of this jeweller." }]);
  }
  if (bookingEnabled) {
    const version = await EcommerceBookingPolicyVersion.findOne({ _id: policyVersionId, tenantId }).lean();
    if (!version || version.status !== EcommerceBookingPolicyStatus.PUBLISHED) {
      throw errors.business("BOOKING_POLICY_UNAVAILABLE", "Assign a published policy version.", { policyVersionId });
    }
  }
  return withTransaction(async (session) => {
    const row = await EcommerceBookingPolicyAssignment.findOneAndUpdate(
      { tenantId, scopeType, scopeId, active: true },
      {
        $set: {
          bookingEnabled: Boolean(bookingEnabled),
          policyVersionId: bookingEnabled ? policyVersionId : null,
          ...(updatedBy ? { updatedBy } : {}),
        },
      },
      { session, new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
    return row;
  });
}

/**
 * The policy that applies to this product at this pickup branch, or an error saying why booking is
 * not offered. Returns the published version itself so the booking can snapshot it.
 */
export async function resolveBookingPolicy({ tenantId, product, pickupBranchId, session }) {
  const find = (scopeType, scopeId) => {
    if (!scopeId) return null;
    const q = EcommerceBookingPolicyAssignment.findOne({ tenantId, scopeType, scopeId, active: true }).lean();
    return session ? q.session(session) : q;
  };
  const [byProduct, byCategory, byBranch] = await Promise.all([
    find(EcommerceBookingPolicyScope.PRODUCT, String(product._id)),
    find(EcommerceBookingPolicyScope.CATEGORY, product.categoryId ? String(product.categoryId) : null),
    find(EcommerceBookingPolicyScope.BRANCH, pickupBranchId),
  ]);
  const picked = pickPolicyAssignment({ product: byProduct, category: byCategory, branch: byBranch });
  if (!picked.enabled) {
    throw new AppError("BOOKING_NOT_AVAILABLE", "Advance booking is not available for this ornament.", 422, { reason: picked.reason });
  }
  const versionQuery = EcommerceBookingPolicyVersion.findOne({
    _id: picked.assignment.policyVersionId,
    tenantId,
    status: EcommerceBookingPolicyStatus.PUBLISHED,
  }).lean();
  const policy = await (session ? versionQuery.session(session) : versionQuery);
  if (!policy) {
    throw new AppError("BOOKING_POLICY_UNAVAILABLE", "The assigned booking policy is not published.", 422);
  }
  assertBranchEligible(policy, pickupBranchId);
  return { policy, scopeType: picked.assignment.scopeType, scopeId: picked.assignment.scopeId };
}
