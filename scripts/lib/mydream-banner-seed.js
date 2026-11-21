/**
 * MYDREAM home + shop promo banners (generated wide hero art).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EcommerceBannerDestination,
  EcommerceBannerPlacement,
  EcommerceBannerStatus,
  TenantRole,
  UploadPurpose,
  UploadStatus,
  UserStatus,
} from "../../src/constants/enums.js";
import { prefixStorageObjectKey, storageProvider } from "../../src/integrations/storage.provider.js";
import { createId } from "../../src/lib/ids.js";
import { attachSubscriptionCatalogPlan } from "../../src/lib/subscription-plan-for-tenant.js";
import { EcommerceBanner, EcommerceCategory, EcommerceProduct, Tenant, Upload, User } from "../../src/models/index.js";
import * as bannerService from "../../src/services/ecommerce-banner.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dirname, "../assets/my-dream-diamond/banners");
const TENANT_CODE = "MYDREAM";
const SLUG_PREFIX = "mydream-jewel-";
const BANNER_KEY_PREFIX = "mydream-promo-v2:";
const LEGACY_MARKER = "mydream-jewel-banner:";

const SPECS = [
  {
    key: "shop-hero",
    file: "mydream-home-shop-hero.jpg",
    title: "Discover fine jewellery online",
    subtitle: "Diamonds, gold & bridal picks — shop with transparent pricing",
    placement: EcommerceBannerPlacement.BOTH,
    destinationType: EcommerceBannerDestination.SHOP,
    displayOrder: 0,
  },
  {
    key: "schemes",
    file: "mydream-home-schemes.jpg",
    title: "₹5,000 monthly savings",
    subtitle: "11 instalments + 1 month free on maturity",
    placement: EcommerceBannerPlacement.HOME,
    destinationType: EcommerceBannerDestination.SCHEMES,
    displayOrder: 5,
  },
  {
    key: "bridal-necklaces",
    file: "mydream-home-bridal.jpg",
    title: "Bridal necklaces",
    subtitle: "Statement diamond pieces for your big day",
    placement: EcommerceBannerPlacement.HOME,
    destinationType: EcommerceBannerDestination.CATEGORY,
    categoryKey: "necklaces",
    displayOrder: 10,
  },
  {
    key: "shop-collection",
    file: "mydream-shop-collection.jpg",
    title: "The My Dream collection",
    subtitle: "Curated store favourites · secure PhonePe checkout",
    placement: EcommerceBannerPlacement.SHOP,
    destinationType: EcommerceBannerDestination.SHOP,
    displayOrder: 0,
  },
  {
    key: "shop-bangles",
    file: "mydream-shop-bangles.jpg",
    title: "Gold bangles & kadas",
    subtitle: "Traditional pairs · made to order",
    placement: EcommerceBannerPlacement.SHOP,
    destinationType: EcommerceBannerDestination.CATEGORY,
    categoryKey: "bangles",
    displayOrder: 15,
  },
  {
    key: "shop-earrings",
    file: "mydream-shop-earrings.jpg",
    title: "Diamond ear candy",
    subtitle: "Studs & drops from the online edit",
    placement: EcommerceBannerPlacement.BOTH,
    destinationType: EcommerceBannerDestination.CATEGORY,
    categoryKey: "earrings",
    displayOrder: 20,
  },
];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertAssets() {
  for (const spec of SPECS) {
    const full = path.join(ASSET_DIR, spec.file);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing banner asset ${full}. Run banner image generation or copy assets.`);
    }
  }
}

async function buildAdminReq(tenantLean, actorUserId) {
  const withCatalog = await attachSubscriptionCatalogPlan(tenantLean);
  return {
    auth: { tenantId: tenantLean._id, id: actorUserId },
    tenant: withCatalog,
    body: {},
    query: {},
    params: {},
    headers: { "user-agent": "mydream-banner-seed" },
    ip: "127.0.0.1",
  };
}

async function createUploadFromFile({ tenantId, ownerId, filePath, fileName }) {
  const buf = fs.readFileSync(filePath);
  const uploadId = createId("upload");
  const ext = path.extname(filePath) || ".jpg";
  const objectKey = prefixStorageObjectKey(
    `${tenantId}/${UploadPurpose.ECOMMERCE_BANNER_IMAGE.toLowerCase()}/${uploadId}/${fileName}${ext}`,
  );
  const contentType = ext === ".png" ? "image/png" : "image/jpeg";
  await storageProvider.uploadFile({ objectKey, body: buf, contentType });
  await Upload.create({
    _id: uploadId,
    tenantId,
    ownerId,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
    fileName: `${fileName}${ext}`,
    contentType,
    sizeBytes: buf.length,
    objectKey,
    status: UploadStatus.UPLOADED,
    attachedEntityType: "ECOMMERCE_BANNER",
    expiresAt: new Date(Date.now() + 365 * 86_400_000),
  });
  return uploadId;
}

async function archiveLegacyBanners(tenantId) {
  const legacy = await EcommerceBanner.find({
    tenantId,
    subtitle: { $regex: escapeRegex(LEGACY_MARKER) },
    status: { $ne: EcommerceBannerStatus.ARCHIVED },
  }).lean();
  if (!legacy.length) return 0;
  await EcommerceBanner.updateMany(
    { _id: { $in: legacy.map((r) => r._id) } },
    { $set: { status: EcommerceBannerStatus.ARCHIVED } },
  );
  return legacy.length;
}

async function upsertBanner(req, spec, targets) {
  const imageUploadId = await createUploadFromFile({
    tenantId: req.auth.tenantId,
    ownerId: req.auth.id,
    filePath: path.join(ASSET_DIR, spec.file),
    fileName: `mydream-banner-${spec.key}`,
  });

  const marker = `[${BANNER_KEY_PREFIX}${spec.key}]`;
  const subtitle = `${spec.subtitle} ${marker}`.slice(0, 200);

  let targetCategoryId = null;
  let targetProductId = null;
  if (spec.destinationType === EcommerceBannerDestination.CATEGORY && spec.categoryKey) {
    targetCategoryId = targets.categoryIds[spec.categoryKey] ?? null;
    if (!targetCategoryId) return { key: spec.key, action: "skipped", reason: "missing_category" };
  }
  if (spec.destinationType === EcommerceBannerDestination.PRODUCT && spec.productSlug) {
    targetProductId = targets.productIdBySlug.get(spec.productSlug) ?? null;
    if (!targetProductId) return { key: spec.key, action: "skipped", reason: "missing_product" };
  }

  const body = {
    title: spec.title,
    subtitle,
    placement: spec.placement,
    displayOrder: spec.displayOrder,
    destinationType: spec.destinationType,
    targetCategoryId,
    targetProductId,
    imageUploadId,
  };

  const existing = await EcommerceBanner.findOne({
    tenantId: req.auth.tenantId,
    subtitle: { $regex: escapeRegex(marker) },
  }).lean();

  let row;
  let action;
  if (existing) {
    row = await bannerService.patchBanner({
      ...req,
      params: { bannerId: existing._id },
      body: { ...body, expectedVersion: existing.version ?? 1 },
    });
    action = "updated";
  } else {
    row = await bannerService.createBanner({ ...req, body });
    action = "created";
  }

  if (row.status !== EcommerceBannerStatus.PUBLISHED) {
    const fresh = await bannerService.getBanner({
      ...req,
      params: { bannerId: row.id },
    });
    row = await bannerService.publishBanner({
      ...req,
      params: { bannerId: row.id },
      body: { expectedVersion: fresh.version },
    });
    action = `${action}+published`;
  }

  return { key: spec.key, action, id: row.id, placement: spec.placement, title: spec.title };
}

export async function seedMyDreamDiamondBanners() {
  assertAssets();
  const tenant = await Tenant.findOne({ code: TENANT_CODE });
  if (!tenant) throw new Error(`Tenant ${TENANT_CODE} not found — run seed:my-dream-diamond first.`);

  const owner = await User.findOne({
    tenantId: tenant._id,
    role: TenantRole.TENANT_OWNER,
    status: UserStatus.ACTIVE,
  }).lean();
  if (!owner) throw new Error("MYDREAM owner missing");

  const archived = await archiveLegacyBanners(tenant._id);

  const categories = await EcommerceCategory.find({ tenantId: tenant._id, slug: { $regex: `^${escapeRegex(SLUG_PREFIX)}` } }).lean();
  const categoryIds = {};
  for (const row of categories) {
    const key = row.slug.replace(SLUG_PREFIX, "");
    categoryIds[key] = row._id;
  }

  const products = await EcommerceProduct.find({ tenantId: tenant._id, slug: { $regex: `^${escapeRegex(SLUG_PREFIX)}` } }).lean();
  const productIdBySlug = new Map(products.map((p) => [p.slug, p._id]));

  const req = await buildAdminReq(tenant.toObject(), owner._id);
  const banners = [];
  for (const spec of SPECS) {
    banners.push(
      await upsertBanner(req, spec, {
        categoryIds,
        productIdBySlug,
      }),
    );
  }

  return { tenantCode: TENANT_CODE, archivedLegacy: archived, banners };
}