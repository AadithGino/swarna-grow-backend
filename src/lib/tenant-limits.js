import { AppError } from "./app-error.js";
import { SubscriptionStatus } from "../constants/enums.js";
import { assertFeatureEntitled as assertPlanFeatureEntitled } from "./feature-entitlements.js";

/** Block authenticated access when subscription is cancelled or grace has expired. */
export function assertSubscriptionActive(tenant) {
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
