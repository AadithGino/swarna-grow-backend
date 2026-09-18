import path from "node:path";
import { Upload } from "../models/index.js";
import { UploadPurpose, UploadStatus } from "../constants/enums.js";
import { createId } from "../lib/ids.js";
import { AppError, errors } from "../lib/app-error.js";
import { storageProvider } from "../integrations/storage.provider.js";
import { env } from "../config/env.js";
import { malwareScanProvider } from "../integrations/malware-scan.provider.js";

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
    completeUrl: `${req.baseUrl}/uploads/${id}/complete`,
  };
}

function sniffContentType(body) {
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8 && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9) return "image/jpeg";
  if (body.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  if (body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

async function verifyStoredObject(upload) {
  let body;
  if (env.PROVIDER_MODE === "mock") {
    try {
      body = await storageProvider.readObjectBody(upload.objectKey);
    } catch {
      throw errors.business("UPLOAD_NOT_FOUND", "The uploaded file was not found in storage.", { uploadId: upload._id });
    }
  } else {
    const head = await storageProvider.headObject(upload.objectKey);
    if (upload.sizeBytes != null && head.contentLength != null && head.contentLength !== upload.sizeBytes) {
      throw errors.business("UPLOAD_SIZE_MISMATCH", "The uploaded file size does not match what was declared.", { expectedBytes: upload.sizeBytes, actualBytes: head.contentLength });
    }
    body = await storageProvider.readObjectBody(upload.objectKey);
  }
  if (upload.sizeBytes != null && body.length !== upload.sizeBytes) {
    throw errors.business(
      "UPLOAD_SIZE_MISMATCH",
      "The uploaded file size does not match what was declared.",
      { expectedBytes: upload.sizeBytes, actualBytes: body.length },
    );
  }
  const detectedType = sniffContentType(body);
  if (!detectedType || detectedType !== upload.contentType) {
    throw errors.business(
      "UPLOAD_TYPE_MISMATCH",
      "The uploaded file signature does not match what was declared.",
      { expectedType: upload.contentType, actualType: detectedType },
    );
  }
  const scan = await malwareScanProvider.assertClean({ body, fileName: upload.fileName, contentType: detectedType });
  upload.scannedAt = new Date();
  upload.scanProvider = scan.provider ?? "external";
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

export async function getPublicUploadDownload(uploadId) {
  const upload = await Upload.findById(uploadId).lean();
  if (!upload || upload.purpose !== UploadPurpose.TENANT_LOGO) {
    throw errors.notFound("Upload");
  }
  if (upload.status === UploadStatus.PENDING || upload.status === UploadStatus.EXPIRED) {
    throw errors.notFound("Upload");
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
  entityType,
  entityId,
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
    if (upload.status === UploadStatus.ATTACHED && (upload.attachedEntityType !== entityType || upload.attachedEntityId !== entityId)) {
      throw new AppError("UPLOAD_ALREADY_ATTACHED", "This upload is already bound to another record.", 409, { uploadId: upload._id });
    }
  }
  await Upload.updateMany(
    { _id: { $in: ids }, tenantId: req.auth.tenantId, status: UploadStatus.UPLOADED },
    { $set: { status: UploadStatus.ATTACHED, attachedEntityType: entityType, attachedEntityId: entityId } },
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
    entityType: "CUSTOMER_KYC",
    entityId: req.params.customerId,
  });
}

export async function validateGrievanceUploadReferences(req, uploadIds, session, grievanceId) {
  if (!uploadIds?.length) return [];
  return validateUploadReferences({
    req,
    uploadIds,
    purpose: UploadPurpose.GRIEVANCE_ATTACHMENT,
    session,
    subjectId: req.auth.type === "CUSTOMER" ? req.auth.id : undefined,
    entityType: "GRIEVANCE",
    entityId: grievanceId ?? req.params.grievanceId,
  });
}
