const POLICY_MIN_LENGTH = 40;

function approved(text, approvedAt) {
  return String(text ?? "").trim().length >= POLICY_MIN_LENGTH && Boolean(approvedAt);
}

export function mapPublishedStorePolicies(row) {
  const p = row?.storePolicies ?? {};
  return {
    version: Number(p.version ?? 0),
    publishedAt: p.publishedAt ?? null,
    shippingPolicyText: p.shippingPolicyText ?? "",
    returnsPolicyText: p.returnsPolicyText ?? "",
    cancellationPolicyText: p.cancellationPolicyText ?? "",
    refundContactPolicyText: p.refundContactPolicyText ?? "",
    returnEligibilityDays: Number(p.returnEligibilityDays ?? 0),
    returnExcludedCategoryIds: p.returnExcludedCategoryIds ?? [],
    ready:
      approved(p.shippingPolicyText, p.shippingPolicyApprovedAt)
      && approved(p.returnsPolicyText, p.returnsPolicyApprovedAt)
      && approved(p.cancellationPolicyText, p.cancellationPolicyApprovedAt)
      && approved(p.refundContactPolicyText, p.refundContactPolicyApprovedAt),
  };
}

export function evaluateStorePolicyCheckoutBlockers(fulfilmentSettingsRow) {
  const mapped = mapPublishedStorePolicies(fulfilmentSettingsRow);
  if (mapped.ready) return [];
  return [
    {
      code: "STORE_POLICIES_NOT_PUBLISHED",
      message:
        "Shipping, returns, cancellation, and refund contact policies must be entered and approved before checkout.",
    },
  ];
}

export function snapshotStorePolicyForOrder(fulfilmentSettingsRow) {
  const mapped = mapPublishedStorePolicies(fulfilmentSettingsRow);
  if (!mapped.ready) return null;
  return { version: mapped.version, publishedAt: mapped.publishedAt ?? new Date() };
}
