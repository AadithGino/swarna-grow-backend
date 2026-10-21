import { AppError } from "./app-error.js";
import { isPlanFeatureEnabled } from "./feature-entitlements.js";
import {
  customerHasDigitalMetalLegacyAccess,
  tenantHasDigitalMetalLegacyActivity,
} from "./digital-metals-activity.js";

export const DIGITAL_METALS_PLAN_FEATURE = "digitalMetals";

export function presentDigitalMetalsAccessState(tenant) {
  const planEntitled = isPlanFeatureEnabled(tenant, DIGITAL_METALS_PLAN_FEATURE);
  const enabled = tenant?.operations?.digitalMetalsEnabled === true;
  const paused = isDigitalMetalsPaused(tenant);
  return {
    planEntitled,
    enabled,
    paused,
    active: planEntitled && enabled && !paused,
  };
}

export function isDigitalMetalsPaused(tenant) {
  return (
    tenant?.operations?.digitalMetalsPaused === true
    || tenant?.operations?.digitalMetalsPlatformPaused === true
  );
}

export async function presentDigitalMetalsAccessStateForTenant(tenant) {
  const base = presentDigitalMetalsAccessState(tenant);
  const hasLegacyActivity = tenant?._id
    ? await tenantHasDigitalMetalLegacyActivity(tenant._id)
    : false;
  return { ...base, hasLegacyActivity };
}

export function assertCanEnableDigitalMetalsModule(tenant) {
  if (isPlanFeatureEnabled(tenant, DIGITAL_METALS_PLAN_FEATURE)) return;
  throw new AppError(
    "FEATURE_NOT_ENTITLED",
    "Your subscription plan does not include Digital Gold & Silver.",
    403,
    { feature: DIGITAL_METALS_PLAN_FEATURE },
  );
}

export async function customerDigitalMetalLegacyContext(tenantId, customerId) {
  const hasLegacyAccess = await customerHasDigitalMetalLegacyAccess(tenantId, customerId);
  return {
    hasHoldings: hasLegacyAccess.kinds.includes("HOLDINGS"),
    hasOpenSettlement: hasLegacyAccess.kinds.includes("SETTLEMENT"),
    hasOpenFulfilment: hasLegacyAccess.kinds.includes("FULFILMENT"),
    hasLegacyAccess: hasLegacyAccess.any,
  };
}
