import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceBannerDestination,
  EcommerceBannerPlacement,
  EcommerceBannerStatus,
  EcommercePriceMode,
  PlanTier,
  TenantRole,
  UploadPurpose,
  UploadStatus,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { Permission } from "../src/constants/permissions.js";
import argon2 from "argon2";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { Tenant, Upload, User } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { storageProvider } from "../src/integrations/storage.provider.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import * as banners from "../src/services/ecommerce-banner.service.js";
import { completeUpload, getUploadDownload } from "../src/services/upload.service.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";

let app;
test.before(async () => {
  await startTestDb();
  app = createApp();
});
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function entitledTenant(tenant, { storeOn = true } = {}) {
  return {
    ...tenant.toObject(),
    subscription: {
      ...tenant.subscription,
      tier: PlanTier.PRO,
      planFeaturesSnapshot: { ecommerce: true },
    },
    operations: { ecommerceEnabled: storeOn },
  };
}

function adminReq(tenant, user, extra = {}) {
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

function customerReq(tenant, customer, extra = {}) {
  return {
    auth: { tenantId: tenant._id, id: customer._id, type: UserType.CUSTOMER },
    tenant: entitledTenant(tenant, extra.storeOn === false ? { storeOn: false } : {}),
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
  await storageProvider.uploadFile({ objectKey, body: fileBody, contentType: "image/png" });
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

async function seedShopBasics(base) {
  await ecommerce.putTaxSettings({
    ...base,
    body: {
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
    },
  });
}

async function createPublishedHomeBanner(tenant, user, uploadId) {
  const draft = await banners.createBanner(
    adminReq(tenant, user, {
      body: {
        title: "Festive",
        placement: EcommerceBannerPlacement.HOME,
        destinationType: EcommerceBannerDestination.HOME,
        imageUploadId: uploadId,
      },
    }),
  );
  return banners.publishBanner(
    adminReq(tenant, user, {
      params: { bannerId: draft.id },
      body: { expectedVersion: draft.version },
    }),
  );
}

test("banner CRUD, publish requires image, cross-tenant isolation", async () => {
  const a = await seedTenantUser({ tenantCode: "BNR1" });
  const b = await seedTenantUser({ tenantCode: "BNR2" });
  const uploadId = await seedPngUpload({
    tenantId: a.tenant._id,
    ownerId: a.user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const created = await banners.createBanner(
    adminReq(a.tenant, a.user, {
      body: {
        title: "Summer",
        placement: EcommerceBannerPlacement.SHOP,
        destinationType: EcommerceBannerDestination.SHOP,
      },
    }),
  );
  assert.equal(created.status, EcommerceBannerStatus.DRAFT);
  await assert.rejects(
    () =>
      banners.publishBanner(
        adminReq(a.tenant, a.user, {
          params: { bannerId: created.id },
          body: { expectedVersion: created.version },
        }),
      ),
    (err) => err.statusCode === 400,
  );
  const patched = await banners.patchBanner(
    adminReq(a.tenant, a.user, {
      params: { bannerId: created.id },
      body: { expectedVersion: created.version, imageUploadId: uploadId },
    }),
  );
  const published = await banners.publishBanner(
    adminReq(a.tenant, a.user, {
      params: { bannerId: created.id },
      body: { expectedVersion: patched.version },
    }),
  );
  assert.equal(published.status, EcommerceBannerStatus.PUBLISHED);
  await assert.rejects(
    () =>
      banners.getBanner(
        adminReq(b.tenant, b.user, { params: { bannerId: created.id } }),
      ),
    (err) => err.statusCode === 404,
  );
});

test("home banners visible when store switch off; shop banners require operational store", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR3" });
  const customer = await seedCustomer({ tenantId: tenant._id });
  const uploadHome = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  await createPublishedHomeBanner(tenant, user, uploadHome);
  await Tenant.updateOne({ _id: tenant._id }, { $set: { "operations.ecommerceEnabled": false } });
  const tenantOff = await Tenant.findById(tenant._id);
  const home = await banners.shopHomeBanners(
    customerReq(tenantOff, customer, { storeOn: false }),
  );
  assert.equal(home.items.length, 1);
  const shop = await banners.shopStorefrontBanners(
    customerReq(tenantOff, customer, { storeOn: false }),
  );
  assert.equal(shop.items.length, 0);
  assert.ok(shop.meta?.serverTime);
});

test("scheduled and archived banners hidden from customer API", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR4" });
  const customer = await seedCustomer({ tenantId: tenant._id });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const future = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  const draft = await banners.createBanner(
    adminReq(tenant, user, {
      body: {
        title: "Later",
        placement: EcommerceBannerPlacement.HOME,
        destinationType: EcommerceBannerDestination.NONE,
        imageUploadId: uploadId,
        startsAt: future,
      },
    }),
  );
  const pub = await banners.publishBanner(
    adminReq(tenant, user, {
      params: { bannerId: draft.id },
      body: { expectedVersion: draft.version },
    }),
  );
  assert.equal(pub.status, EcommerceBannerStatus.PUBLISHED);
  const none = await banners.shopHomeBanners(customerReq(tenant, customer));
  assert.equal(none.items.length, 0);
  assert.equal(none.meta?.nextVisibilityChangeAt, future);
  assert.ok(none.meta?.serverTime);
});

test("admin banner list paginates without repeating cursors", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR51" });
  const base = adminReq(tenant, user);
  for (let i = 0; i < 51; i += 1) {
    await banners.createBanner({
      ...base,
      body: {
        title: `Banner ${String(i).padStart(2, "0")}`,
        placement: EcommerceBannerPlacement.HOME,
        destinationType: EcommerceBannerDestination.NONE,
        displayOrder: i,
      },
    });
  }
  const page1 = await banners.listBanners({ ...base, query: { limit: 50 } });
  assert.equal(page1.items.length, 50);
  assert.ok(page1.meta?.nextCursor);
  const page2 = await banners.listBanners({
    ...base,
    query: { limit: 50, cursor: page1.meta.nextCursor },
  });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.meta?.nextCursor ?? null, null);
  const ids = new Set([...page1.items.map((r) => r.id), ...page2.items.map((r) => r.id)]);
  assert.equal(ids.size, 51);
});

test("product destination suppressed when product unavailable", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR5" });
  const customer = await seedCustomer({ tenantId: tenant._id });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const base = adminReq(tenant, user);
  await seedShopBasics(base);
  const productDraft = await ecommerce.createProduct({
    ...base,
    body: {
      name: "Ring",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 50000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    ...base,
    params: { productId: productDraft.id },
    body: { expectedVersion: 1 },
  });
  const product = productDraft;
  const draft = await banners.createBanner(
    adminReq(tenant, user, {
      body: {
        title: "Ring promo",
        placement: EcommerceBannerPlacement.HOME,
        destinationType: EcommerceBannerDestination.PRODUCT,
        targetProductId: product.id,
        imageUploadId: uploadId,
      },
    }),
  );
  await banners.publishBanner(
    adminReq(tenant, user, {
      params: { bannerId: draft.id },
      body: { expectedVersion: draft.version },
    }),
  );
  await ecommerce.archiveProduct({
    ...base,
    params: { productId: product.id },
    body: { expectedVersion: 2 },
  });
  const home = await banners.shopHomeBanners(customerReq(tenant, customer));
  assert.equal(home.items.length, 0);
});

test("customer can download published home banner image when store off", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR6" });
  const customer = await seedCustomer({ tenantId: tenant._id });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  await createPublishedHomeBanner(tenant, user, uploadId);
  await Tenant.updateOne({ _id: tenant._id }, { $set: { "operations.ecommerceEnabled": false } });
  const tenantOff = await Tenant.findById(tenant._id);
  const dl = await getUploadDownload(
    customerReq(tenantOff, customer, {
      params: { uploadId },
      storeOn: false,
    }),
  );
  assert.ok(dl.downloadUrl);
});

test("HOME banner with SHOP destination hidden when store is off", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR8" });
  const customer = await seedCustomer({ tenantId: tenant._id });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const draft = await banners.createBanner(
    adminReq(tenant, user, {
      body: {
        title: "Shop teaser",
        placement: EcommerceBannerPlacement.HOME,
        destinationType: EcommerceBannerDestination.SHOP,
        imageUploadId: uploadId,
      },
    }),
  );
  await banners.publishBanner(
    adminReq(tenant, user, {
      params: { bannerId: draft.id },
      body: { expectedVersion: draft.version },
    }),
  );
  await Tenant.updateOne({ _id: tenant._id }, { $set: { "operations.ecommerceEnabled": false } });
  const tenantOff = await Tenant.findById(tenant._id);
  const home = await banners.shopHomeBanners(
    customerReq(tenantOff, customer, { storeOn: false }),
  );
  assert.equal(home.items.length, 0);
});

test("HOME banner with PRODUCT destination hidden when store is off", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR9" });
  const customer = await seedCustomer({ tenantId: tenant._id });
  const base = adminReq(tenant, user);
  await seedShopBasics(base);
  const productDraft = await ecommerce.createProduct({
    ...base,
    body: {
      name: "Band",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 50000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    ...base,
    params: { productId: productDraft.id },
    body: { expectedVersion: 1 },
  });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const draft = await banners.createBanner(
    adminReq(tenant, user, {
      body: {
        title: "Product promo",
        placement: EcommerceBannerPlacement.BOTH,
        destinationType: EcommerceBannerDestination.PRODUCT,
        targetProductId: productDraft.id,
        imageUploadId: uploadId,
      },
    }),
  );
  await banners.publishBanner(
    adminReq(tenant, user, {
      params: { bannerId: draft.id },
      body: { expectedVersion: draft.version },
    }),
  );
  await Tenant.updateOne({ _id: tenant._id }, { $set: { "operations.ecommerceEnabled": false } });
  const tenantOff = await Tenant.findById(tenant._id);
  const home = await banners.shopHomeBanners(
    customerReq(tenantOff, customer, { storeOn: false }),
  );
  assert.equal(home.items.length, 0);
  await assert.rejects(
    () => getUploadDownload(customerReq(tenantOff, customer, { params: { uploadId }, storeOn: false })),
    (err) => err.statusCode === 403,
  );
});

test("unpublish and schedule end revoke customer banner image download", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR10" });
  const customer = await seedCustomer({ tenantId: tenant._id });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const published = await createPublishedHomeBanner(tenant, user, uploadId);
  await getUploadDownload(customerReq(tenant, customer, { params: { uploadId } }));

  await banners.unpublishBanner(
    adminReq(tenant, user, {
      params: { bannerId: published.id },
      body: { expectedVersion: published.version },
    }),
  );
  await assert.rejects(
    () => getUploadDownload(customerReq(tenant, customer, { params: { uploadId } })),
    (err) => err.statusCode === 403,
  );

  const upload2 = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const draft = await banners.createBanner(
    adminReq(tenant, user, {
      body: {
        title: "Expired",
        placement: EcommerceBannerPlacement.HOME,
        destinationType: EcommerceBannerDestination.NONE,
        imageUploadId: upload2,
      },
    }),
  );
  const pub2 = await banners.publishBanner(
    adminReq(tenant, user, {
      params: { bannerId: draft.id },
      body: { expectedVersion: draft.version },
    }),
  );
  const past = new Date(Date.now() - 86_400_000).toISOString();
  await banners.patchBanner(
    adminReq(tenant, user, {
      params: { bannerId: pub2.id },
      body: { expectedVersion: pub2.version, endsAt: past },
    }),
  );
  await assert.rejects(
    () => getUploadDownload(customerReq(tenant, customer, { params: { uploadId: upload2 } })),
    (err) => err.statusCode === 403,
  );
});

test("archive revokes customer banner image download", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR11" });
  const customer = await seedCustomer({ tenantId: tenant._id });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const published = await createPublishedHomeBanner(tenant, user, uploadId);
  await banners.archiveBanner(
    adminReq(tenant, user, {
      params: { bannerId: published.id },
      body: { expectedVersion: published.version },
    }),
  );
  await assert.rejects(
    () => getUploadDownload(customerReq(tenant, customer, { params: { uploadId } })),
    (err) => err.statusCode === 403,
  );
});

test("draft banner image blocked for customer when store is on (no subjectId bypass)", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR12" });
  const customer = await seedCustomer({ tenantId: tenant._id });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  await banners.createBanner(
    adminReq(tenant, user, {
      body: {
        title: "Draft only",
        placement: EcommerceBannerPlacement.HOME,
        destinationType: EcommerceBannerDestination.NONE,
        imageUploadId: uploadId,
      },
    }),
  );
  await assert.rejects(
    () =>
      getUploadDownload(
        customerReq(tenant, customer, {
          params: { uploadId },
          query: { subjectId: user._id },
          storeOn: true,
        }),
      ),
    (err) => err.statusCode === 403,
  );
});

test("archived banner cannot be published or unpublished", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR13" });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const published = await createPublishedHomeBanner(tenant, user, uploadId);
  const archived = await banners.archiveBanner(
    adminReq(tenant, user, {
      params: { bannerId: published.id },
      body: { expectedVersion: published.version },
    }),
  );
  try {
    await banners.publishBanner(
      adminReq(tenant, user, {
        params: { bannerId: archived.id },
        body: { expectedVersion: archived.version },
      }),
    );
    assert.fail("expected publish on archived banner to fail");
  } catch (err) {
    assert.ok(err.statusCode === 422 || err.statusCode === 400);
  }
  try {
    await banners.unpublishBanner(
      adminReq(tenant, user, {
        params: { bannerId: archived.id },
        body: { expectedVersion: archived.version },
      }),
    );
    assert.fail("expected unpublish on archived banner to fail");
  } catch (err) {
    assert.ok(err.statusCode === 422 || err.statusCode === 400);
  }
});

test("HTTP permissions and version conflict on banner patch", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNR7" });
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "operations.ecommerceEnabled": true,
      },
    },
  );
  const token = bearerFor(user);
  const createRes = await request(app)
    .post("/api/v1/admin/ecommerce/banners")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", createId("idem"))
    .send({
      title: "HTTP",
      placement: EcommerceBannerPlacement.HOME,
      destinationType: EcommerceBannerDestination.NONE,
    });
  assert.equal(createRes.status, 201);
  const bannerId = createRes.body.data.id;
  const stale = await request(app)
    .patch(`/api/v1/admin/ecommerce/banners/${bannerId}`)
    .set("authorization", `Bearer ${token}`)
    .send({ expectedVersion: 99, title: "Nope" });
  assert.equal(stale.status, 409);
});

test("ecommerce upload presign rejects non-catalog purposes", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNRUPL" });
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "operations.ecommerceEnabled": true,
      },
    },
  );
  const token = bearerFor(user);
  const allowed = await request(app)
    .post("/api/v1/admin/ecommerce/uploads/presign")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", createId("idem"))
    .send({
      purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
      contentType: "image/png",
      fileName: "banner.png",
      sizeBytes: 1200,
    });
  assert.equal(allowed.status, 201);
  assert.ok(allowed.body.data.uploadId);

  const denied = await request(app)
    .post("/api/v1/admin/ecommerce/uploads/presign")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", createId("idem"))
    .send({
      purpose: UploadPurpose.TENANT_LOGO,
      contentType: "image/png",
      fileName: "logo.png",
      sizeBytes: 1200,
    });
  assert.ok(denied.status === 400 || denied.status === 422);
});

test("ecommerce-only permissions can presign, complete, download, and attach banner image", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNRLIFE" });
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "operations.ecommerceEnabled": true,
      },
    },
  );
  const catalogPerms = [Permission.ECOMMERCE_READ, Permission.ECOMMERCE_WRITE];
  const token = bearerFor(user, catalogPerms);
  const presignRes = await request(app)
    .post("/api/v1/admin/ecommerce/uploads/presign")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", createId("idem"))
    .send({
      purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
      fileName: "banner.png",
      contentType: "image/png",
      sizeBytes: 10,
    });
  assert.equal(presignRes.status, 201);
  const presigned = presignRes.body.data;
  const fileBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const uploadRow = await Upload.findById(presigned.uploadId).lean();
  await storageProvider.uploadFile({
    objectKey: uploadRow.objectKey,
    body: fileBody,
    contentType: "image/png",
  });
  const completeRes = await request(app)
    .post(`/api/v1/admin/ecommerce/uploads/${presigned.uploadId}/complete`)
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", createId("idem"))
    .send({});
  assert.equal(completeRes.status, 200, JSON.stringify(completeRes.body));

  const ecommerceDownload = await request(app)
    .get(`/api/v1/admin/ecommerce/uploads/${presigned.uploadId}`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(ecommerceDownload.status, 200);
  assert.ok(ecommerceDownload.body.data.downloadUrl);

  const settingsDownload = await request(app)
    .get(`/api/v1/admin/uploads/${presigned.uploadId}`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(settingsDownload.status, 403);

  const createRes = await request(app)
    .post("/api/v1/admin/ecommerce/banners")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", createId("idem"))
    .send({
      title: "With image",
      placement: EcommerceBannerPlacement.HOME,
      destinationType: EcommerceBannerDestination.NONE,
      imageUploadId: presigned.uploadId,
    });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.data.imageUploadId, presigned.uploadId);
});

async function seedPendingUpload({ tenantId, ownerId, purpose }) {
  const uploadId = createId("upload");
  const objectKey = `${tenantId}/${purpose.toLowerCase()}/${uploadId}/file.bin`;
  await Upload.create({
    _id: uploadId,
    tenantId,
    ownerId,
    purpose,
    fileName: "file.bin",
    contentType: "image/png",
    sizeBytes: 8,
    objectKey,
    status: UploadStatus.PENDING,
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });
  await storageProvider.uploadFile({
    objectKey,
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    contentType: "image/png",
  });
  return uploadId;
}

test("ecommerce upload complete rejects non-catalog purposes", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNRCMP" });
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "operations.ecommerceEnabled": true,
      },
    },
  );
  const token = bearerFor(user);
  const deniedPurposes = [
    UploadPurpose.KYC_DOCUMENT,
    UploadPurpose.TENANT_LOGO,
    UploadPurpose.PUSH_BROADCAST_IMAGE,
    UploadPurpose.GRIEVANCE_ATTACHMENT,
  ];
  for (const purpose of deniedPurposes) {
    const uploadId = await seedPendingUpload({
      tenantId: tenant._id,
      ownerId: user._id,
      purpose,
    });
    const res = await request(app)
      .post(`/api/v1/admin/ecommerce/uploads/${uploadId}/complete`)
      .set("authorization", `Bearer ${token}`)
      .set("x-idempotency-key", createId("idem"))
      .send({});
    assert.equal(res.status, 403, `${purpose} should be rejected`);
  }
});

test("ecommerce upload complete rejects wrong owner and cross-tenant upload", async () => {
  const a = await seedTenantUser({ tenantCode: "BNROWA" });
  const b = await seedTenantUser({ tenantCode: "BNROWB" });
  await Tenant.updateOne(
    { _id: a.tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "operations.ecommerceEnabled": true,
      },
    },
  );
  await Tenant.updateOne(
    { _id: b.tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "operations.ecommerceEnabled": true,
      },
    },
  );
  const uploadA = await seedPendingUpload({
    tenantId: a.tenant._id,
    ownerId: a.user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const crossTenant = await request(app)
    .post(`/api/v1/admin/ecommerce/uploads/${uploadA}/complete`)
    .set("authorization", `Bearer ${bearerFor(b.user)}`)
    .set("x-idempotency-key", createId("idem"))
    .send({});
  assert.equal(crossTenant.status, 404);

  const peer = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: a.tenant._id,
    branchId: a.branch._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Peer staff",
    mobile: "+919811122233",
    passwordHash: await argon2.hash("1234", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF] ?? [],
  });
  await assert.rejects(
    () =>
      completeUpload({
        auth: { tenantId: a.tenant._id, id: peer._id, type: UserType.TENANT_USER },
        params: { uploadId: uploadA },
        body: {},
      }),
    (err) => err.statusCode === 403,
  );
});

test("ORDERS destination banner hidden without customer order history", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "BNRORD" });
  const customer = await seedCustomer({ tenantId: tenant._id });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const draft = await banners.createBanner(
    adminReq(tenant, user, {
      body: {
        title: "Orders promo",
        placement: EcommerceBannerPlacement.HOME,
        destinationType: EcommerceBannerDestination.ORDERS,
        imageUploadId: uploadId,
      },
    }),
  );
  await banners.publishBanner(
    adminReq(tenant, user, {
      params: { bannerId: draft.id },
      body: { expectedVersion: draft.version },
    }),
  );
  const withoutHistory = await banners.shopHomeBanners(customerReq(tenant, customer));
  assert.equal(withoutHistory.items.length, 0);

  const { EcommerceOrder } = await import("../src/models/index.js");
  const { EcommerceOrderStatus, EcommercePaymentMethod } = await import("../src/constants/enums.js");
  await EcommerceOrder.create({
    _id: createId("eord"),
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber: "EC-ORD-1",
    status: EcommerceOrderStatus.PAID,
    paymentMethod: EcommercePaymentMethod.ONLINE,
    paidAt: new Date(),
    subtotalPaise: 10_000,
    taxPaise: 300,
    fulfilmentChargePaise: 0,
    totalPaise: 10_300,
    lines: [],
    version: 1,
  });

  const withHistory = await banners.shopHomeBanners(customerReq(tenant, customer));
  assert.equal(withHistory.items.length, 1);
  assert.equal(withHistory.items[0].destination.type, "ORDERS");
});
