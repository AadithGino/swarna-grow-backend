import test from "node:test";
import assert from "node:assert/strict";
import {
  EcommercePriceMode,
  PlanTier,
  UploadPurpose,
  UploadStatus,
  UserType,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { storageProvider } from "../src/integrations/storage.provider.js";
import { Upload } from "../src/models/index.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  completeUpload,
  getUploadDownload,
  presignUpload,
} from "../src/services/upload.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function entitledTenant(tenant) {
  return {
    ...tenant.toObject(),
    subscription: {
      ...tenant.subscription,
      tier: PlanTier.PRO,
      planFeaturesSnapshot: { ecommerce: true },
    },
    operations: { ecommerceEnabled: true },
  };
}

function staffReq(tenant, user, extra = {}) {
  return {
    auth: { tenantId: tenant._id, id: user._id, type: UserType.TENANT_USER },
    tenant: entitledTenant(tenant),
    baseUrl: "/api/v1/admin",
    body: {},
    query: {},
    params: {},
    ...extra,
  };
}

async function seedPngUpload({ tenantId, ownerId, purpose }) {
  const fileBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const uploadId = createId("upload");
  const objectKey = `${tenantId}/${purpose.toLowerCase()}/${uploadId}/photo.png`;
  await storageProvider.uploadFile({
    objectKey,
    body: fileBody,
    contentType: "image/png",
  });
  await Upload.create({
    _id: uploadId,
    tenantId,
    ownerId,
    purpose,
    fileName: "photo.png",
    contentType: "image/png",
    sizeBytes: fileBody.length,
    objectKey,
    status: UploadStatus.UPLOADED,
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });
  return uploadId;
}

test("presign rejects oversize ecommerce product image", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "IMG1" });
  await assert.rejects(
    () =>
      presignUpload(
        staffReq(tenant, user, {
          body: {
            purpose: UploadPurpose.ECOMMERCE_PRODUCT_IMAGE,
            fileName: "big.png",
            contentType: "image/png",
            sizeBytes: 3_000_000,
          },
        }),
      ),
    (err) => err.statusCode === 400 || err.code === "VALIDATION_FAILED",
  );
});

test("customer can download staff-attached published product image", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "IMG2" });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: user.branchId });
  const base = staffReq(tenant, user);
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_PRODUCT_IMAGE,
  });
  await ecommerce.putTaxSettings({
    ...base,
    body: {
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
    },
  });
  const product = await ecommerce.createProduct({
    ...base,
    body: {
      name: "Ring",
      slug: "ring",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 50_000 },
      taxClassification: "GST_3",
      imageUploadIds: [uploadId],
    },
  });
  await ecommerce.publishProduct({
    ...base,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  const download = await getUploadDownload({
    auth: { tenantId: tenant._id, id: customer._id, type: UserType.CUSTOMER },
    params: { uploadId },
    query: {},
  });
  assert.ok(download.downloadUrl);
});

test("customer cannot download other tenant catalog image", async () => {
  const a = await seedTenantUser({ tenantCode: "IMGA" });
  const b = await seedTenantUser({ tenantCode: "IMGB" });
  const customerB = await seedCustomer({ tenantId: b.tenant._id, branchId: b.user.branchId });
  const uploadId = await seedPngUpload({
    tenantId: a.tenant._id,
    ownerId: a.user._id,
    purpose: UploadPurpose.ECOMMERCE_PRODUCT_IMAGE,
  });
  await assert.rejects(
    () =>
      getUploadDownload({
        auth: { tenantId: b.tenant._id, id: customerB._id, type: UserType.CUSTOMER },
        params: { uploadId },
        query: {},
      }),
    (err) => err.statusCode === 403 || err.statusCode === 404,
  );
});

test("complete upload verifies png signature for ecommerce category image", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "IMG3" });
  const presigned = await presignUpload(
    staffReq(tenant, user, {
      body: {
        purpose: UploadPurpose.ECOMMERCE_CATEGORY_IMAGE,
        fileName: "cat.png",
        contentType: "image/png",
        sizeBytes: 10,
      },
    }),
  );
  const fileBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const uploadRow = await Upload.findById(presigned.uploadId).lean();
  await storageProvider.uploadFile({
    objectKey: uploadRow.objectKey,
    body: fileBody,
    contentType: "image/png",
  });
  const done = await completeUpload(
    staffReq(tenant, user, { params: { uploadId: presigned.uploadId } }),
  );
  assert.equal(done.status, UploadStatus.UPLOADED);
  assert.ok(done.viewUrl.includes(presigned.uploadId));
});
