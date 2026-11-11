/**
 * Attach real jewellery photos (Unsplash) + publish banners for GROQUIKSOLUT demo store.
 *
 *   node --env-file=.env scripts/seed-groquiksolut-ecommerce-media.js
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  EcommerceBannerDestination,
  EcommerceBannerPlacement,
  EcommerceBannerStatus,
  EcommerceProductStatus,
  UploadPurpose,
  UploadStatus,
} from "../src/constants/enums.js";
import { prefixStorageObjectKey, storageProvider } from "../src/integrations/storage.provider.js";
import { createId } from "../src/lib/ids.js";
import {
  EcommerceBanner,
  EcommerceCategory,
  EcommerceProduct,
  Tenant,
  Upload,
  User,
} from "../src/models/index.js";

const TENANT_CODE = "GROQUIKSOLUT";

/** Royalty-free Unsplash jewellery photos (direct CDN). */
const IMAGES = {
  bannerHome: "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=1600&q=80",
  bannerShop: "https://images.unsplash.com/photo-1617038260897-41a1f14a8ca0?auto=format&fit=crop&w=1600&q=80",
  bannerRings: "https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&w=1600&q=80",
  bannerGold: "https://images.unsplash.com/photo-1573408301185-9146fe634ad0?auto=format&fit=crop&w=1600&q=80",
  pendant: "https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=1200&q=80",
  earrings: "https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=1200&q=80",
  ring: "https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&w=1200&q=80",
  chain: "https://images.unsplash.com/photo-1611591437281-460bfbe1220a?auto=format&fit=crop&w=1200&q=80",
  coin: "https://images.unsplash.com/photo-1610375461246-83df859d849d?auto=format&fit=crop&w=1200&q=80",
  bangle: "https://images.unsplash.com/photo-1611652022419-a9419f74343d?auto=format&fit=crop&w=1200&q=80",
  stones: "https://images.unsplash.com/photo-1602173574767-37ac01994b2a?auto=format&fit=crop&w=1200&q=80",
  custom: "https://images.unsplash.com/photo-1458538977777-0549b6204065?auto=format&fit=crop&w=1200&q=80",
};

const PRODUCT_IMAGE_BY_SLUG_PART = [
  ["fixed-featured-sale", "pendant"],
  ["fixed-earrings", "earrings"],
  ["22k-ring-fixed-making", "ring"],
  ["gold-18k-per-gram", "chain"],
  ["24k-coin", "coin"],
  ["22k-bangle", "bangle"],
  ["22k-ring-stones", "stones"],
  ["22k-pendant-tracked", "pendant"],
  ["22k-custom-chain", "custom"],
  ["draft-gold-22k", "ring"],
];

async function downloadImage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "SwarnaGrowDemoSeed/1.0", Accept: "image/*" },
  });
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  const contentType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`image too small from ${url}`);
  return { buf, contentType };
}

async function createUploadFromUrl({
  tenantId,
  ownerId,
  purpose,
  url,
  fileName,
  attachedEntityType,
}) {
  const { buf, contentType } = await downloadImage(url);
  const ext = contentType.includes("png") ? "png" : "jpg";
  const uploadId = createId("upload");
  const objectKey = prefixStorageObjectKey(
    `${tenantId}/${purpose.toLowerCase()}/${uploadId}/${fileName}.${ext}`,
  );
  await storageProvider.uploadFile({ objectKey, body: buf, contentType });
  await Upload.create({
    _id: uploadId,
    tenantId,
    ownerId,
    purpose,
    fileName: `${fileName}.${ext}`,
    contentType,
    sizeBytes: buf.length,
    objectKey,
    status: UploadStatus.UPLOADED,
    attachedEntityType: attachedEntityType ?? null,
    expiresAt: new Date(Date.now() + 365 * 86_400_000),
  });
  return uploadId;
}

async function upsertBanner({
  tenantId,
  ownerId,
  key,
  title,
  subtitle,
  placement,
  destinationType,
  targetCategoryId,
  targetProductId,
  imageKey,
  displayOrder,
}) {
  const existing = await EcommerceBanner.findOne({
    tenantId,
    subtitle: { $regex: `\\[demo-banner-key:${key}\\]` },
  });
  const imageUploadId = await createUploadFromUrl({
    tenantId,
    ownerId,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
    url: IMAGES[imageKey],
    fileName: `groquik-banner-${key}`,
    attachedEntityType: "ECOMMERCE_BANNER",
  });
  // Keep under schema maxlength 200 while retaining the demo key marker for idempotency.
  const subtitleFull = `${subtitle} [demo-banner-key:${key}]`.slice(0, 200);
  if (existing) {
    existing.title = title;
    existing.subtitle = subtitleFull;
    existing.placement = placement;
    existing.destinationType = destinationType;
    existing.targetCategoryId = targetCategoryId ?? null;
    existing.targetProductId = targetProductId ?? null;
    existing.imageUploadId = imageUploadId;
    existing.displayOrder = displayOrder;
    existing.status = EcommerceBannerStatus.PUBLISHED;
    existing.version = (existing.version ?? 0) + 1;
    await existing.save();
    return { key, action: "updated", id: existing._id };
  }
  const id = createId("ebnr");
  await EcommerceBanner.create({
    _id: id,
    tenantId,
    title,
    subtitle: subtitleFull,
    placement,
    destinationType,
    targetCategoryId: targetCategoryId ?? null,
    targetProductId: targetProductId ?? null,
    imageUploadId,
    displayOrder,
    status: EcommerceBannerStatus.PUBLISHED,
    version: 1,
  });
  return { key, action: "created", id };
}

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: TENANT_CODE });
  if (!tenant) throw new Error("GROQUIKSOLUT not found");
  const owner = await User.findOne({ tenantId: tenant._id, role: "TENANT_OWNER" }).lean();
  if (!owner) throw new Error("GROQUIKSOLUT owner missing — run ecommerce enable step first");

  const products = await EcommerceProduct.find({ tenantId: tenant._id }).lean();
  const categories = await EcommerceCategory.find({ tenantId: tenant._id }).lean();
  const rings = categories.find((c) => /rings/i.test(c.slug || c.name));
  const featuredProduct = products.find((p) => p.featured && p.status === EcommerceProductStatus.PUBLISHED)
    ?? products.find((p) => p.status === EcommerceProductStatus.PUBLISHED);

  const productResults = [];
  for (const product of products) {
    if (product.status === EcommerceProductStatus.ARCHIVED) continue;
    const match = PRODUCT_IMAGE_BY_SLUG_PART.find(([part]) => String(product.slug).includes(part));
    const imageKey = match?.[1] ?? "pendant";
    const uploadId = await createUploadFromUrl({
      tenantId: tenant._id,
      ownerId: owner._id,
      purpose: UploadPurpose.ECOMMERCE_PRODUCT_IMAGE,
      url: IMAGES[imageKey],
      fileName: `groquik-product-${product.slug}`.slice(0, 80),
      attachedEntityType: "ECOMMERCE_PRODUCT",
    });
    await EcommerceProduct.updateOne(
      { _id: product._id },
      {
        $set: {
          imageUploadIds: [uploadId],
          name: product.name.replace(/^Demo\s+/i, "GroQuik "),
        },
        $inc: { version: 1 },
      },
    );
    productResults.push({ slug: product.slug, uploadId, imageKey });
  }

  const bannerResults = [];
  bannerResults.push(
    await upsertBanner({
      tenantId: tenant._id,
      ownerId: owner._id,
      key: "home-schemes",
      title: "Grow your gold with groquik",
      subtitle: "Start a savings scheme today",
      placement: EcommerceBannerPlacement.HOME,
      destinationType: EcommerceBannerDestination.SCHEMES,
      imageKey: "bannerGold",
      displayOrder: 0,
    }),
  );
  bannerResults.push(
    await upsertBanner({
      tenantId: tenant._id,
      ownerId: owner._id,
      key: "home-shop-teaser",
      title: "New jewellery collection",
      subtitle: "Shop bridal & everyday gold online",
      placement: EcommerceBannerPlacement.HOME,
      destinationType: EcommerceBannerDestination.SHOP,
      imageKey: "bannerHome",
      displayOrder: 5,
    }),
  );
  bannerResults.push(
    await upsertBanner({
      tenantId: tenant._id,
      ownerId: owner._id,
      key: "shop-featured-product",
      title: "Featured pendant",
      subtitle: "Limited festive offer",
      placement: EcommerceBannerPlacement.SHOP,
      destinationType: featuredProduct
        ? EcommerceBannerDestination.PRODUCT
        : EcommerceBannerDestination.SHOP,
      targetProductId: featuredProduct?._id ?? null,
      imageKey: "bannerShop",
      displayOrder: 0,
    }),
  );
  bannerResults.push(
    await upsertBanner({
      tenantId: tenant._id,
      ownerId: owner._id,
      key: "both-rings-category",
      title: "Rings for every occasion",
      subtitle: "Browse the rings edit",
      placement: EcommerceBannerPlacement.BOTH,
      destinationType: rings
        ? EcommerceBannerDestination.CATEGORY
        : EcommerceBannerDestination.SHOP,
      targetCategoryId: rings?._id ?? null,
      imageKey: "bannerRings",
      displayOrder: 10,
    }),
  );

  // Ensure store flag still on
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "operations.ecommerceEnabled": true } },
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        tenantCode: TENANT_CODE,
        productsImaged: productResults.length,
        banners: bannerResults,
        shopPath: "/customer/groquiksolut/shop",
      },
      null,
      2,
    )}\n`,
  );
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  try { await disconnectDatabase(); } catch { /* ignore */ }
  process.exit(1);
});
