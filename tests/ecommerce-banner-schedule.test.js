import test from "node:test";
import assert from "node:assert/strict";
import {
  EcommerceBannerDestination,
  EcommerceBannerPlacement,
  EcommerceBannerStatus,
  UploadPurpose,
  UserType,
} from "../src/constants/enums.js";
import { Tenant, User } from "../src/models/index.js";
import { PlanTier } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import * as banners from "../src/services/ecommerce-banner.service.js";
import {
  bearerFor,
  resetTestDb,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { storageProvider } from "../src/integrations/storage.provider.js";
import { Upload } from "../src/models/index.js";
import { UploadStatus } from "../src/constants/enums.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

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

function adminReq(tenant, user, extra = {}) {
  return {
    auth: { tenantId: tenant._id, id: user._id, type: UserType.TENANT_USER },
    tenant: entitledTenant(tenant),
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

test("explicit schedule clearing and validation on patch", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "SCH1" });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const created = await banners.createBanner(
    adminReq(tenant, user, {
      body: {
        title: "Scheduled",
        placement: EcommerceBannerPlacement.HOME,
        destinationType: EcommerceBannerDestination.NONE,
        imageUploadId: uploadId,
        startsAt: "2026-01-20T00:00:00.000Z",
        endsAt: "2026-01-25T00:00:00.000Z",
      },
    }),
  );
  const clearedStart = await banners.patchBanner(
    adminReq(tenant, user, {
      params: { bannerId: created.id },
      body: {
        expectedVersion: created.version,
        startsAt: null,
        endsAt: "2026-01-18T00:00:00.000Z",
      },
    }),
  );
  assert.ok(clearedStart.startsAt == null);
  assert.equal(clearedStart.endsAt, "2026-01-18T00:00:00.000Z");

  const titleOnly = await banners.patchBanner(
    adminReq(tenant, user, {
      params: { bannerId: clearedStart.id },
      body: { expectedVersion: clearedStart.version, title: "Renamed" },
    }),
  );
  assert.equal(titleOnly.startsAt, null);
  assert.equal(titleOnly.endsAt, "2026-01-18T00:00:00.000Z");

  await assert.rejects(
    () =>
      banners.patchBanner(
        adminReq(tenant, user, {
          params: { bannerId: titleOnly.id },
          body: {
            expectedVersion: titleOnly.version,
            startsAt: "2026-01-30T00:00:00.000Z",
            endsAt: "2026-01-10T00:00:00.000Z",
          },
        }),
      ),
    (err) => err.statusCode === 400,
  );
});

test("second admin retains existing banner image on metadata edit", async () => {
  const { tenant, user: userA } = await seedTenantUser({ tenantCode: "SCH2" });
  const userB = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: userA.branchId,
    role: userA.role,
    name: "Admin B",
    mobile: "+919811122233",
    passwordHash: userA.passwordHash,
    status: userA.status,
    permissions: userA.permissions,
  });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: userA._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const created = await banners.createBanner(
    adminReq(tenant, userA, {
      body: {
        title: "Shared image",
        placement: EcommerceBannerPlacement.HOME,
        destinationType: EcommerceBannerDestination.NONE,
        imageUploadId: uploadId,
      },
    }),
  );
  const updated = await banners.patchBanner(
    adminReq(tenant, userB, {
      params: { bannerId: created.id },
      body: {
        expectedVersion: created.version,
        title: "Edited by B",
        imageUploadId: uploadId,
      },
    }),
  );
  assert.equal(updated.imageUploadId, uploadId);
  assert.equal(updated.title, "Edited by B");
});

test("published banner cannot lose image on patch", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "SCH3" });
  const uploadId = await seedPngUpload({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
  });
  const draft = await banners.createBanner(
    adminReq(tenant, user, {
      body: {
        title: "Live",
        placement: EcommerceBannerPlacement.HOME,
        destinationType: EcommerceBannerDestination.NONE,
        imageUploadId: uploadId,
      },
    }),
  );
  const published = await banners.publishBanner(
    adminReq(tenant, user, {
      params: { bannerId: draft.id },
      body: { expectedVersion: draft.version },
    }),
  );
  assert.equal(published.status, EcommerceBannerStatus.PUBLISHED);
  await assert.rejects(
    () =>
      banners.patchBanner(
        adminReq(tenant, user, {
          params: { bannerId: published.id },
          body: { expectedVersion: published.version, imageUploadId: null },
        }),
      ),
    (err) => err.statusCode === 400,
  );
});
