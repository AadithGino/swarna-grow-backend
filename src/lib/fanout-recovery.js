import { JobStatus } from "../constants/enums.js";
import { now as calendarNow } from "./date.js";

const ACTIVE_BROADCAST_STATUSES = [JobStatus.QUEUED, JobStatus.PROCESSING];

function leaseAvailableClause(now) {
  return {
    $or: [
      { leaseExpiresAt: { $lte: now } },
      { leaseOwner: null },
      { leaseOwner: { $exists: false } },
    ],
  };
}

function resumeNotInFutureClause(now) {
  return {
    $or: [
      { fanoutResumeAt: null },
      { fanoutResumeAt: { $exists: false } },
      { fanoutResumeAt: { $lte: now } },
    ],
  };
}

/** Mongo filter for bounded fanout recovery: scheduling eligibility AND lease availability. */
export function buildActiveFanoutRecoveryFilter(now = new Date()) {
  const schedulingEligible = {
    $or: [
      {
        $and: [
          { fanoutContinuationPending: true },
          resumeNotInFutureClause(now),
        ],
      },
      {
        $and: [
          { fanoutContinuationPending: true },
          { fanoutResumeAt: { $gt: now } },
        ],
      },
      {
        $and: [
          { fanoutContinuationPending: { $ne: true } },
          { status: JobStatus.QUEUED },
          resumeNotInFutureClause(now),
        ],
      },
    ],
  };

  return {
    status: { $in: ACTIVE_BROADCAST_STATUSES },
    $and: [schedulingEligible, leaseAvailableClause(now)],
  };
}

export function isFutureFanoutDeferral(broadcast, now = calendarNow().toDate()) {
  if (!broadcast?.fanoutResumeAt) return false;
  return new Date(broadcast.fanoutResumeAt).getTime() > now.getTime();
}

export { ACTIVE_BROADCAST_STATUSES };
