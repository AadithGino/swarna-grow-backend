import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { UploadPurpose, UploadStatus, UserType } from "../src/constants/enums.js";
import { AppError } from "../src/lib/app-error.js";
import { createId } from "../src/lib/ids.js";
import { storageProvider } from "../src/integrations/storage.provider.js";
import { Customer, Upload } from "../src/models/index.js";
import {
  completeUpload,
  getUploadDownload,
  uploadViewPath,
  validateKycUploadReferences,
} from "../src/services/upload.service.js";
import { updateKyc } from "../src/services/customer.service.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

let app;
function getApp() {
  if (!app) app = createApp();
  return app;
}

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedUploadedKycDoc({ tenantId, ownerId, purpose = UploadPurpose.KYC_DOCUMENT }) {
  const fileBody = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const uploadId = createId("upload");
  const objectKey = `${tenantId}/${purpose.toLowerCase()}/${uploadId}/id-front.jpg`;
  await storageProvider.uploadFile({
    objectKey,
    body: fileBody,
    contentType: "image/jpeg",
  });
  await Upload.create({
    _id: uploadId,
    tenantId,
    ownerId,
    purpose,
    fileName: "id-front.jpg",
    contentType: "image/jpeg",
    sizeBytes: fileBody.length,
    objectKey,
    status: UploadStatus.UPLOADED,
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });
  return uploadId;
}

test("KYC attachment rejects upload from another tenant", async () => {
  const { tenant: tenantA, user: staffA } = await seedTenantUser({ tenantCode: "TENANTA" });
  const { tenant: tenantB } = await seedTenantUser({ tenantCode: "TENANTB" });
  const customer = await seedCustomer({ tenantId: tenantA._id, branchId: staffA.branchId });
  const foreignUploadId = await seedUploadedKycDoc({ tenantId: tenantB._id, ownerId: staffA._id });
  await assert.rejects(
    () => updateKyc({
      auth: { id: staffA._id, tenantId: tenantA._id, type: UserType.TENANT_USER },
      scope: { tenantId: tenantA._id, branchId: staffA.branchId },
      params: { customerId: customer._id },
      body: { type: "AADHAAR", frontUploadId: foreignUploadId },
    }, false),
    (error) => error instanceof AppError && error.code === "RESOURCE_NOT_FOUND",
  );
});

test("KYC attachment rejects upload with wrong purpose", async () => {
  const { tenant, user, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const uploadId = await seedUploadedKycDoc({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.GRIEVANCE_ATTACHMENT,
  });
  await assert.rejects(
    () => updateKyc({
      auth: { id: user._id, tenantId: tenant._id, type: UserType.TENANT_USER },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { customerId: customer._id },
      body: { type: "AADHAAR", frontUploadId: uploadId },
    }, false),
    (error) => error instanceof AppError && error.code === "UPLOAD_PURPOSE_MISMATCH",
  );
});

test("KYC attachment rejects pending upload", async () => {
  const { tenant, user, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const uploadId = createId("upload");
  await Upload.create({
    _id: uploadId,
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.KYC_DOCUMENT,
    fileName: "id-front.jpg",
    contentType: "image/jpeg",
    sizeBytes: 16,
    objectKey: `${tenant._id}/kyc_document/${uploadId}/id-front.jpg`,
    status: UploadStatus.PENDING,
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });
  await assert.rejects(
    () => updateKyc({
      auth: { id: user._id, tenantId: tenant._id, type: UserType.TENANT_USER },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { customerId: customer._id },
      body: { type: "AADHAAR", frontUploadId: uploadId },
    }, false),
    (error) => error instanceof AppError && error.code === "UPLOAD_NOT_READY",
  );
});

test("upload download route resolves for tenant branding logo", async () => {
  const { tenant, user } = await seedTenantUser();
  const uploadId = await seedUploadedKycDoc({
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.TENANT_LOGO,
  });
  const token = bearerFor(user);
  const response = await request(getApp())
    .get(`/api/v1/admin/uploads/${uploadId}`)
    .set("authorization", `Bearer ${token}`)
    .expect(200);
  assert.equal(response.body.data.uploadId, uploadId);
  assert.match(response.body.data.downloadUrl, /mock-storage|amazonaws|http/);
  assert.equal(uploadViewPath(uploadId), `/uploads/${uploadId}`);
});

test("completeUpload verifies stored object and marks upload uploaded", async () => {
  const { tenant, user } = await seedTenantUser();
  const uploadId = createId("upload");
  const objectKey = `${tenant._id}/kyc_document/${uploadId}/id-front.jpg`;
  const fileBody = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  await storageProvider.uploadFile({
    objectKey,
    body: fileBody,
    contentType: "image/jpeg",
  });
  await Upload.create({
    _id: uploadId,
    tenantId: tenant._id,
    ownerId: user._id,
    purpose: UploadPurpose.KYC_DOCUMENT,
    fileName: "id-front.jpg",
    contentType: "image/jpeg",
    sizeBytes: fileBody.length,
    objectKey,
    status: UploadStatus.PENDING,
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });
  const result = await completeUpload({
    auth: { id: user._id, tenantId: tenant._id, type: UserType.TENANT_USER },
    params: { uploadId },
    body: {},
  });
  assert.equal(result.status, UploadStatus.UPLOADED);
  const download = await getUploadDownload({
    auth: { id: user._id, tenantId: tenant._id, type: UserType.TENANT_USER },
    params: { uploadId },
    query: {},
  });
  assert.ok(download.downloadUrl);
});

test("staff can attach customer-owned KYC upload on behalf of customer", async () => {
  const { tenant, user, branch } = await seedTenantUser();
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "CUST-KYC-1",
    name: "KYC Customer",
    mobile: "+919811122200",
  });
  const uploadId = await seedUploadedKycDoc({ tenantId: tenant._id, ownerId: customer._id });
  await validateKycUploadReferences(
    {
      auth: { id: user._id, tenantId: tenant._id, type: UserType.TENANT_USER },
      params: { customerId: customer._id },
      body: { frontUploadId: uploadId },
    },
    { frontUploadId: uploadId },
  );
  const row = await Upload.findById(uploadId).lean();
  assert.equal(row.status, UploadStatus.ATTACHED);
});
