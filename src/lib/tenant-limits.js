import { AppError } from "./app-error.js";
import { SubscriptionStatus } from "../constants/enums.js";
import { assertFeatureEntitled as assertPlanFeatureEntitled } from "./feature-entitlements.js";

/** Block authenticated access when subscription is cancelled or grace has expired. */
export function assertSubscriptionActive(tenant) {
  // Demo tenants (plan section 3: "Demo tenants do not receive platform invoices or count
  // toward paid tenant... subscription revenue") have no real subscription at all. Today this
  // happens to pass anyway because tenantSchema.subscription defaults to { status: "TRIAL" }
  // with no trialEndsAt, so the TRIAL-expiry branch below never fires — but that is an
  // accident of defaults, not a guarantee, and this function is specifically the "single
  // trusted source" this module's checks run through. Make the exemption explicit instead of
  // relying on that accident.
  if (tenant?.isDemo) return;
  const sub = tenant?.subscription;
  if (!sub) return;
  if (sub.status === SubscriptionStatus.CANCELLED) {
    throw new AppError(
      "SUBSCRIPTION_CANCELLED",
      "This account's subscription has been cancelled.",
      403,
    );
  }
  if (
    sub.status === SubscriptionStatus.TRIAL &&
    sub.trialEndsAt &&
    new Date(sub.trialEndsAt).getTime() < Date.now()
  ) {
    throw new AppError("SUBSCRIPTION_TRIAL_EXPIRED", "This account's trial has expired.", 403);
  }
  if (
    sub.status === SubscriptionStatus.ACTIVE &&
    sub.renewsAt &&
    new Date(sub.renewsAt).getTime() < Date.now()
  ) {
    throw new AppError("SUBSCRIPTION_EXPIRED", "This account's subscription has expired.", 403);
  }
  if (
    sub.status === SubscriptionStatus.PAST_DUE &&
    (!sub.graceEndsAt || new Date(sub.graceEndsAt).getTime() < Date.now())
  ) {
    throw new AppError("SUBSCRIPTION_PAST_DUE", "This account's subscription payment is past due.", 403);
  }
  if (
    sub.status === SubscriptionStatus.GRACE &&
    (!sub.graceEndsAt || new Date(sub.graceEndsAt).getTime() < Date.now())
  ) {
    throw new AppError(
      "SUBSCRIPTION_CANCELLED",
      "The subscription grace period has ended.",
      403,
    );
  }
  if (sub.status === SubscriptionStatus.SUSPENDED) {
    throw new AppError(
      "SUBSCRIPTION_SUSPENDED",
      "This account's subscription is suspended.",
      403,
    );
  }
}

export function assertFeatureEntitled(tenant, featureKey, message) {
  return assertPlanFeatureEntitled(tenant, featureKey, message);
}

export function subscriptionLimit(tenant, key) {
  const limits = tenant?.subscription?.limits;
  if (!limits) return null;
  const raw = limits.toObject?.() ?? limits;
  return raw[key] ?? null;
}

export async function assertWithinLimit({
  tenant,
  limitKey,
  used,
  errorCode,
  label,
}) {
  const limit = subscriptionLimit(tenant, limitKey);
  if (limit == null || used < limit) return;
  throw new AppError(
    errorCode,
    `Your plan allows ${limit} ${label}.`,
    403,
    { limit, used, currentPlan: tenant.subscription?.tier },
  );
}
