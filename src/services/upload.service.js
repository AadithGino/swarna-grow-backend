import path from "node:path";
import { Upload } from "../models/index.js";
import { UploadPurpose, UploadStatus } from "../constants/enums.js";
import { createId } from "../lib/ids.js";
import { AppError, errors } from "../lib/app-error.js";
import { storageProvider } from "../integrations/storage.provider.js";
import { env } from "../config/env.js";

const RULES = Object.freeze({
  TENANT_LOGO: { max: 2_000_000, types: ["image/png", "image/jpeg", "image/webp"] },
  KYC_DOCUMENT: { max: 5_000_000, types: ["image/jpeg", "image/png", "application/pdf"] },
  GRIEVANCE_ATTACHMENT: { max: 5_000_000, types: ["image/jpeg", "image/png", "application/pdf"] },
});

const ATTACHABLE_STATUSES = new Set([UploadStatus.UPLOADED, UploadStatus.ATTACHED]);

export function uploadViewPath(uploadId) {
  return `/uploads/${uploadId}`;
}

export async function presignUpload(req) {
  const rule = RULES[req.body.purpose];
  if (!rule?.types.includes(req.body.contentType) || req.body.sizeBytes > rule.max) {
    throw errors.validation([{ field: "file", message: "The file type or size is not allowed for this purpose." }]);
  }
  const id = createId("upload");
  const safeName = path.basename(req.body.fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
  const objectKey = `${req.auth.tenantId}/${req.body.purpose.toLowerCase()}/${id}/${safeName}`;
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  const upload = await Upload.create({
    _id: id,
    tenantId: req.auth.tenantId,
    ownerId: req.auth.id,
    ...req.body,
    objectKey,
    expiresAt,
  });
  const uploadUrl = await storageProvider.presignUpload({ objectKey, contentType: upload.contentType });
  return {
    uploadId: id,
    uploadUrl,
    method: "PUT",
    headers: { "Content-Type": upload.contentType },
    expiresAt,
    completeUrl: uploadViewPath(id),
  };
}

async function verifyStoredObject(upload) {
  if (env.PROVIDER_MODE === "mock") {
    try {
      await storageProvider.readObjectBody(upload.objectKey);
    } catch {
      throw errors.business("UPLOAD_NOT_FOUND", "The uploaded file was not found in storage.", { uploadId: upload._id });
    }
    return;
  }
  const head = await storageProvider.headObject(upload.objectKey);
  if (upload.sizeBytes != null && head.contentLength != null && head.contentLength !== upload.sizeBytes) {
    throw errors.business(
      "UPLOAD_SIZE_MISMATCH",
      "The uploaded file size does not match what was declared.",
      { expectedBytes: upload.sizeBytes, actualBytes: head.contentLength },
    );
  }
  if (upload.contentType && head.contentType && head.contentType !== upload.contentType) {
    throw errors.business(
      "UPLOAD_TYPE_MISMATCH",
      "The uploaded file type does not match what was declared.",
      { expectedType: upload.contentType, actualType: head.contentType },
    );
  }
}

export async function completeUpload(req) {
  const uploadId = req.params.uploadId ?? req.body.uploadId;
  const upload = await Upload.findOne({ _id: uploadId, tenantId: req.auth.tenantId });
  if (!upload) throw errors.notFound("Upload");
  if (upload.ownerId !== req.auth.id) throw errors.forbidden("You can only complete your own uploads.");
  if (upload.status === UploadStatus.UPLOADED || upload.status === UploadStatus.ATTACHED) {
    return { uploadId: upload._id, status: upload.status, viewUrl: uploadViewPath(upload._id) };
  }
  if (upload.status === UploadStatus.EXPIRED) {
    throw errors.business("UPLOAD_EXPIRED", "This upload reservation has expired.", { uploadId: upload._id });
  }
  if (upload.expiresAt && upload.expiresAt < new Date()) {
    upload.status = UploadStatus.EXPIRED;
    await upload.save();
    throw errors.business("UPLOAD_EXPIRED", "This upload reservation has expired.", { uploadId: upload._id });
  }
  await verifyStoredObject(upload);
  upload.status = UploadStatus.UPLOADED;
  await upload.save();
  return { uploadId: upload._id, status: upload.status, viewUrl: uploadViewPath(upload._id) };
}

function canReadUpload(req, upload, { subjectId } = {}) {
  if (upload.ownerId === req.auth.id) return true;
  if (subjectId && upload.ownerId === subjectId) return true;
  if (req.auth.type === "TENANT_USER" && upload.tenantId === req.auth.tenantId) return true;
  return false;
}

export async function getUploadDownload(req) {
  const upload = await Upload.findOne({ _id: req.params.uploadId, tenantId: req.auth.tenantId }).lean();
  if (!upload) throw errors.notFound("Upload");
  const subjectId = req.query.subjectId ?? req.params.customerId;
  if (!canReadUpload(req, upload, { subjectId })) throw errors.forbidden();
  if (upload.status === UploadStatus.PENDING) {
    throw errors.business("UPLOAD_NOT_READY", "This upload has not been completed yet.", { uploadId: upload._id });
  }
  if (upload.status === UploadStatus.EXPIRED) {
    throw errors.business("UPLOAD_EXPIRED", "This upload reservation has expired.", { uploadId: upload._id });
  }
  const downloadUrl = await storageProvider.presignDownload(upload.objectKey);
  return {
    uploadId: upload._id,
    downloadUrl,
    fileName: upload.fileName ?? null,
    contentType: upload.contentType ?? null,
    expiresInSeconds: 900,
  };
}

function assertAttachableOwner(req, upload, subjectId) {
  if (upload.ownerId === req.auth.id) return;
  if (subjectId && upload.ownerId === subjectId) return;
  throw new AppError(
    "UPLOAD_OWNER_MISMATCH",
    "This upload cannot be attached by the current user.",
    403,
    { uploadId: upload._id },
  );
}

export async function validateUploadReferences({
  req,
  uploadIds = [],
  purpose,
  session,
  subjectId,
}) {
  const ids = [...new Set(uploadIds.filter(Boolean))];
  if (!ids.length) return [];
  const uploads = await Upload.find({ _id: { $in: ids }, tenantId: req.auth.tenantId }).session(session);
  if (uploads.length !== ids.length) throw errors.notFound("Upload");
  for (const upload of uploads) {
    if (upload.purpose !== purpose) {
      throw new AppError(
        "UPLOAD_PURPOSE_MISMATCH",
        "This upload cannot be used for the requested attachment.",
        422,
        { uploadId: upload._id, expectedPurpose: purpose, actualPurpose: upload.purpose },
      );
    }
    if (!ATTACHABLE_STATUSES.has(upload.status)) {
      throw new AppError(
        "UPLOAD_NOT_READY",
        "This upload has not been completed yet.",
        422,
        { uploadId: upload._id, status: upload.status },
      );
    }
    assertAttachableOwner(req, upload, subjectId);
  }
  await Upload.updateMany(
    { _id: { $in: ids }, tenantId: req.auth.tenantId, status: UploadStatus.UPLOADED },
    { $set: { status: UploadStatus.ATTACHED } },
    { session },
  );
  return uploads;
}

export async function validateKycUploadReferences(req, body, session) {
  const uploadIds = [body.frontUploadId, body.backUploadId].filter(Boolean);
  if (!uploadIds.length) return [];
  return validateUploadReferences({
    req,
    uploadIds,
    purpose: UploadPurpose.KYC_DOCUMENT,
    session,
    subjectId: req.params.customerId,
  });
}

export async function validateGrievanceUploadReferences(req, uploadIds, session) {
  if (!uploadIds?.length) return [];
  return validateUploadReferences({
    req,
    uploadIds,
    purpose: UploadPurpose.GRIEVANCE_ATTACHMENT,
    session,
    subjectId: req.auth.type === "CUSTOMER" ? req.auth.id : undefined,
  });
}
