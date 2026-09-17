import fs from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";

const MOCK_ROOT = path.join(process.cwd(), ".mock-storage");

function resolveMockPath(objectKey) {
  const normalized = path.normalize(objectKey).replace(/^(\.\.(\/|\\|$))+/, "");
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid object key");
  }
  const filePath = path.join(MOCK_ROOT, normalized);
  if (!filePath.startsWith(MOCK_ROOT)) throw new Error("Invalid object key");
  return { normalized, filePath };
}

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
  async uploadFile({ objectKey, body, contentType = "application/octet-stream" }) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
    if (env.PROVIDER_MODE === "mock") {
      const { filePath } = resolveMockPath(objectKey);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, payload);
      return objectKey;
    }
    await client.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey, Body: payload, ContentType: contentType }));
    return objectKey;
  },
  async readObjectBody(objectKey) {
    if (env.PROVIDER_MODE === "mock") {
      const { filePath } = resolveMockPath(objectKey);
      return fs.readFile(filePath);
    }
    const response = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }));
    return Buffer.from(await response.Body.transformToByteArray());
  },
  async headObject(objectKey) {
    if (env.PROVIDER_MODE === "mock") {
      const { filePath } = resolveMockPath(objectKey);
      const stat = await fs.stat(filePath);
      return { contentLength: stat.size, contentType: null };
    }
    const response = await client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }));
    return {
      contentLength: response.ContentLength ?? null,
      contentType: response.ContentType ?? null,
    };
  },
};
