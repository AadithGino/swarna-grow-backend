import { UploadPurpose, UploadStatus } from "../constants/enums.js";
import { env } from "../config/env.js";
import { Upload } from "../models/index.js";
import { storageProvider } from "../integrations/storage.provider.js";

const PRESIGN_SEC = 900;

/**
 * Resolve one image URL for an entire broadcast when it remains valid long enough for FCM TTL.
 */
export async function resolvePromotionPushImage(uploadId, { tenantId } = {}) {
  if (!uploadId) return { imageUrl: null, validUntil: null };
  const upload = await Upload.findOne({ _id: uploadId, tenantId }).lean();
  if (!upload) return { imageUrl: null, validUntil: null };
  if (
    upload.purpose !== UploadPurpose.ECOMMERCE_PRODUCT_IMAGE
    && upload.purpose !== UploadPurpose.ECOMMERCE_CATEGORY_IMAGE
  ) {
    return { imageUrl: null, validUntil: null };
  }
  if (upload.status === UploadStatus.PENDING || upload.status === UploadStatus.EXPIRED) {
    return { imageUrl: null, validUntil: null };
  }
  const fcmTtlSec = env.FCM_DEFAULT_TTL_SEC ?? 86_400;
  if (fcmTtlSec > PRESIGN_SEC) {
    return { imageUrl: null, validUntil: null };
  }
  const url = await storageProvider.presignDownload(upload.objectKey);
  const validUntil = new Date(Date.now() + PRESIGN_SEC * 1000);
  return { imageUrl: url, validUntil };
}

export async function resolveBroadcastPushImage(imageUploadId) {
  if (!imageUploadId) return { imageUrl: null, validUntil: null };
  const upload = await Upload.findById(imageUploadId).lean();
  if (!upload) return { imageUrl: null, validUntil: null };
  if (
    upload.purpose !== UploadPurpose.PUSH_BROADCAST_IMAGE
    && upload.purpose !== UploadPurpose.TENANT_LOGO
  ) {
    return { imageUrl: null, validUntil: null };
  }
  if (upload.status === UploadStatus.PENDING || upload.status === UploadStatus.EXPIRED) {
    return { imageUrl: null, validUntil: null };
  }
  const fcmTtlSec = env.FCM_DEFAULT_TTL_SEC ?? 86_400;
  if (fcmTtlSec > PRESIGN_SEC) {
    return { imageUrl: null, validUntil: null };
  }
  const url = await storageProvider.presignDownload(upload.objectKey);
  const validUntil = new Date(Date.now() + PRESIGN_SEC * 1000);
  return { imageUrl: url, validUntil };
}
