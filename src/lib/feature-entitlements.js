import { AppError } from "./app-error.js";
import { PlanTier } from "../constants/enums.js";
import {
  DEFAULT_PLATFORM_FEATURE_FLAGS,
  normalizeFeatureFlags,
  PLATFORM_FEATURE_FLAG_KEYS,
} from "../constants/platform-feature-flags.js";
import { DEFAULT_PLAN_FEATURES, normalizePlanFeatures } from "../constants/plan-features.js";
import { subscriptionCatalogPlanFromTenant } from "./subscription-plan-for-tenant.js";

const PLAN_FEATURE_KEYS = new Set(
  Object.keys(DEFAULT_PLAN_FEATURES[PlanTier.STARTER]),
);

/** Platform kill-switch keys that also require a plan entitlement. */
export const OVERLAP_PLATFORM_TO_PLAN = Object.freeze({
  customerSelfEnrol: "customerSelfEnrol",
  flexibleScheme: "flexibleScheme",
});

/** Display-only mapping for platform UI; runtime uses plan `advancedReports` where needed. */
export const PLATFORM_PASSBOOK_TO_PLAN = Object.freeze({
  passbookImageOnPayment: "advancedReports",
});

function planFeatureBase(tenant) {
  const tier = tenant?.subscription?.tier ?? PlanTier.STARTER;
  const tierDefaults = normalizePlanFeatures(null, tier);
  const catalogPlan = subscriptionCatalogPlanFromTenant(tenant);
  if (!catalogPlan) return tierDefaults;
  return {
    ...tierDefaults,
    ...normalizePlanFeatures(catalogPlan.features, tier),
  };
}

export function resolvePlanFeatureBooleans(tenant) {
  const base = planFeatureBase(tenant);
  const snapshot = tenant?.subscription?.planFeaturesSnapshot;
  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    const merged = { ...base, ...snapshot };
    const overrides = tenant?.subscription?.featureOverrides ?? {};
    for (const [key, value] of Object.entries(overrides)) {
      if (PLAN_FEATURE_KEYS.has(key)) merged[key] = Boolean(value);
    }
    return merged;
  }
  const map = { ...base };
  const enabled = new Set(tenant?.subscription?.features ?? []);
  for (const key of enabled) {
    if (PLAN_FEATURE_KEYS.has(key)) map[key] = true;
  }
  const overrides = tenant?.subscription?.featureOverrides ?? {};
  for (const [key, value] of Object.entries(overrides)) {
    if (PLAN_FEATURE_KEYS.has(key)) map[key] = Boolean(value);
  }
  return map;
}

export function resolvePlatformFlags(tenant) {
  return normalizeFeatureFlags(tenant?.featureFlags);
}

export function isPlanFeatureEnabled(tenant, featureKey) {
  return resolvePlanFeatureBooleans(tenant)[featureKey] === true;
}

export function isPlatformFlagEnabled(tenant, flagKey) {
  if (!PLATFORM_FEATURE_FLAG_KEYS.includes(flagKey)) return false;
  return resolvePlatformFlags(tenant)[flagKey] === true;
}

export function isOverlappingFeatureEnabled(tenant, platformKey) {
  const planKey =
    OVERLAP_PLATFORM_TO_PLAN[platformKey]
    ?? PLATFORM_PASSBOOK_TO_PLAN[platformKey];
  if (!planKey) return isPlatformFlagEnabled(tenant, platformKey);
  return isPlanFeatureEnabled(tenant, planKey) && isPlatformFlagEnabled(tenant, platformKey);
}

export function effectivePlatformFlags(tenant) {
  const effective = {};
  for (const key of PLATFORM_FEATURE_FLAG_KEYS) {
    if (OVERLAP_PLATFORM_TO_PLAN[key] || PLATFORM_PASSBOOK_TO_PLAN[key]) {
      effective[key] = isOverlappingFeatureEnabled(tenant, key);
    } else {
      effective[key] = isPlatformFlagEnabled(tenant, key);
    }
  }
  return effective;
}

export function planFeaturesSnapshotFromPlan(plan) {
  const tier = plan?.tier ?? PlanTier.STARTER;
  return normalizePlanFeatures(plan?.features, tier);
}

export function assertFeatureEntitled(tenant, featureKey, message) {
  const overlapPlatformKey = Object.entries(OVERLAP_PLATFORM_TO_PLAN).find(
    ([, planKey]) => planKey === featureKey,
  )?.[0];
  if (overlapPlatformKey) {
    if (isOverlappingFeatureEnabled(tenant, overlapPlatformKey)) return;
    throw new AppError(
      "FEATURE_NOT_ENTITLED",
      message ?? `Your plan does not include ${featureKey}.`,
      403,
      { feature: featureKey },
    );
  }
  if (isPlanFeatureEnabled(tenant, featureKey)) return;
  throw new AppError(
    "FEATURE_NOT_ENTITLED",
    message ?? `Your plan does not include ${featureKey}.`,
    403,
    { feature: featureKey },
  );
}

export function assertPlatformCapability(tenant, capabilityKey, message) {
  const labels = {
    onlinePayments: "Online payments",
    staffAppEnabled: "Staff app access",
    customerAppEnabled: "Customer app access",
  };
  if (!PLATFORM_FEATURE_FLAG_KEYS.includes(capabilityKey)) {
    throw new AppError("PLATFORM_CAPABILITY_UNKNOWN", "Unknown platform capability.", 500);
  }
  if (OVERLAP_PLATFORM_TO_PLAN[capabilityKey] || PLATFORM_PASSBOOK_TO_PLAN[capabilityKey]) {
    if (isOverlappingFeatureEnabled(tenant, capabilityKey)) return;
  } else if (isPlatformFlagEnabled(tenant, capabilityKey)) {
    return;
  }
  throw new AppError(
    "PLATFORM_CAPABILITY_DISABLED",
    message ?? `${labels[capabilityKey] ?? capabilityKey} is disabled for this jewellery.`,
    403,
    { capability: capabilityKey },
  );
}

export { DEFAULT_PLATFORM_FEATURE_FLAGS };
