/**
 * This slice's clone scope and field-remap spec (plan sections 5.1-5.3), used by
 * demo-template.service.js (publish) and demo-provision.service.js (clone).
 *
 * IMPORTANT — scope: this slice clones only Branch, Customer, SchemePlan, Scheme,
 * LedgerEntry and Payment, i.e. the "browse my gold-savings schemes" customer-portal
 * surface (plan section 10's Home/schemes/plan-details/payments row). It deliberately does
 * NOT clone Redemption, any DigitalMetal* model, any Ecommerce* model, staff/User records,
 * Counter, or Upload — see docs/demo-builder-phase-1-2-foundation.md for the full list and
 * why. src/lib/demo-clone-registry.js is still the authoritative per-model policy registry
 * for the whole plan; this file only has to agree with it for the six models listed here.
 */

// Order matters: each collection is cloned after everything its idRefs point to, so the
// id-map lookups below always have what they need. LedgerEntry.paymentId needs Payment's
// map, so Payment is cloned first.
export const DEMO_SLICE_COLLECTIONS = Object.freeze([
  "Branch",
  "Customer",
  "SchemePlan",
  "Scheme",
  "Payment",
  "LedgerEntry",
]);

/** createId() prefix key (src/lib/ids.js) for each collection's new _id. */
export const ID_KIND_BY_COLLECTION = Object.freeze({
  Branch: "branch",
  Customer: "customer",
  SchemePlan: "plan",
  Scheme: "scheme",
  Payment: "payment",
  LedgerEntry: "ledger",
});

/**
 * Per-collection spec:
 *  - idRefs: { field: targetCollection } — scalar foreign keys remapped through that target
 *    collection's id map. A ref whose target isn't in DEMO_SLICE_COLLECTIONS is nulled
 *    instead (nothing to point it at in the clone).
 *  - sanitize(doc): mutates a plain object in place — strip secrets/PII/real-provider ids.
 */
export const CLONE_FIELD_SPEC = Object.freeze({
  Branch: {
    idRefs: {},
    sanitize: (doc) => {
      doc.mobile = null;
      doc.contactNumber = null;
    },
  },
  Customer: {
    idRefs: { branchId: "Branch" },
    sanitize: (doc, { newId }) => {
      doc.mobile = syntheticMobileFrom(newId);
      doc.email = null;
      doc.passwordHash = undefined;
      doc.mustSetPassword = false;
      doc.passwordSetAt = null;
      doc.fcmTokens = [];
      doc.createdBy = null;
      doc.isDemo = true;
      if (doc.kyc) {
        doc.kyc = { ...doc.kyc, frontUploadId: null, backUploadId: null };
      }
      if (doc.nominee?.mobile) doc.nominee = { ...doc.nominee, mobile: null };
    },
  },
  SchemePlan: {
    idRefs: {},
    arrayIdRefs: [{ path: "availability.branchIds", target: "Branch" }],
    sanitize: (doc) => {
      doc.createdBy = null;
    },
  },
  Scheme: {
    idRefs: { branchId: "Branch", customerId: "Customer", planId: "SchemePlan" },
    sanitize: (doc) => {
      doc.createdBy = null;
    },
  },
  LedgerEntry: {
    idRefs: {
      branchId: "Branch",
      schemeId: "Scheme",
      customerId: "Customer",
      // Payment is cloned in this slice too, so a ledger entry's receipt reference can be
      // remapped rather than discarded; redemptionId has nowhere to point (Redemption is
      // out of scope this slice) and is always nulled.
      paymentId: "Payment",
    },
    sanitize: (doc) => {
      doc.redemptionId = null;
      doc.actorId = null;
    },
  },
  Payment: {
    idRefs: { branchId: "Branch", schemeId: "Scheme", customerId: "Customer" },
    sanitize: (doc) => {
      // Plan section 5.2: "Do not copy raw provider transaction IDs, merchant-order IDs or
      // refund IDs into operational identifier fields." None of these are regenerated with a
      // demo-prefixed id in this slice because nothing reads them for a demo tenant (no
      // reconcile/settlement worker runs against isDemo tenants yet per demo-policy.js) —
      // they are simply cleared rather than replaced with a look-alike identifier, which is
      // the safer of the two options until that worker-side exclusion is verified end-to-end.
      doc.providerTransactionId = null;
      doc.gatewayMerchantOrderId = null;
      doc.providerPayload = null;
      doc.gatewayReconcileNextAt = null;
      doc.gatewayReconcileLeaseOwner = null;
      doc.gatewayReconcileLeaseExpiresAt = null;
      doc.gatewayReconcileAttempts = 0;
      doc.requiresReview = false;
      doc.reviewReason = null;
      doc.collectedBy = null;
    },
  },
});

/** Deterministic, tenant-scoped-unique synthetic mobile derived from the new customer id. */
function syntheticMobileFrom(newCustomerId) {
  let hash = 0;
  for (let i = 0; i < newCustomerId.length; i += 1) {
    hash = (hash * 31 + newCustomerId.charCodeAt(i)) % 1_000_000_000;
  }
  const nineDigits = String(hash).padStart(9, "0").slice(-9);
  return `9${nineDigits}`;
}
