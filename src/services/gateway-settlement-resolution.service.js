import { AlertType } from "../constants/enums.js";
import { ROLE_SCOPE } from "../constants/permissions.js";
import { errors } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { reopenOperationalAlert, resolveOperationalAlert } from "../lib/operational-alert.js";
import { withTransaction } from "../lib/transaction.js";
import {
  SettlementMismatch,
  SettlementMismatchStatus,
  SettlementResolutionAction,
  SettlementRun,
} from "../models/gateway-settlement.models.js";
import { writeAudit } from "./audit.service.js";
import { AuditEntityType } from "../constants/enums.js";

function scopeFilter(req) {
  const filter = { tenantId: req.auth.tenantId };
  const roleScope = ROLE_SCOPE[req.auth.role] ?? "BRANCH";
  if (roleScope === "BRANCH" && req.scope.branchId) {
    filter.branchId = req.scope.branchId;
  }
  return filter;
}

export async function listSettlementMismatches(req) {
  const status = req.query.status ?? SettlementMismatchStatus.OPEN;
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  return SettlementMismatch.find({ ...scopeFilter(req), status })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

export async function getSettlementMismatch(req) {
  const row = await SettlementMismatch.findOne({
    _id: req.params.mismatchId,
    ...scopeFilter(req),
  }).lean();
  if (!row) throw errors.notFound("Settlement mismatch");
  return row;
}

async function maybeResolveRunAlert(tenantId, runId, session) {
  const openCount = await SettlementMismatch.countDocuments({
    tenantId,
    runId,
    status: SettlementMismatchStatus.OPEN,
  }).session(session);
  if (openCount === 0) {
    await resolveOperationalAlert({
      tenantId,
      type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
      entityId: runId,
      session,
    });
  }
}

export async function resolveSettlementMismatch(req) {
  const category = req.body.category;
  const reason = String(req.body.reason ?? "").trim();
  if (!reason) throw errors.business("RESOLUTION_REASON_REQUIRED", "Resolution reason is required.");
  const idempotencyKey = req.headers["x-idempotency-key"];
  if (!idempotencyKey) {
    throw errors.business("IDEMPOTENCY_KEY_REQUIRED", "x-idempotency-key header is required.");
  }

  let outcome;
  await withTransaction(async (session) => {
    const row = await SettlementMismatch.findOne({
      _id: req.params.mismatchId,
      ...scopeFilter(req),
      status: SettlementMismatchStatus.OPEN,
    }).session(session);
    if (!row) throw errors.notFound("Settlement mismatch");

    const prior = row.resolutionHistory?.find(
      (entry) => entry.idempotencyKey === idempotencyKey && entry.action === SettlementResolutionAction.RESOLVE,
    );
    if (prior) {
      outcome = { mismatchId: row._id, status: SettlementMismatchStatus.RESOLVED, reused: true };
      return;
    }

    const expectedVersion = req.body.expectedVersion;
    if (expectedVersion != null && row.version !== expectedVersion) {
      throw errors.business("VERSION_CONFLICT", "Settlement mismatch was updated concurrently.");
    }

    row.status = SettlementMismatchStatus.RESOLVED;
    row.version += 1;
    row.resolvedAt = new Date();
    row.resolvedBy = req.auth.id;
    row.resolutionHistory.push({
      action: SettlementResolutionAction.RESOLVE,
      category,
      reason,
      actorId: req.auth.id,
      at: new Date(),
      idempotencyKey,
    });
    await row.save({ session });

    await writeAudit({
      req,
      action: "GATEWAY_SETTLEMENT_MISMATCH_RESOLVED",
      entityType: AuditEntityType.PAYMENT,
      entityId: row._id,
      after: { runId: row.runId, category, reason },
      metadata: { idempotencyKey },
      session,
    });

    await maybeResolveRunAlert(req.auth.tenantId, row.runId, session);
    outcome = { mismatchId: row._id, status: SettlementMismatchStatus.RESOLVED, reused: false };
  });
  return outcome;
}

export async function reopenSettlementMismatch(req) {
  const reason = String(req.body.reason ?? "").trim();
  if (!reason) throw errors.business("REOPEN_REASON_REQUIRED", "Reopen reason is required.");
  const idempotencyKey = req.headers["x-idempotency-key"];
  if (!idempotencyKey) {
    throw errors.business("IDEMPOTENCY_KEY_REQUIRED", "x-idempotency-key header is required.");
  }

  let outcome;
  await withTransaction(async (session) => {
    const row = await SettlementMismatch.findOne({
      _id: req.params.mismatchId,
      ...scopeFilter(req),
      status: SettlementMismatchStatus.RESOLVED,
    }).session(session);
    if (!row) throw errors.notFound("Settlement mismatch");

    const prior = row.resolutionHistory?.find(
      (entry) => entry.idempotencyKey === idempotencyKey && entry.action === SettlementResolutionAction.REOPEN,
    );
    if (prior) {
      outcome = { mismatchId: row._id, status: SettlementMismatchStatus.OPEN, reused: true };
      return;
    }

    const run = await SettlementRun.findOne({ _id: row.runId, tenantId: req.auth.tenantId }).session(session).lean();
    if (!run) throw errors.notFound("Settlement run");

    row.status = SettlementMismatchStatus.OPEN;
    row.version += 1;
    row.resolvedAt = null;
    row.resolvedBy = null;
    row.resolutionHistory.push({
      action: SettlementResolutionAction.REOPEN,
      reason,
      actorId: req.auth.id,
      at: new Date(),
      idempotencyKey,
    });
    await row.save({ session });

    await reopenOperationalAlert({
      tenantId: req.auth.tenantId,
      type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
      entityId: row.runId,
      title: "PhonePe settlement mismatch",
      message: "A resolved settlement mismatch was reopened for review.",
      metadata: { mismatchId: row._id, businessDate: run.businessDate },
      session,
    });

    await writeAudit({
      req,
      action: "GATEWAY_SETTLEMENT_MISMATCH_REOPENED",
      entityType: AuditEntityType.PAYMENT,
      entityId: row._id,
      after: { runId: row.runId, reason },
      metadata: { idempotencyKey },
      session,
    });

    outcome = { mismatchId: row._id, status: SettlementMismatchStatus.OPEN, reused: false };
  });
  return outcome;
}

export async function syncSettlementMismatchesForRun({
  tenantId,
  runId,
  mismatches,
  session = null,
}) {
  const ops = [];
  for (const mismatch of mismatches) {
    ops.push({
      updateOne: {
        filter: { tenantId, runId, itemId: mismatch.itemId },
        update: {
          $setOnInsert: {
            _id: createId("smm"),
            tenantId,
            branchId: mismatch.branchId,
            runId,
            itemId: mismatch.itemId,
            reason: mismatch.reason,
            status: SettlementMismatchStatus.OPEN,
            version: 0,
            resolutionHistory: [],
          },
        },
        upsert: true,
      },
    });
  }
  if (ops.length) {
    await SettlementMismatch.bulkWrite(ops, session ? { session } : {});
  }
  const itemIds = new Set(mismatches.map((row) => row.itemId));
  await SettlementMismatch.updateMany(
    {
      tenantId,
      runId,
      itemId: { $nin: [...itemIds] },
      status: SettlementMismatchStatus.OPEN,
    },
    { $set: { status: SettlementMismatchStatus.RESOLVED, resolvedAt: new Date(), resolvedBy: "system:auto-cleared" } },
    session ? { session } : {},
  );
}
