import {
  EcommerceBannerDestination,
  EcommerceBannerPlacement,
  EcommerceBannerStatus,
  UploadStatus,
} from "../constants/enums.js";
import { EcommerceBanner } from "../models/index.js";
import { ECOMMERCE_PLAN_FEATURE } from "./ecommerce-access.js";
import { isPlanFeatureEnabled } from "./feature-entitlements.js";
import { customerHasEcommerceOrderHistory } from "./ecommerce-tenant-history.js";
import {
  destinationRequiresOperationalStore,
  isBannerInSchedule,
  isBannerTargetAvailable,
  placementIncludes,
} from "./ecommerce-banner-utils.js";

export async function isCustomerVisibleBannerUpload(upload, tenant, customerId) {
  if (upload.status === UploadStatus.PENDING || upload.status === UploadStatus.EXPIRED) return false;
  const row = await EcommerceBanner.findOne({
    tenantId: upload.tenantId,
    imageUploadId: upload._id,
    status: EcommerceBannerStatus.PUBLISHED,
  }).lean();
  if (!row || !isBannerInSchedule(row)) return false;

  const planEntitled = isPlanFeatureEnabled(tenant, ECOMMERCE_PLAN_FEATURE);
  const storeActive = tenant?.operations?.ecommerceEnabled === true && planEntitled;

  const homeEligible =
    planEntitled && placementIncludes(row.placement, EcommerceBannerPlacement.HOME);
  const shopEligible =
    storeActive && placementIncludes(row.placement, EcommerceBannerPlacement.SHOP);

  if (!homeEligible && !shopEligible) return false;
  if (destinationRequiresOperationalStore(row.destinationType) && !storeActive) {
    return false;
  }
  if (row.destinationType === EcommerceBannerDestination.ORDERS) {
    if (!customerId) return false;
    const hasHistory = await customerHasEcommerceOrderHistory(upload.tenantId, customerId);
    if (!hasHistory) return false;
  }
  return isBannerTargetAvailable(upload.tenantId, row);
}
