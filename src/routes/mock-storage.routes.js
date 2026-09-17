import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { databaseReady } from "../config/database.js";
import { env } from "../config/env.js";
import { UploadStatus } from "../constants/enums.js";
import { asyncHandler } from "../lib/async-handler.js";
import { AppError } from "../lib/app-error.js";
import { Upload } from "../models/index.js";

const mockStorageRouter = Router();
const MOCK_ROOT = path.join(process.cwd(), ".mock-storage");

export function mockStorageRouteEnabled({ providerMode = env.PROVIDER_MODE, nodeEnv = env.NODE_ENV } = {}) {
  return providerMode === "mock" && nodeEnv !== "production";
}

function decodeObjectKey(raw) {
  try {
    return decodeURIComponent(String(raw ?? ""));
  } catch {
    throw new AppError("INVALID_OBJECT_KEY", "The upload path is invalid.", 400);
  }
}

function resolveMockPath(objectKey) {
  const normalized = path.normalize(objectKey).replace(/^(\.\.(\/|\\|$))+/, "");
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new AppError("INVALID_OBJECT_KEY", "The upload path is invalid.", 400);
  }
  const filePath = path.join(MOCK_ROOT, normalized);
  if (!filePath.startsWith(MOCK_ROOT)) {
    throw new AppError("INVALID_OBJECT_KEY", "The upload path is invalid.", 400);
  }
  return { normalized, filePath };
}

async function markUploadStored(objectKey) {
  if (!databaseReady()) return;
  const uploadId = objectKey.split("/")[2];
  if (!uploadId?.startsWith("upl_")) return;
  try {
    await Upload.updateOne(
      { _id: uploadId, objectKey },
      { $set: { status: UploadStatus.UPLOADED } },
    );
  } catch {
    /* mock upload bytes are stored; Upload row is best-effort */
  }
}

/** Dev mock for S3 presigned PUT/GET when PROVIDER_MODE=mock. */
mockStorageRouter.put(
  "/:encodedKey",
  asyncHandler(async (req, res) => {
    if (!mockStorageRouteEnabled()) {
      throw new AppError("ROUTE_NOT_FOUND", "Mock storage is not enabled.", 404);
    }
    const { normalized, filePath } = resolveMockPath(decodeObjectKey(req.params.encodedKey));
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
    await markUploadStored(normalized);
    res.status(204).end();
  }),
);

mockStorageRouter.get(
  "/:encodedKey",
  asyncHandler(async (req, res) => {
    if (!mockStorageRouteEnabled()) {
      throw new AppError("ROUTE_NOT_FOUND", "Mock storage is not enabled.", 404);
    }
    const { filePath } = resolveMockPath(decodeObjectKey(req.params.encodedKey));
    try {
      const data = await fs.readFile(filePath);
      const contentType = req.query.contentType ?? "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      res.send(data);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new AppError("RESOURCE_NOT_FOUND", "The uploaded file was not found.", 404);
      }
      throw error;
    }
  }),
);

export { mockStorageRouter };
