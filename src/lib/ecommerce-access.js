import { AppError } from "./app-error.js";
import { isPlanFeatureEnabled } from "./feature-entitlements.js";

/** Canonical subscription plan feature key for online store entitlement. */
export const ECOMMERCE_PLAN_FEATURE = "ecommerce";

export function presentEcommerceAccessState(tenant) {
  const planEntitled = isPlanFeatureEnabled(tenant, ECOMMERCE_PLAN_FEATURE);
  const enabled = tenant?.operations?.ecommerceEnabled === true;
  return {
    planEntitled,
    enabled,
    active: planEntitled && enabled,
  };
}

export function isEcommerceOperational(tenant) {
  return presentEcommerceAccessState(tenant).active;
}

export function assertCanEnableEcommerceStore(tenant) {
  if (isPlanFeatureEnabled(tenant, ECOMMERCE_PLAN_FEATURE)) return;
  throw new AppError(
    "FEATURE_NOT_ENTITLED",
    "Your subscription plan does not include ecommerce. Upgrade your plan to enable the online store.",
    403,
    { feature: ECOMMERCE_PLAN_FEATURE },
  );
}

export function assertEcommerceOperational(tenant, message) {
  const state = presentEcommerceAccessState(tenant);
  if (state.active) return;
  throw new AppError(
    "ECOMMERCE_NOT_AVAILABLE",
    message ?? "Online store is not active for this jeweller.",
    403,
    { ecommerce: state },
  );
}

/** Catalog/pricing writes require plan ecommerce entitlement (store switch may be off). */
export function assertEcommerceCatalogWrite(tenant) {
  if (isPlanFeatureEnabled(tenant, ECOMMERCE_PLAN_FEATURE)) return;
  throw new AppError(
    "FEATURE_NOT_ENTITLED",
    "Your subscription plan does not include ecommerce catalog management.",
    403,
    { feature: ECOMMERCE_PLAN_FEATURE },
  );
}

export function isEcommerceCatalogWriteAllowed(tenant) {
  return isPlanFeatureEnabled(tenant, ECOMMERCE_PLAN_FEATURE);
}
