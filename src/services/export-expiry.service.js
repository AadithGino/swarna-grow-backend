import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { ExportStatus } from "../constants/enums.js";
import { storageProvider } from "../integrations/storage.provider.js";
import { ExportJob } from "../models/index.js";

function downloadTtlMs() {
  return env.REPORT_EXPORT_DOWNLOAD_TTL_MS ?? 15 * 60_000;
}

function artifactRetentionMs() {
  return env.REPORT_EXPORT_ARTIFACT_RETENTION_MS ?? 7 * 86_400_000;
}

export async function purgeExpiredExportArtifacts(now = new Date()) {
  const artifactCutoff = new Date(now.getTime() - artifactRetentionMs());
  const stale = await ExportJob.find({
    status: ExportStatus.READY,
    updatedAt: { $lt: artifactCutoff },
    objectKey: { $exists: true, $ne: null },
  })
    .select("_id objectKey tenantId")
    .limit(100)
    .lean();

  let removed = 0;
  for (const job of stale) {
    try {
      await storageProvider.deleteObject(job.objectKey);
    } catch (error) {
      logger.warn({ exportId: job._id, err: error.message }, "Export object delete skipped");
    }
    await ExportJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: ExportStatus.EXPIRED,
          downloadExpiresAt: now,
        },
        $unset: { objectKey: "" },
      },
    );
    removed += 1;
  }
  return removed;
}

export function exportDownloadExpiresAt() {
  return new Date(Date.now() + downloadTtlMs());
}
