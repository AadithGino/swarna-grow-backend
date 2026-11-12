/**
 * Crop-backed Kairali jewellery catalog: necklaces / bangles / earrings with real photos.
 *
 * Assets: scripts/assets/kairali-jewellery/*.jpg (from temple-jewellery collage).
 *
 *   node --env-file=.env scripts/seed-kairali-jewellery-collage.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  EcommerceBannerDestination,
  EcommerceBannerPlacement,
  EcommerceBannerStatus,
  EcommercePriceMode,
  EcommerceProductStatus,
  EcommerceStockPolicy,
  TenantRole,
  UploadPurpose,
  UploadStatus,
  UserStatus,
} from "../src/constants/enums.js";
import { prefixStorageObjectKey, storageProvider } from "../src/integrations/storage.provider.js";
import { createId } from "../src/lib/ids.js";
import { attachSubscriptionCatalogPlan } from "../src/lib/subscription-plan-for-tenant.js";
import {
  EcommerceBanner,
  EcommerceCategory,
  EcommerceInventory,
  EcommerceProduct,
  Tenant,
  Upload,
  User,
} from "../src/models/index.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import * as bannerService from "../src/services/ecommerce-banner.service.js";
import {
  DEMO_TAX_CLASSIFICATION,
  ensureDemoDisplayTaxSettings,
} from "./lib/ecommerce-demo-tax.js";
import { ensureDemoCheckoutTaxConfig } from "./lib/ecommerce-demo-checkout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dirname, "assets/kairali-jewellery");
const BANNER_DIR = path.join(ASSET_DIR, "banners");
const TENANT_CODE = "KAIRALI";
const SLUG_PREFIX = "kairali-jewel-";
const SEED_TAG = "kairali-jewellery-collage-v1";
const BANNER_KEY_PREFIX = "kairali-jewel-banner:";

const CATEGORIES = [
  {
    key: "necklaces",
    slug: `${SLUG_PREFIX}necklaces`,
    name: "Necklaces",
    displayOrder: 10,
    imageFile: "01-peacock-choker.jpg",
  },
  {
    key: "bangles",
    slug: `${SLUG_PREFIX}bangles`,
    name: "Bangles",
    displayOrder: 20,
    imageFile: "05-floral-kada.jpg",
  },
  {
    key: "earrings",
    slug: `${SLUG_PREFIX}earrings`,
    name: "Earrings",
    displayOrder: 30,
    imageFile: "09-leaf-earrings.jpg",
  },
];

const PRODUCTS = [
  {
    key: "peacock-choker",
    file: "01-peacock-choker.jpg",
    categoryKey: "necklaces",
    name: "Temple Peacock Choker",
    sku: "KJR-NCK-PEACOCK",
    basePricePaise: 1_85_000_00,
    featured: true,
    description:
      "Broad temple-style peacock choker with intricate filigree and beaded fringe — bridal favourite.",
  },
  {
    key: "manga-mala",
    file: "02-manga-mala.jpg",
    categoryKey: "necklaces",
    name: "Manga Mala Bead Necklace",
    sku: "KJR-NCK-MANGA",
    basePricePaise: 1_42_000_00,
    featured: true,
    description: "Classic double-strand bead mala with mango (manga) pendants.",
  },
  {
    key: "mesh-choker",
    file: "03-mesh-choker.jpg",
    categoryKey: "necklaces",
    name: "Mesh Weave Choker",
    sku: "KJR-NCK-MESH",
    basePricePaise: 98_500_00,
    featured: false,
    description: "Rigid mesh-texture gold choker with dense woven craftsmanship.",
  },
  {
    key: "teardrop-pendant",
    file: "04-teardrop-pendant.jpg",
    categoryKey: "necklaces",
    name: "Teardrop Pendant Necklace",
    sku: "KJR-NCK-TEAR",
    basePricePaise: 76_000_00,
    featured: false,
    description: "Long bead chain with ornate teardrop pendant — everyday festive wear.",
  },
  {
    key: "floral-kada",
    file: "05-floral-kada.jpg",
    categoryKey: "bangles",
    name: "Floral Cutwork Kada Pair",
    sku: "KJR-BNG-FLORAL",
    basePricePaise: 1_18_000_00,
    featured: true,
    description: "Wide openwork floral kada pair with beaded borders.",
  },
  {
    key: "engraved-bangles",
    file: "06-engraved-bangles.jpg",
    categoryKey: "bangles",
    name: "Engraved Slim Bangle Pair",
    sku: "KJR-BNG-ENGRAVE",
    basePricePaise: 64_500_00,
    featured: false,
    description: "Slim engraved bangle pair with vine and floral surface work.",
  },
  {
    key: "twisted-rope-bangles",
    file: "07-twisted-rope-bangles.jpg",
    categoryKey: "bangles",
    name: "Twisted Rope Bangle Pair",
    sku: "KJR-BNG-ROPE",
    basePricePaise: 72_000_00,
    featured: false,
    description: "Twisted-rope gold bangles with decorative end caps.",
  },
  {
    key: "temple-bangles",
    file: "08-temple-bangles.jpg",
    categoryKey: "bangles",
    name: "Temple Motif Bangle Pair",
    sku: "KJR-BNG-TEMPLE",
    basePricePaise: 1_05_000_00,
    featured: true,
    description: "Wide temple-motif bangles with arched deity alcoves.",
  },
  {
    key: "leaf-earrings",
    file: "09-leaf-earrings.jpg",
    categoryKey: "earrings",
    name: "Layered Leaf Earrings",
    sku: "KJR-EAR-LEAF",
    basePricePaise: 38_900_00,
    featured: true,
    description: "Statement layered-leaf stud earrings with textured gold finish.",
  },
];

/** Home / shop banners built from the same collage crops. */
const BANNERS = [
  {
    key: "home-collection-hero",
    file: "home-collection-hero.jpg",
    title: "Temple jewellery, crafted for you",
    subtitle: "Shop necklaces, bangles & earrings online",
    placement: EcommerceBannerPlacement.HOME,
    destinationType: EcommerceBannerDestination.SHOP,
    displayOrder: 0,
  },
  {
    key: "home-peacock-bridal",
    file: "home-peacock-bridal.jpg",
    title: "Bridal peacock choker",
    subtitle: "Featured temple necklace",
    placement: EcommerceBannerPlacement.HOME,
    destinationType: EcommerceBannerDestination.PRODUCT,
    productSlug: `${SLUG_PREFIX}peacock-choker`,
    displayOrder: 10,
  },
  {
    key: "home-bangles-edit",
    file: "home-bangles-edit.jpg",
    title: "Bangles & kadas",
    subtitle: "Traditional pairs for every occasion",
    placement: EcommerceBannerPlacement.BOTH,
    destinationType: EcommerceBannerDestination.CATEGORY,
    categoryKey: "bangles",
    displayOrder: 20,
  },
  {
    key: "home-earrings-edit",
    file: "home-earrings-edit.jpg",
    title: "Statement earrings",
    subtitle: "Layered leaf gold studs",
    placement: EcommerceBannerPlacement.HOME,
    destinationType: EcommerceBannerDestination.CATEGORY,
    categoryKey: "earrings",
    displayOrder: 30,
  },
  {
    key: "shop-manga-mala",
    file: "shop-manga-mala.jpg",
    title: "Manga mala collection",
    subtitle: "Classic bead necklaces",
    placement: EcommerceBannerPlacement.SHOP,
    destinationType: EcommerceBannerDestination.PRODUCT,
    productSlug: `${SLUG_PREFIX}manga-mala`,
    displayOrder: 5,
  },
];

function bannerKeyMarker(key) {
  return `[${BANNER_KEY_PREFIX}${key}]`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertAssets() {
  for (const p of PRODUCTS) {
    const full = path.join(ASSET_DIR, p.file);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing asset ${full}`);
    }
  }
  for (const b of BANNERS) {
    const full = path.join(BANNER_DIR, b.file);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing banner asset ${full}`);
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
    headers: { "user-agent": "seed-kairali-jewellery-collage" },
    ip: "127.0.0.1",
  };
}

async function createUploadFromFile({ tenantId, ownerId, purpose, filePath, fileName, attachedEntityType }) {
  const buf = fs.readFileSync(filePath);
  const uploadId = createId("upload");
  const objectKey = prefixStorageObjectKey(
    `${tenantId}/${purpose.toLowerCase()}/${uploadId}/${fileName}.jpg`,
  );
  await storageProvider.uploadFile({
    objectKey,
    body: buf,
    contentType: "image/jpeg",
  });
  await Upload.create({
    _id: uploadId,
    tenantId,
    ownerId,
    purpose,
    fileName: `${fileName}.jpg`,
    contentType: "image/jpeg",
    sizeBytes: buf.length,
    objectKey,
    status: UploadStatus.UPLOADED,
    attachedEntityType: attachedEntityType ?? null,
    expiresAt: new Date(Date.now() + 365 * 86_400_000),
  });
  return uploadId;
}

async function upsertCategory(req, spec, imageUploadId) {
  const existing = await EcommerceCategory.findOne({
    tenantId: req.auth.tenantId,
    slug: spec.slug,
  });
  const description = `${spec.name} from Kairali temple jewellery collage. [${SEED_TAG}]`;
  if (existing) {
    existing.name = spec.name;
    existing.description = description;
    existing.displayOrder = spec.displayOrder;
    existing.active = true;
    existing.imageUploadId = imageUploadId;
    existing.version = (existing.version ?? 0) + 1;
    await existing.save();
    return { id: existing._id, action: "updated" };
  }
  const created = await ecommerce.createCategory({
    ...req,
    body: {
      name: spec.name,
      slug: spec.slug,
      description,
      displayOrder: spec.displayOrder,
      active: true,
      imageUploadId,
    },
  });
  return { id: created.id, action: "created" };
}

async function upsertProduct(req, spec, categoryId, imageUploadId, taxClassification) {
  const slug = `${SLUG_PREFIX}${spec.key}`;
  const existing = await EcommerceProduct.findOne({
    tenantId: req.auth.tenantId,
    slug,
  });
  const description = `${spec.description}\n\n[${SEED_TAG}]`;
  const pricingBody = {
    name: spec.name,
    slug,
    sku: spec.sku,
    description,
    categoryId,
    featured: spec.featured,
    priceMode: EcommercePriceMode.FIXED,
    fixedPricing: { basePricePaise: spec.basePricePaise },
    taxClassification,
    imageUploadIds: [imageUploadId],
  };

  let productId;
  let action;
  if (existing) {
    if (!String(existing.slug).startsWith(SLUG_PREFIX)) {
      throw new Error(`Refusing to overwrite non-collage product ${existing.slug}`);
    }
    await ecommerce.patchProduct({
      ...req,
      params: { productId: existing._id },
      body: {
        expectedVersion: existing.version ?? 1,
        ...pricingBody,
        status: existing.status === EcommerceProductStatus.ARCHIVED
          ? EcommerceProductStatus.DRAFT
          : undefined,
      },
    });
    productId = existing._id;
    action = "updated";
  } else {
    const created = await ecommerce.createProduct({
      ...req,
      body: pricingBody,
    });
    productId = created.id;
    action = "created";
  }

  const fresh = await EcommerceProduct.findById(productId);
  if (fresh.status !== EcommerceProductStatus.PUBLISHED) {
    await ecommerce.patchProduct({
      ...req,
      params: { productId },
      body: {
        expectedVersion: fresh.version ?? 1,
        status: EcommerceProductStatus.PUBLISHED,
      },
    });
  }

  await EcommerceInventory.findOneAndUpdate(
    { tenantId: req.auth.tenantId, productId },
    {
      $set: {
        stockPolicy: EcommerceStockPolicy.MADE_TO_ORDER,
        quantityOnHand: null,
      },
      $setOnInsert: {
        _id: createId("einv"),
        tenantId: req.auth.tenantId,
        productId,
        version: 1,
      },
    },
    { upsert: true },
  );

  return { id: productId, slug, action, status: "PUBLISHED" };
}

async function upsertBanner(req, spec, { categoryIds, productIdBySlug }) {
  const imageUploadId = await createUploadFromFile({
    tenantId: req.auth.tenantId,
    ownerId: req.auth.id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
    filePath: path.join(BANNER_DIR, spec.file),
    fileName: `kairali-banner-${spec.key}`,
    attachedEntityType: "ECOMMERCE_BANNER",
  });

  const marker = bannerKeyMarker(spec.key);
  const subtitle = `${spec.subtitle} ${marker}`.slice(0, 200);
  const targetCategoryId = spec.categoryKey ? categoryIds[spec.categoryKey] ?? null : null;
  const targetProductId = spec.productSlug
    ? productIdBySlug.get(spec.productSlug) ?? null
    : null;

  if (spec.destinationType === EcommerceBannerDestination.CATEGORY && !targetCategoryId) {
    return { key: spec.key, action: "skipped", reason: "missing_category" };
  }
  if (spec.destinationType === EcommerceBannerDestination.PRODUCT && !targetProductId) {
    return { key: spec.key, action: "skipped", reason: "missing_product" };
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
    row = await bannerService.createBanner({
      ...req,
      body,
    });
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

  return {
    key: spec.key,
    action,
    id: row.id,
    status: row.status,
    placement: spec.placement,
    title: spec.title,
  };
}

async function main() {
  assertAssets();
  await connectDatabase();

  const tenant = await Tenant.findOne({ code: TENANT_CODE });
  if (!tenant) throw new Error("KAIRALI tenant not found — run seed:demo first");

  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "operations.ecommerceEnabled": true } },
  );

  const owner = await User.findOne({
    tenantId: tenant._id,
    role: TenantRole.TENANT_OWNER,
    status: UserStatus.ACTIVE,
  }).lean();
  if (!owner) throw new Error("KAIRALI owner user missing");

  const req = await buildAdminReq(tenant.toObject(), owner._id);
  const report = { tax: null, categories: [], products: [], banners: [], images: [] };

  const taxClassification =
    (await ensureDemoDisplayTaxSettings(req, false, report)) ?? DEMO_TAX_CLASSIFICATION;
  await ensureDemoCheckoutTaxConfig(req, {
    dryRun: false,
    report,
    itemClassification: taxClassification,
    registeredState: "Kerala",
  });

  const categoryIds = {};
  for (const cat of CATEGORIES) {
    const uploadId = await createUploadFromFile({
      tenantId: tenant._id,
      ownerId: owner._id,
      purpose: UploadPurpose.ECOMMERCE_CATEGORY_IMAGE,
      filePath: path.join(ASSET_DIR, cat.imageFile),
      fileName: `kairali-cat-${cat.key}`,
      attachedEntityType: "ECOMMERCE_CATEGORY",
    });
    report.images.push({ kind: "category", key: cat.key, uploadId });
    const upserted = await upsertCategory(req, cat, uploadId);
    categoryIds[cat.key] = upserted.id;
    report.categories.push({ ...upserted, slug: cat.slug, name: cat.name });
  }

  for (const product of PRODUCTS) {
    const uploadId = await createUploadFromFile({
      tenantId: tenant._id,
      ownerId: owner._id,
      purpose: UploadPurpose.ECOMMERCE_PRODUCT_IMAGE,
      filePath: path.join(ASSET_DIR, product.file),
      fileName: `kairali-prod-${product.key}`,
      attachedEntityType: "ECOMMERCE_PRODUCT",
    });
    report.images.push({ kind: "product", key: product.key, uploadId });
    const upserted = await upsertProduct(
      req,
      product,
      categoryIds[product.categoryKey],
      uploadId,
      taxClassification,
    );
    report.products.push(upserted);
  }

  const productIdBySlug = new Map(
    report.products.map((p) => [p.slug, p.id]),
  );
  for (const banner of BANNERS) {
    const upserted = await upsertBanner(req, banner, {
      categoryIds,
      productIdBySlug,
    });
    report.banners.push(upserted);
    if (upserted.id) {
      report.images.push({ kind: "banner", key: banner.key, bannerId: upserted.id });
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        tenantCode: TENANT_CODE,
        shopPath: "/customer/kairali/shop",
        homePath: "/customer/kairali",
        adminPath: "/admin/ecommerce/products",
        categories: report.categories,
        products: report.products,
        banners: report.banners,
        imageUploads: report.images.length,
        tax: report.tax,
      },
      null,
      2,
    )}\n`,
  );
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await disconnectDatabase();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
