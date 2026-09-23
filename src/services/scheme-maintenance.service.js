import { AuditEntityType, SchemeStatus } from "../constants/enums.js";
import { env } from "../config/env.js";
import { isFlexibleLockDueAfterFreePhase } from "../lib/calendar-cycle.js";
import { incrementOpsMetric, OpsMetric } from "../lib/ops-metrics.js";
import { Customer, Grievance, Message, Scheme } from "../models/index.js";
import { writeAudit } from "./audit.service.js";
import { logger } from "../config/logger.js";
import {
  MaintenanceScanStream,
  runRotatingMaintenanceScan,
} from "../lib/maintenance-scan-cursor.js";
import { assessNormalMaturityTransitionEligibility } from "../lib/maturity-eligibility.js";

function batchSize() {
  return env.SCHEME_MAINTENANCE_BATCH_SIZE ?? 200;
}

function maxBatchesPerRun() {
  return env.SCHEME_MAINTENANCE_MAX_BATCHES_PER_RUN ?? 50;
}

function recordBatch(processed, skipped = 0, conflict = 0) {
  if (processed) incrementOpsMetric(OpsMetric.SCHEDULER_BATCH_PROCESSED, processed);
  if (skipped) incrementOpsMetric(OpsMetric.SCHEDULER_BATCH_SKIPPED, skipped);
  if (conflict) incrementOpsMetric(OpsMetric.SCHEDULER_BATCH_CONFLICT, conflict);
}

export async function runMaturityTransitionBatch({ today, cursor = null }) {
  const limit = batchSize();
  const query = {
    status: { $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED, SchemeStatus.DEFAULTED] },
    maturityDate: { $lt: today },
    ...(cursor ? { _id: { $gt: cursor } } : {}),
  };
  const rows = await Scheme.find(query)
    .sort({ _id: 1 })
    .limit(limit)
    .select(
      "_id tenantId branchId customerId enrollmentNumber maturityDate status paymentPattern planSnapshot installments cycles version",
    )
    .lean();

  let processed = 0;
  let notifications = 0;
  for (const scheme of rows) {
    const transition = assessNormalMaturityTransitionEligibility(scheme, today);
    if (!transition.eligible) {
      if (
        transition.calendarEligible &&
        !transition.paymentEligible &&
        [SchemeStatus.ACTIVE, SchemeStatus.LOCKED].includes(scheme.status)
      ) {
        const defaulted = await Scheme.findOneAndUpdate(
          {
            _id: scheme._id,
            status: scheme.status,
            maturityDate: scheme.maturityDate,
          },
          { $set: { status: SchemeStatus.DEFAULTED }, $inc: { version: 1 } },
          { new: true },
        );
        if (defaulted) {
          await writeAudit({
            req: {
              auth: { id: "scheduler", tenantId: scheme.tenantId, type: "SYSTEM" },
              headers: {},
              ip: "scheduler",
            },
            action: "SCHEME_DEFAULTED",
            entityType: AuditEntityType.SCHEME,
            entityId: scheme._id,
            before: scheme,
            after: defaulted.toObject(),
            actorType: "SYSTEM",
          });
        }
      }
      continue;
    }
    const updated = await Scheme.findOneAndUpdate(
      {
        _id: scheme._id,
        status: scheme.status,
        maturityDate: scheme.maturityDate,
      },
      { $set: { status: SchemeStatus.MATURED }, $inc: { version: 1 } },
      { new: true },
    );
    if (!updated) continue;
    processed += 1;
    const exists = await Message.exists({
      tenantId: scheme.tenantId,
      schemeId: scheme._id,
      type: "SCHEME_MATURED",
      "templateParams.event": "MATURITY_DAY",
    });
    if (exists) continue;
    const customer = await Customer.findOne({
      _id: scheme.customerId,
      tenantId: scheme.tenantId,
    })
      .select("mobile")
      .lean();
    if (!customer) continue;
    const { queueCustomerNotification } = await import("./customer-notification.service.js");
    await queueCustomerNotification({
      tenantId: scheme.tenantId,
      branchId: scheme.branchId,
      customerId: scheme.customerId,
      schemeId: scheme._id,
      type: "SCHEME_MATURED",
      templateParams: {
        mobile: customer.mobile,
        enrollmentNumber: scheme.enrollmentNumber,
        event: "MATURITY_DAY",
      },
    });
    notifications += 1;
  }
  recordBatch(processed);
  return {
    processed,
    notifications,
    cursor: rows.length ? rows[rows.length - 1]._id : cursor,
    hasMore: rows.length === limit,
  };
}

export async function runMaturityMaintenance({ today }) {
  let cursor = null;
  let total = 0;
  for (let i = 0; i < maxBatchesPerRun(); i += 1) {
    const batch = await runMaturityTransitionBatch({ today, cursor });
    total += batch.processed;
    if (!batch.hasMore) break;
    cursor = batch.cursor;
  }
  return { processed: total };
}

export async function runDueInstallmentBatch({ today, cursor = null }) {
  const limit = batchSize();
  const query = {
    status: { $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED, SchemeStatus.DEFAULTED] },
    paymentPattern: "FIXED",
    installments: {
      $elemMatch: {
        dueDate: { $lte: today },
        status: "PENDING",
      },
    },
    ...(cursor ? { _id: { $gt: cursor } } : {}),
  };
  const rows = await Scheme.find(query).sort({ _id: 1 }).limit(limit).select("_id").lean();
  let processed = 0;
  for (const row of rows) {
    const r = await Scheme.updateOne(
      { _id: row._id },
      {
        $set: { "installments.$[inst].status": "DUE" },
        $inc: { version: 1 },
      },
      {
        arrayFilters: [{
          "inst.dueDate": { $lte: today },
          "inst.status": "PENDING",
        }],
      },
    );
    if (r.modifiedCount) processed += 1;
  }
  recordBatch(processed);
  return {
    processed,
    cursor: rows.length ? rows[rows.length - 1]._id : cursor,
    hasMore: rows.length === limit,
  };
}

export async function runDueInstallmentMaintenance({ today }) {
  let cursor = null;
  let total = 0;
  for (let i = 0; i < maxBatchesPerRun(); i += 1) {
    const batch = await runDueInstallmentBatch({ today, cursor });
    total += batch.processed;
    if (!batch.hasMore) break;
    cursor = batch.cursor;
  }
  return { processed: total };
}

export async function runOverdueInstallmentBatch({ today, cursor = null }) {
  const limit = batchSize();
  const query = {
    status: SchemeStatus.ACTIVE,
    paymentPattern: "FIXED",
    installments: {
      $elemMatch: {
        graceEndsAt: { $lt: today },
        status: { $in: ["DUE", "PARTIALLY_PAID"] },
      },
    },
    ...(cursor ? { _id: { $gt: cursor } } : {}),
  };
  const rows = await Scheme.find(query).sort({ _id: 1 }).limit(limit).select("_id").lean();
  let processed = 0;
  for (const row of rows) {
    const r = await Scheme.updateOne(
      { _id: row._id },
      {
        $set: { "installments.$[inst].status": "OVERDUE" },
        $inc: { version: 1 },
      },
      {
        arrayFilters: [{
          "inst.graceEndsAt": { $lt: today },
          "inst.status": { $in: ["DUE", "PARTIALLY_PAID"] },
        }],
      },
    );
    if (r.modifiedCount) processed += 1;
  }
  recordBatch(processed);
  return {
    processed,
    cursor: rows.length ? rows[rows.length - 1]._id : cursor,
    hasMore: rows.length === limit,
  };
}

export async function runOverdueMaintenance({ today }) {
  let cursor = null;
  let total = 0;
  for (let i = 0; i < maxBatchesPerRun(); i += 1) {
    const batch = await runOverdueInstallmentBatch({ today, cursor });
    total += batch.processed;
    if (!batch.hasMore) break;
    cursor = batch.cursor;
  }
  return { processed: total };
}

export async function runDefaultingBatch({ cursor = null, limit: limitOverride = null } = {}) {
  const limit = limitOverride ?? batchSize();
  const query = {
    status: SchemeStatus.ACTIVE,
    paymentPattern: "FIXED",
    ...(cursor ? { _id: { $gt: cursor } } : {}),
  };
  const schemes = await Scheme.find(query)
    .sort({ _id: 1 })
    .limit(limit)
    .select("_id tenantId branchId planSnapshot installments version status")
    .lean();

  let processed = 0;
  let skipped = 0;
  let conflicted = 0;
  for (const scheme of schemes) {
    const threshold = scheme.planSnapshot?.benefit?.eligibility?.maxAllowedDefaults;
    if (threshold == null) {
      skipped += 1;
      continue;
    }
    const overdueCount = (scheme.installments ?? []).filter((row) => row.status === "OVERDUE").length;
    if (overdueCount === 0 || overdueCount <= threshold) {
      skipped += 1;
      continue;
    }
    const updated = await Scheme.findOneAndUpdate(
      { _id: scheme._id, status: SchemeStatus.ACTIVE },
      { $set: { status: SchemeStatus.DEFAULTED }, $inc: { version: 1 } },
      { new: true },
    );
    if (!updated) {
      conflicted += 1;
      continue;
    }
    processed += 1;
    await writeAudit({
      req: {
        auth: { id: "scheduler", tenantId: scheme.tenantId, type: "SYSTEM" },
        headers: {},
        ip: "scheduler",
      },
      action: "SCHEME_DEFAULTED",
      entityType: AuditEntityType.SCHEME,
      entityId: scheme._id,
      before: scheme,
      after: updated.toObject(),
      actorType: "SYSTEM",
    });
  }
  recordBatch(processed, skipped, conflicted);
  return {
    processed,
    scanned: schemes.length,
    skipped,
    conflicted,
    cursor: schemes.length ? schemes[schemes.length - 1]._id : cursor,
    lastCursor: schemes.length ? schemes[schemes.length - 1]._id : cursor,
    hasMore: schemes.length === limit,
  };
}

export async function runDefaultingMaintenance(options = {}) {
  const rotation = await runRotatingMaintenanceScan({
    stream: MaintenanceScanStream.DEFAULTING,
    maxBatches: options.maxBatches ?? maxBatchesPerRun(),
    runBatch: (cursor) => runDefaultingBatch({
      cursor,
      limit: options.batchSize ?? null,
    }),
  });
  return {
    processed: rotation.processed,
    scanned: rotation.scanned,
    skipped: rotation.skipped,
    conflicted: rotation.conflicted,
    failed: rotation.failed,
    hasMore: rotation.hasMore,
    remainingBacklog: rotation.remainingBacklog,
    continuationScheduled: rotation.continuationScheduled,
    wrapped: rotation.wrapped,
    cursorEnd: rotation.cursorEnd,
    leaseBusy: Boolean(rotation.leaseBusy),
    ownershipLost: Boolean(rotation.ownershipLost),
    batchesRun: rotation.batchesRun ?? 0,
  };
}

export async function runExpireFlexibleCapacityBatch({ today, cursor = null }) {
  const limit = batchSize();
  const query = {
    paymentPattern: "FLEXIBLE",
    cycles: {
      $elemMatch: {
        expiresAt: { $lt: today },
        status: { $in: ["UPCOMING", "PARTIALLY_PAID"] },
      },
    },
    ...(cursor ? { _id: { $gt: cursor } } : {}),
  };
  const rows = await Scheme.find(query).sort({ _id: 1 }).limit(limit).select("_id").lean();
  let processed = 0;
  for (const row of rows) {
    const r = await Scheme.updateOne(
      { _id: row._id },
      {
        $set: {
          "cycles.$[c].status": "EXPIRED",
          "cycles.$[c].remainingPaise": 0,
        },
        $inc: { positionVersion: 1, version: 1 },
      },
      {
        arrayFilters: [{
          "c.expiresAt": { $lt: today },
          "c.status": { $in: ["UPCOMING", "PARTIALLY_PAID"] },
        }],
      },
    );
    if (r.modifiedCount) processed += 1;
  }
  recordBatch(processed);
  return {
    processed,
    cursor: rows.length ? rows[rows.length - 1]._id : cursor,
    hasMore: rows.length === limit,
  };
}

export async function runExpireFlexibleCapacityMaintenance({ today }) {
  let cursor = null;
  let total = 0;
  for (let i = 0; i < maxBatchesPerRun(); i += 1) {
    const batch = await runExpireFlexibleCapacityBatch({ today, cursor });
    total += batch.processed;
    if (!batch.hasMore) break;
    cursor = batch.cursor;
  }
  return { processed: total };
}

export async function runFlexibleLockBatch({ today, cursor = null, limit: limitOverride = null }) {
  const limit = limitOverride ?? batchSize();
  const query = {
    paymentPattern: "FLEXIBLE",
    flexiblePhase: "FLEXIBLE",
    status: { $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED] },
    ...(cursor ? { _id: { $gt: cursor } } : {}),
  };
  const schemes = await Scheme.find(query)
    .sort({ _id: 1 })
    .limit(limit)
    .select("_id tenantId branchId customerId enrollmentNumber startDate planSnapshot cycles")
    .lean();

  let processed = 0;
  let skipped = 0;
  let conflicted = 0;
  const { applyFlexibleLock } = await import("./scheme.service.js");
  const { queueCustomerNotification } = await import("./customer-notification.service.js");

  for (const scheme of schemes) {
    const freeCycles = scheme.planSnapshot?.flexibleRules?.flexiblePhaseCycles ?? 0;
    if (!freeCycles) {
      skipped += 1;
      continue;
    }
    if (!isFlexibleLockDueAfterFreePhase(today, scheme.cycles ?? [], freeCycles)) {
      skipped += 1;
      continue;
    }
    try {
      const locked = await applyFlexibleLock({
        auth: { id: "scheduler", tenantId: scheme.tenantId, type: "SYSTEM" },
        scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
        params: { schemeId: scheme._id },
        headers: {},
        ip: "scheduler",
      });
      processed += 1;
      const customer = await Customer.findOne({
        _id: scheme.customerId,
        tenantId: scheme.tenantId,
      })
        .select("mobile")
        .lean();
      if (customer && locked?.flexiblePhase === "CAPPED") {
        await queueCustomerNotification({
          tenantId: scheme.tenantId,
          branchId: scheme.branchId,
          customerId: scheme.customerId,
          schemeId: scheme._id,
          type: "FLEXI_LOCK_APPLIED",
          templateParams: {
            mobile: customer.mobile,
            enrollmentNumber: scheme.enrollmentNumber,
            event: "LOCK_APPLIED",
          },
        });
      }
    } catch (error) {
      if (error?.code === "LOCK_ALREADY_APPLIED" || error?.code === "FLEXIBLE_LOCK_NOT_DUE") {
        skipped += 1;
      } else {
        conflicted += 1;
        logger.warn({ schemeId: scheme._id, err: error.message }, "Flexible lock job skipped scheme");
      }
    }
  }
  recordBatch(processed, skipped, conflicted);
  return {
    processed,
    scanned: schemes.length,
    skipped,
    conflicted,
    cursor: schemes.length ? schemes[schemes.length - 1]._id : cursor,
    lastCursor: schemes.length ? schemes[schemes.length - 1]._id : cursor,
    hasMore: schemes.length === limit,
  };
}

export async function runFlexibleLockMaintenance({ today, maxBatches, batchSize }) {
  const rotation = await runRotatingMaintenanceScan({
    stream: MaintenanceScanStream.FLEXIBLE_LOCK,
    maxBatches: maxBatches ?? maxBatchesPerRun(),
    runBatch: (cursor) => runFlexibleLockBatch({
      today,
      cursor,
      limit: batchSize ?? null,
    }),
  });
  return {
    processed: rotation.processed,
    scanned: rotation.scanned,
    skipped: rotation.skipped,
    conflicted: rotation.conflicted,
    failed: rotation.failed,
    hasMore: rotation.hasMore,
    remainingBacklog: rotation.remainingBacklog,
    continuationScheduled: rotation.continuationScheduled,
    wrapped: rotation.wrapped,
    cursorEnd: rotation.cursorEnd,
    leaseBusy: Boolean(rotation.leaseBusy),
    ownershipLost: Boolean(rotation.ownershipLost),
    batchesRun: rotation.batchesRun ?? 0,
  };
}

export async function runGrievanceAutoCloseBatch({ cutoff, cursor = null }) {
  const limit = batchSize();
  const query = {
    status: "RESOLVED",
    resolvedAt: { $lt: cutoff },
    ...(cursor ? { _id: { $gt: cursor } } : {}),
  };
  const rows = await Grievance.find(query).sort({ _id: 1 }).limit(limit).select("_id").lean();
  if (!rows.length) {
    return { processed: 0, cursor, hasMore: false };
  }
  const ids = rows.map((row) => row._id);
  const now = new Date();
  const r = await Grievance.updateMany(
    { _id: { $in: ids }, status: "RESOLVED", resolvedAt: { $lt: cutoff } },
    { $set: { status: "CLOSED", closedAt: now }, $inc: { version: 1 } },
  );
  recordBatch(r.modifiedCount ?? 0);
  return {
    processed: r.modifiedCount ?? 0,
    cursor: rows[rows.length - 1]._id,
    hasMore: rows.length === limit,
  };
}

export async function runGrievanceAutoCloseMaintenance(now = new Date()) {
  const cutoff = new Date(now.getTime() - 7 * 86_400_000);
  let cursor = null;
  let total = 0;
  for (let i = 0; i < maxBatchesPerRun(); i += 1) {
    const batch = await runGrievanceAutoCloseBatch({ cutoff, cursor });
    total += batch.processed;
    if (!batch.hasMore) break;
    cursor = batch.cursor;
  }
  return { processed: total };
}
