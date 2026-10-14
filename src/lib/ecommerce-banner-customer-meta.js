import {
  EcommerceBannerPlacement,
  EcommerceBannerStatus,
} from "../constants/enums.js";
import { EcommerceBanner } from "../models/index.js";
import { ECOMMERCE_PLAN_FEATURE, isEcommerceOperational } from "./ecommerce-access.js";
import { isPlanFeatureEnabled } from "./feature-entitlements.js";
import {
  isBannerInSchedule,
  placementIncludes,
} from "./ecommerce-banner-utils.js";

/**
 * Earliest upcoming schedule boundary (start or end) for published banners on a surface,
 * including not-yet-visible promos. Does not expose unpublished rows.
 */
export function computeNextVisibilityChangeAt(rows, now = new Date()) {
  const t0 = now.getTime();
  let next = null;
  for (const row of rows) {
    if (!row.imageUploadId) continue;
    if (row.startsAt) {
      const startMs = new Date(row.startsAt).getTime();
      if (startMs > t0 && (next == null || startMs < next)) next = startMs;
    }
    if (row.endsAt) {
      const endMs = new Date(row.endsAt).getTime();
      if (endMs > t0 && isBannerInSchedule(row, now) && (next == null || endMs < next)) {
        next = endMs;
      }
    }
  }
  return next == null ? null : new Date(next).toISOString();
}

export async function loadPublishedBannersForSurface(tenantId, surface) {
  return EcommerceBanner.find({
    tenantId,
    status: EcommerceBannerStatus.PUBLISHED,
    $or: [{ placement: surface }, { placement: EcommerceBannerPlacement.BOTH }],
  })
    .sort({ displayOrder: 1, createdAt: 1, _id: 1 })
    .lean();
}

export function surfaceEligibleForRefresh(tenant, surface) {
  const planEntitled = isPlanFeatureEnabled(tenant, ECOMMERCE_PLAN_FEATURE);
  if (surface === EcommerceBannerPlacement.HOME) return planEntitled;
  if (surface === EcommerceBannerPlacement.SHOP) {
    return planEntitled && isEcommerceOperational(tenant);
  }
  return placementIncludes(surface, EcommerceBannerPlacement.HOME)
    ? planEntitled
    : isEcommerceOperational(tenant);
}
