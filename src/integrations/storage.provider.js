import { PutObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";

const client = new S3Client({ region: env.S3_REGION, endpoint: env.S3_ENDPOINT || undefined, forcePathStyle: Boolean(env.S3_ENDPOINT), credentials: env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } : undefined });
export const storageProvider = {
  async presignUpload({ objectKey, contentType }) {
    if (env.PROVIDER_MODE === "mock") return `http://localhost:${env.PORT}/mock-storage/${encodeURIComponent(objectKey)}`;
    return getSignedUrl(client, new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey, ContentType: contentType }), { expiresIn: 900 });
  },
  async presignDownload(objectKey) {
    if (env.PROVIDER_MODE === "mock") return `http://localhost:${env.PORT}/mock-storage/${encodeURIComponent(objectKey)}`;
    return getSignedUrl(client, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }), { expiresIn: 900 });
  },
};
