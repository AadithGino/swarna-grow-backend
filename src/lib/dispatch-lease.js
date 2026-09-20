import { DispatchState, MessageStatus } from "../constants/enums.js";
import { env } from "../config/env.js";
import { incrementOpsMetric, OpsMetric } from "./ops-metrics.js";

export function dispatchLeaseMs() {
  return env.MESSAGE_DISPATCH_LEASE_MS ?? 120_000;
}

export function dispatchDispatchedStaleMs() {
  return env.MESSAGE_DISPATCH_DISPATCHED_STALE_MS ?? env.MESSAGE_DISPATCH_STALE_MS ?? 900_000;
}

/** Mongo filter: eligible to claim a dispatch lease at `now`. */
export function dispatchClaimEligibleFilter(now = new Date()) {
  return {
    $or: [
      { dispatchState: { $in: [null, DispatchState.PENDING] } },
      { dispatchState: { $exists: false }, enqueuedAt: { $exists: false } },
      { dispatchState: { $exists: false }, enqueuedAt: null },
      {
        dispatchState: { $exists: false },
        enqueuedAt: { $lte: new Date(now.getTime() - dispatchDispatchedStaleMs()) },
      },
      {
        dispatchState: DispatchState.DISPATCHING,
        dispatchLeaseExpiresAt: { $lte: now },
      },
      {
        dispatchState: DispatchState.DISPATCHED,
        dispatchedAt: { $lte: new Date(now.getTime() - dispatchDispatchedStaleMs()) },
      },
    ],
  };
}

export function newDispatchLease(owner, now = new Date()) {
  const leaseExpiresAt = new Date(now.getTime() + dispatchLeaseMs());
  return {
    dispatchState: DispatchState.DISPATCHING,
    dispatchLeaseOwner: owner,
    dispatchLeaseExpiresAt: leaseExpiresAt,
    lastDispatchAttemptAt: now,
  };
}

export function dispatchAckUpdate(now = new Date()) {
  return {
    $set: {
      dispatchState: DispatchState.DISPATCHED,
      dispatchedAt: now,
    },
    $unset: {
      dispatchLeaseOwner: "",
      dispatchLeaseExpiresAt: "",
      enqueuedAt: "",
    },
  };
}

export function dispatchReleaseUpdate() {
  return {
    $set: { dispatchState: DispatchState.PENDING },
    $unset: {
      dispatchLeaseOwner: "",
      dispatchLeaseExpiresAt: "",
      enqueuedAt: "",
    },
  };
}

export function dispatchReclaimExpiredUpdate() {
  return {
    $set: { dispatchState: DispatchState.PENDING },
    $unset: {
      dispatchLeaseOwner: "",
      dispatchLeaseExpiresAt: "",
      dispatchedAt: "",
      enqueuedAt: "",
    },
  };
}

/**
 * @param {import("mongoose").Model} model
 * @param {object} extraFilter
 * @param {string} id
 * @param {string} owner
 */
export async function claimDispatchLease(model, extraFilter, id, owner) {
  const now = new Date();
  return model.findOneAndUpdate(
    {
      _id: id,
      ...extraFilter,
      ...dispatchClaimEligibleFilter(now),
    },
    {
      $set: newDispatchLease(owner, now),
      $inc: { dispatchAttemptCount: 1 },
    },
    { new: true },
  ).lean();
}

export async function acknowledgeDispatch(model, id, owner) {
  const now = new Date();
  const updated = await model.findOneAndUpdate(
    {
      _id: id,
      dispatchState: DispatchState.DISPATCHING,
      dispatchLeaseOwner: owner,
    },
    dispatchAckUpdate(now),
    { new: true },
  ).lean();
  if (updated) incrementOpsMetric(OpsMetric.DISPATCH_ACK, 1);
  return updated;
}

export async function releaseDispatchLease(model, id, owner) {
  const updated = await model.findOneAndUpdate(
    {
      _id: id,
      dispatchState: DispatchState.DISPATCHING,
      dispatchLeaseOwner: owner,
    },
    dispatchReleaseUpdate(),
    { new: true },
  ).lean();
  if (updated) incrementOpsMetric(OpsMetric.DISPATCH_RELEASE, 1);
  return updated;
}

/**
 * @param {import("mongoose").Model} model
 * @param {object} statusFilter e.g. { status: "QUEUED" }
 * @param {number} limit
 */
export async function reclaimExpiredDispatchLeases(model, statusFilter, limit = 200) {
  const now = new Date();
  const staleDispatchedBefore = new Date(now.getTime() - dispatchDispatchedStaleMs());
  const ids = await model
    .find({
      ...statusFilter,
      $or: [
        {
          dispatchState: DispatchState.DISPATCHING,
          dispatchLeaseExpiresAt: { $lte: now },
        },
        {
          dispatchState: DispatchState.DISPATCHED,
          dispatchedAt: { $lte: staleDispatchedBefore },
        },
      ],
    })
    .sort({ dispatchLeaseExpiresAt: 1, dispatchedAt: 1 })
    .limit(limit)
    .select("_id dispatchState")
    .lean();

  if (!ids.length) return 0;

  let reclaimed = 0;
  for (const row of ids) {
    const filter =
      row.dispatchState === DispatchState.DISPATCHING
        ? {
            _id: row._id,
            dispatchState: DispatchState.DISPATCHING,
            dispatchLeaseExpiresAt: { $lte: now },
          }
        : {
            _id: row._id,
            dispatchState: DispatchState.DISPATCHED,
            dispatchedAt: { $lte: staleDispatchedBefore },
          };
    const result = await model.updateOne(filter, dispatchReclaimExpiredUpdate());
    if (result.modifiedCount) reclaimed += 1;
  }
  if (reclaimed) incrementOpsMetric(OpsMetric.DISPATCH_LEASE_RECLAIMED, reclaimed);
  return reclaimed;
}

export const messageDispatchStatusFilter = {
  status: MessageStatus.QUEUED,
};
