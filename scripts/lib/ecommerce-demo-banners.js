import {
  EcommerceBannerDestination,
  EcommerceBannerPlacement,
  EcommerceBannerStatus,
} from "../../src/constants/enums.js";
import { EcommerceBanner } from "../../src/models/index.js";
import * as banners from "../../src/services/ecommerce-banner.service.js";
import { ensureDemoBannerImageUpload } from "./ecommerce-demo-images.js";

const DEMO_SEED_TAG = "swarnagrow-ecommerce-demo-seed v1";

function bannerKeyMarker(key) {
  return `[demo-banner-key:${key}]`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildDemoBannerSpecs(tenantCode, { categoryIds, productIds }) {
  const code = String(tenantCode).trim().toUpperCase();
  return [
    {
      key: "home-schemes",
      title: `${code} — Grow your gold`,
      subtitle: "Open schemes from home",
      placement: EcommerceBannerPlacement.HOME,
      destinationType: EcommerceBannerDestination.SCHEMES,
      displayOrder: 0,
      publish: true,
    },
    {
      key: "home-shop-teaser",
      title: `${code} — Online collection`,
      subtitle: "Visible when store is on; hidden when store is off",
      placement: EcommerceBannerPlacement.HOME,
      destinationType: EcommerceBannerDestination.SHOP,
      displayOrder: 5,
      publish: true,
    },
    {
      key: "shop-featured-product",
      title: `${code} — Featured piece`,
      subtitle: "Shop product banner",
      placement: EcommerceBannerPlacement.SHOP,
      destinationType: EcommerceBannerDestination.PRODUCT,
      targetProductId: productIds["fixed-featured-sale"],
      displayOrder: 0,
      publish: true,
    },
    {
      key: "both-rings-category",
      title: `${code} — Rings edit`,
      subtitle: "Home + shop category promo",
      placement: EcommerceBannerPlacement.BOTH,
      destinationType: EcommerceBannerDestination.CATEGORY,
      targetCategoryId: categoryIds.rings,
      displayOrder: 10,
      publish: true,
    },
    {
      key: "draft-poster",
      title: `${code} — Draft poster`,
      subtitle: "Should not appear to customers",
      placement: EcommerceBannerPlacement.HOME,
      destinationType: EcommerceBannerDestination.NONE,
      displayOrder: 99,
      publish: false,
    },
  ];
}

async function findDemoBanner(tenantId, key) {
  const needle = `demo-banner-key:${key}`;
  return EcommerceBanner.findOne({
    tenantId,
    subtitle: { $regex: escapeRegex(needle) },
  }).lean();
}

export async function upsertDemoBanners(req, tenantCode, ctx, dryRun, report) {
  const { categoryIds, productIds } = ctx;
  report.banners = report.banners ?? [];
  const specs = buildDemoBannerSpecs(tenantCode, { categoryIds, productIds });

  for (const spec of specs) {
    if (spec.destinationType === EcommerceBannerDestination.PRODUCT && !spec.targetProductId) {
      report.banners.push({ key: spec.key, action: "skipped", reason: "missing_product_target" });
      continue;
    }
    if (spec.destinationType === EcommerceBannerDestination.CATEGORY && !spec.targetCategoryId) {
      report.banners.push({ key: spec.key, action: "skipped", reason: "missing_category_target" });
      continue;
    }

    const subtitle = `${spec.subtitle}\n${bannerKeyMarker(spec.key)}\n[${DEMO_SEED_TAG}]`;
    const body = {
      title: spec.title,
      subtitle,
      placement: spec.placement,
      displayOrder: spec.displayOrder,
      destinationType: spec.destinationType,
      targetCategoryId: spec.targetCategoryId ?? null,
      targetProductId: spec.targetProductId ?? null,
    };

    if (dryRun) {
      report.banners.push({ key: spec.key, action: "would_upsert", ...body, publish: spec.publish });
      continue;
    }

    let row = await findDemoBanner(req.auth.tenantId, spec.key);
    let uploadId;
    try {
      uploadId = await ensureDemoBannerImageUpload({
        tenantId: req.auth.tenantId,
        ownerUserId: req.auth.id,
        bannerKey: spec.key,
      });
    } catch (err) {
      report.banners.push({ key: spec.key, action: "error", error: err.message });
      continue;
    }

    if (row) {
      const patched = await banners.patchBanner({
        ...req,
        params: { bannerId: row._id },
        body: {
          ...body,
          imageUploadId: uploadId,
          expectedVersion: row.version,
        },
      });
      row = patched;
      report.banners.push({ key: spec.key, action: "updated", id: patched.id, status: patched.status });
    } else {
      const created = await banners.createBanner({
        ...req,
        body: { ...body, imageUploadId: uploadId },
      });
      row = created;
      report.banners.push({ key: spec.key, action: "created", id: created.id, status: created.status });
    }

    if (spec.publish && row.status !== EcommerceBannerStatus.PUBLISHED) {
      const fresh = await banners.getBanner({ ...req, params: { bannerId: row.id } });
      const published = await banners.publishBanner({
        ...req,
        params: { bannerId: row.id },
        body: { expectedVersion: fresh.version },
      });
      report.banners.push({
        key: spec.key,
        action: "published",
        id: published.id,
        status: published.status,
      });
    } else if (!spec.publish && row.status === EcommerceBannerStatus.PUBLISHED) {
      const fresh = await banners.getBanner({ ...req, params: { bannerId: row.id } });
      await banners.unpublishBanner({
        ...req,
        params: { bannerId: row.id },
        body: { expectedVersion: fresh.version },
      });
    }
  }
}
