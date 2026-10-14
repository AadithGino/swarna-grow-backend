import {
  EcommerceBannerDestination,
  EcommerceBannerPlacement,
  EcommerceProductStatus,
} from "../constants/enums.js";

export function destinationRequiresOperationalStore(destinationType) {
  return (
    destinationType === EcommerceBannerDestination.SHOP
    || destinationType === EcommerceBannerDestination.CATEGORY
    || destinationType === EcommerceBannerDestination.PRODUCT
  );
}
import { EcommerceCategory, EcommerceProduct } from "../models/index.js";

export function isBannerInSchedule(row, now = new Date()) {
  if (row.startsAt && now < new Date(row.startsAt)) return false;
  if (row.endsAt && now > new Date(row.endsAt)) return false;
  return true;
}

export function placementIncludes(placement, surface) {
  if (placement === EcommerceBannerPlacement.BOTH) return true;
  return placement === surface;
}

export async function isBannerTargetAvailable(tenantId, row) {
  if (row.destinationType === EcommerceBannerDestination.CATEGORY) {
    if (!row.targetCategoryId) return false;
    const category = await EcommerceCategory.findOne({
      _id: row.targetCategoryId,
      tenantId,
      active: true,
    }).lean();
    return Boolean(category);
  }
  if (row.destinationType === EcommerceBannerDestination.PRODUCT) {
    if (!row.targetProductId) return false;
    const product = await EcommerceProduct.findOne({
      _id: row.targetProductId,
      tenantId,
      status: EcommerceProductStatus.PUBLISHED,
    }).lean();
    if (!product) return false;
    if (!product.categoryId) return true;
    const category = await EcommerceCategory.findOne({
      _id: product.categoryId,
      tenantId,
      active: true,
    }).lean();
    return Boolean(category);
  }
  return true;
}
