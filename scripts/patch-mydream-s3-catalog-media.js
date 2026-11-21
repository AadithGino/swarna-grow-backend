/**
 * Re-upload MYDREAM ecommerce images to S3 (from local seed assets) and print public URLs.
 *
 *   npm run patch:mydream-s3-catalog-media
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { UploadPurpose, UploadStatus } from "../src/constants/enums.js";
import {
  prefixStorageObjectKey,
  storageProvider,
  storagePublicObjectUrl,
} from "../src/integrations/storage.provider.js";
import { createId } from "../src/lib/ids.js";
import {
  EcommerceBanner,
  EcommerceCategory,
  EcommerceProduct,
  Tenant,
  Upload,
  User,
} from "../src/models/index.js";
import { TenantRole, UserStatus } from "../src/constants/enums.js";

const TENANT_CODE = "MYDREAM";
const SLUG_PREFIX = "mydream-jewel-";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JEWEL_DIR = path.join(__dirname, "assets/kairali-jewellery");
const BANNER_DIR = path.join(__dirname, "assets/my-dream-diamond/banners");

const PRODUCT_FILES = {
  "peacock-choker": "01-peacock-choker.jpg",
  "manga-mala": "02-manga-mala.jpg",
  "mesh-choker": "03-mesh-choker.jpg",
  "teardrop-pendant": "04-teardrop-pendant.jpg",
  "floral-kada": "05-floral-kada.jpg",
  "engraved-bangles": "06-engraved-bangles.jpg",
  "twisted-rope-bangles": "07-twisted-rope-bangles.jpg",
  "temple-bangles": "08-temple-bangles.jpg",
  "leaf-earrings": "09-leaf-earrings.jpg",
};

const CATEGORY_FILES = {
  necklaces: "01-peacock-choker.jpg",
  bangles: "05-floral-kada.jpg",
  earrings: "09-leaf-earrings.jpg",
};

const BANNER_FILES = {
  "shop-hero": "mydream-home-shop-hero.jpg",
  schemes: "mydream-home-schemes.jpg",
  "bridal-necklaces": "mydream-home-bridal.jpg",
  "shop-collection": "mydream-shop-collection.jpg",
  "shop-bangles": "mydream-shop-bangles.jpg",
  "shop-earrings": "mydream-shop-earrings.jpg",
};

async function putLocalFile({ tenantId, ownerId, purpose, localPath, fileName, entityType }) {
  const buf = fs.readFileSync(localPath);
  const uploadId = createId("upload");
  const objectKey = prefixStorageObjectKey(
    `${tenantId}/public/${purpose.toLowerCase()}/${fileName}`,
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
    fileName: path.basename(localPath),
    contentType: "image/jpeg",
    sizeBytes: buf.length,
    objectKey,
    status: UploadStatus.UPLOADED,
    attachedEntityType: entityType,
    expiresAt: new Date(Date.now() + 365 * 86_400_000),
  });
  return { uploadId, objectKey, publicUrl: storagePublicObjectUrl(objectKey) };
}

async function main() {
  if (env.PROVIDER_MODE === "mock") {
    throw new Error("Set PROVIDER_MODE=live and configure S3_* in .env before running.");
  }
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: TENANT_CODE });
  if (!tenant) throw new Error(`Tenant ${TENANT_CODE} not found`);
  const owner = await User.findOne({
    tenantId: tenant._id,
    role: TenantRole.TENANT_OWNER,
    status: UserStatus.ACTIVE,
  }).lean();
  if (!owner) throw new Error("Owner missing");

  const report = { categories: [], products: [], banners: [] };

  for (const [key, file] of Object.entries(CATEGORY_FILES)) {
    const slug = `${SLUG_PREFIX}${key}`;
    const cat = await EcommerceCategory.findOne({ tenantId: tenant._id, slug });
    if (!cat) continue;
    const local = path.join(JEWEL_DIR, file);
    const row = await putLocalFile({
      tenantId: tenant._id,
      ownerId: owner._id,
      purpose: UploadPurpose.ECOMMERCE_CATEGORY_IMAGE,
      localPath: local,
      fileName: `mydream-cat-${key}.jpg`,
      entityType: "ECOMMERCE_CATEGORY",
    });
    cat.imageUploadId = row.uploadId;
    cat.version = (cat.version ?? 0) + 1;
    await cat.save();
    report.categories.push({ slug, ...row });
  }

  for (const [key, file] of Object.entries(PRODUCT_FILES)) {
    const slug = `${SLUG_PREFIX}${key}`;
    const product = await EcommerceProduct.findOne({ tenantId: tenant._id, slug });
    if (!product) continue;
    const local = path.join(JEWEL_DIR, file);
    const row = await putLocalFile({
      tenantId: tenant._id,
      ownerId: owner._id,
      purpose: UploadPurpose.ECOMMERCE_PRODUCT_IMAGE,
      localPath: local,
      fileName: `mydream-prod-${key}.jpg`,
      entityType: "ECOMMERCE_PRODUCT",
    });
    product.imageUploadIds = [row.uploadId];
    product.version = (product.version ?? 0) + 1;
    await product.save();
    report.products.push({ slug, ...row });
  }

  const banners = await EcommerceBanner.find({
    tenantId: tenant._id,
    subtitle: { $regex: "mydream-promo-v2:" },
  }).lean();

  for (const banner of banners) {
    const match = banner.subtitle?.match(/mydream-promo-v2:([^\]]+)/);
    const key = match?.[1];
    const file = key ? BANNER_FILES[key] : null;
    if (!file) continue;
    const local = path.join(BANNER_DIR, file);
    if (!fs.existsSync(local)) continue;
    const row = await putLocalFile({
      tenantId: tenant._id,
      ownerId: owner._id,
      purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
      localPath: local,
      fileName: `mydream-banner-${key}.jpg`,
      entityType: "ECOMMERCE_BANNER",
    });
    await EcommerceBanner.updateOne(
      { _id: banner._id },
      { $set: { imageUploadId: row.uploadId, version: (banner.version ?? 0) + 1 } },
    );
    report.banners.push({ key, title: banner.title, ...row });
  }

  console.log(
    JSON.stringify(
      {
        tenant: TENANT_CODE,
        s3PublicBase: env.S3_PUBLIC_BASE_URL || "(derived from bucket)",
        publicUrlsEnabled: env.S3_PUBLIC_OBJECT_URLS === true,
        ...report,
      },
      null,
      2,
    ),
  );
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});