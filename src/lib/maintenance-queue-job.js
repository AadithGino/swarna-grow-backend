import { logger } from "../config/logger.js";
import { randomToken } from "./crypto.js";

const TERMINAL_STATES = new Set(["completed", "failed"]);

/**
 * Schedule a maintenance-queue job, reusing waiting/delayed/active work and replacing terminal retained jobs.
 */
export async function ensureRunnableMaintenanceJob(queue, jobName, data, preferredJobId, jobOptions = {}) {
  if (!queue) {
    return { scheduled: false, reason: "NO_QUEUE" };
  }

  let job = await queue.getJob(preferredJobId);
  if (job) {
    const state = await job.getState();
    if (state === "waiting" || state === "delayed" || state === "active") {
      return { scheduled: false, alreadyPending: true, jobId: preferredJobId, state };
    }
    if (TERMINAL_STATES.has(state)) {
      try {
        await job.remove();
      } catch (error) {
        logger.warn({ err: error, jobId: preferredJobId, state }, "Could not remove terminal maintenance job");
        const altId = `${preferredJobId}-r-${Date.now()}-${randomToken(4)}`;
        await queue.add(jobName, data, { ...jobOptions, jobId: altId });
        return { scheduled: true, jobId: altId, recoveredFrom: state };
      }
      job = null;
    }
  }

  if (!job) {
    try {
      await queue.add(jobName, data, { ...jobOptions, jobId: preferredJobId });
      return { scheduled: true, jobId: preferredJobId };
    } catch (error) {
      const msg = String(error?.message ?? "");
      if (msg.includes("Job") && msg.includes("exists")) {
        const existing = await queue.getJob(preferredJobId);
        const state = existing ? await existing.getState() : "unknown";
        if (existing && (state === "waiting" || state === "delayed" || state === "active")) {
          return { scheduled: false, alreadyPending: true, jobId: preferredJobId, state };
        }
        const altId = `${preferredJobId}-r-${Date.now()}-${randomToken(4)}`;
        await queue.add(jobName, data, { ...jobOptions, jobId: altId });
        return { scheduled: true, jobId: altId, deduped: true };
      }
      throw error;
    }
  }

  return { scheduled: false, jobId: preferredJobId };
}
