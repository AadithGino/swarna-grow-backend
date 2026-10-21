import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { escapeCsvCell } from "../lib/csv-formula-escape.js";
import { istBusinessDayBounds } from "../lib/digital-metals-business-calendar.js";
import { stringifyUg } from "../lib/digital-metals-hedge-perimeter.js";
import {
  buildHedgeAssetLine,
  enumerateTenantAssets,
  invalidateDownstreamHedgeSnapshots,
  listOutstandingInvalidatedHedgeSnapshots,
  tenantHasInvalidatedHedgeSnapshots,
} from "../lib/digital-metals-hedge-aggregation.js";
import { today } from "../lib/date.js";
import { DigitalMetalHedgeIncludedSource, DigitalMetalHedgeSnapshot } from "../models/index.js";

function mapLineForDto(line) {
  const n = line._numeric;
  return {
    metal: line.metal,
    finenessPpm: line.finenessPpm,
    coverageIncomplete: line.coverageIncomplete,
    openingObligationUg: stringifyUg(n.openingObligationUg),
    closingObligationUg: stringifyUg(n.closingObligationUg),
    openingHedgePositionUg: stringifyUg(n.openingHedgePositionUg),
    closingHedgePositionUg: stringifyUg(n.closingHedgePositionUg),
    uncoveredUg: stringifyUg(n.uncoveredUg),
    openCommitmentsUg: stringifyUg(n.openCommitmentsUg),
    reservedInTransitUg: stringifyUg(n.reservedInTransitUg),
    outstandingPayablesPaise: n.outstandingPayablesPaise,
    walletHeldUg: stringifyUg(n.walletHeldUg),
    walletReservedUg: stringifyUg(n.walletReservedUg),
    walletReconcileDeltaUg: stringifyUg(n.walletReconcileDeltaUg),
    movements: {
      completedBuyUg: stringifyUg(n.completedBuyUg),
      executedSellUg: stringifyUg(n.executedSellUg),
      physicalHandoverUg: stringifyUg(n.physicalHandoverUg),
      procurementReceiptUg: stringifyUg(n.procurementReceiptUg),
      supplierDisposalUg: stringifyUg(n.supplierDisposalUg),
    },
    sourceBreakdown: line.sourceBreakdown,
    _numeric: n,
  };
}

export async function getLiveHedgeReport(req, options = {}) {
  const session = options.session ?? null;
  const tenantId = req.auth.tenantId;
  const businessDate = req.query.businessDate ?? today();
  const { end: cutoffEnd } = istBusinessDayBounds(businessDate);
  const cutoff = req.query.asOf ? new Date(req.query.asOf) : cutoffEnd;

  const assets = await enumerateTenantAssets(tenantId, session);
  const lines = [];
  for (const { metal, finenessPpm } of assets) {
    const raw = await buildHedgeAssetLine(tenantId, metal, finenessPpm, businessDate, cutoff, session);
    lines.push(mapLineForDto(raw));
  }
  const recomputationRequired = Boolean(await tenantHasInvalidatedHedgeSnapshots(tenantId, session));
  return {
    reportType: "LIVE",
    businessDate,
    cutoffAt: cutoff.toISOString(),
    recomputationRequired,
    invalidationNotice: recomputationRequired
      ? "One or more later day-end snapshots were invalidated by a revision. Re-close affected business days before relying on hedge totals."
      : null,
    lines,
  };
}

async function assertSourceNotInClosedSnapshot(tenantId, src, session) {
  const sourceType = src.type === "PROCUREMENT" ? "PROCUREMENT" : src.type;
  const existing = await DigitalMetalHedgeIncludedSource.findOne({
    tenantId,
    sourceType,
    sourceId: src.id,
  })
    .session(session ?? null)
    .lean();
  if (!existing) return;
  const snap = await DigitalMetalHedgeSnapshot.findById(existing.includedInSnapshotId)
    .session(session ?? null)
    .lean();
  if (snap?.status === "CLOSED" && !snap.invalidatedAt) {
    throw new AppError(
      "SOURCE_ALREADY_INCLUDED",
      `Source ${sourceType}/${src.id} already included in closed snapshot ${snap._id}.`,
      409,
    );
  }
}

export async function closeHedgeDaySnapshot(req) {
  const businessDate = req.body.businessDate ?? today();
  const revisionReason = req.body.revisionReason ?? "";
  const { end: cutoffEnd } = istBusinessDayBounds(businessDate);

  return withTransaction(async (session) => {
    const live = await getLiveHedgeReport(
      {
        auth: req.auth,
        query: { businessDate, asOf: cutoffEnd.toISOString() },
      },
      { session },
    );

    const downstreamInvalidated = [];
    const created = [];

    for (const line of live.lines) {
      const n = line._numeric;
      for (const src of line.sourceBreakdown) {
        await assertSourceNotInClosedSnapshot(req.auth.tenantId, src, session);
      }

      const latest = await DigitalMetalHedgeSnapshot.findOne({
        tenantId: req.auth.tenantId,
        businessDate,
        metal: line.metal,
        finenessPpm: line.finenessPpm,
      })
        .sort({ snapshotVersion: -1 })
        .session(session);
      const nextVersion = (latest?.snapshotVersion ?? 0) + 1;
      if (latest && latest.status === "CLOSED" && !revisionReason.trim()) {
        throw new AppError("SNAPSHOT_EXISTS", "Day already closed; pass revisionReason to supersede.", 409);
      }
      if (latest && latest.status === "CLOSED") {
        await DigitalMetalHedgeSnapshot.updateOne(
          { _id: latest._id },
          { $set: { status: "SUPERSEDED", supersededByVersion: nextVersion } },
          { session },
        );
        await DigitalMetalHedgeIncludedSource.deleteMany(
          { tenantId: req.auth.tenantId, includedInSnapshotId: latest._id },
          { session },
        );
        const invalidated = await invalidateDownstreamHedgeSnapshots(
          req.auth.tenantId,
          line.metal,
          line.finenessPpm,
          businessDate,
          latest._id,
          revisionReason.trim() || "REVISION",
          session,
        );
        downstreamInvalidated.push(...invalidated);
      }

      const snapId = createId("dmhs");
      await DigitalMetalHedgeSnapshot.create(
        [
          {
            _id: snapId,
            tenantId: req.auth.tenantId,
            businessDate,
            metal: line.metal,
            finenessPpm: line.finenessPpm,
            snapshotVersion: nextVersion,
            status: "CLOSED",
            coverageIncomplete: line.coverageIncomplete,
            openingObligationUg: n.openingObligationUg,
            closingObligationUg: n.closingObligationUg,
            openingHedgePositionUg: n.openingHedgePositionUg,
            closingHedgePositionUg: n.closingHedgePositionUg,
            uncoveredUg: n.uncoveredUg,
            openCommitmentsUg: n.openCommitmentsUg,
            reservedInTransitUg: n.reservedInTransitUg,
            outstandingPayablesPaise: n.outstandingPayablesPaise,
            completedBuyUg: n.completedBuyUg,
            executedSellUg: n.executedSellUg,
            physicalHandoverUg: n.physicalHandoverUg,
            procurementReceiptUg: n.procurementReceiptUg,
            supplierDisposalUg: n.supplierDisposalUg,
            obligationAdjustmentUg: n.obligationAdjustmentUg ?? 0,
            hedgeAdjustmentUg: n.hedgeAdjustmentUg ?? 0,
            walletHeldUg: n.walletHeldUg,
            walletReservedUg: n.walletReservedUg,
            walletReconcileDeltaUg: n.walletReconcileDeltaUg,
            eventCutoffAt: cutoffEnd,
            closedByUserId: req.auth.id,
            revisionReason,
            sourceBreakdown: line.sourceBreakdown,
            downstreamInvalidatedBusinessDates: [...new Set(downstreamInvalidated.map((d) => d.businessDate))],
          },
        ],
        { session },
      );

      for (const src of line.sourceBreakdown) {
        const sourceType = src.type === "PROCUREMENT" ? "PROCUREMENT" : src.type;
        await DigitalMetalHedgeIncludedSource.findOneAndUpdate(
          { tenantId: req.auth.tenantId, sourceType, sourceId: src.id },
          {
            $set: {
              businessDate,
              quantityUg: Number(src.quantityUg),
              includedInSnapshotId: snapId,
            },
            $setOnInsert: {
              _id: createId("dmhis"),
              tenantId: req.auth.tenantId,
              sourceType,
              sourceId: src.id,
            },
          },
          { session, upsert: true },
        );
      }
      created.push({ id: snapId, metal: line.metal, finenessPpm: line.finenessPpm, snapshotVersion: nextVersion });
    }
    return { businessDate, snapshots: created, downstreamInvalidated };
  });
}

export async function getHedgeSnapshot(req) {
  const { businessDate } = req.params;
  const version = req.query.version ? Number(req.query.version) : null;
  const filter = { tenantId: req.auth.tenantId, businessDate };
  if (version) filter.snapshotVersion = version;
  const rows = await DigitalMetalHedgeSnapshot.find(filter).sort({ metal: 1, finenessPpm: 1, snapshotVersion: -1 });
  if (!rows.length) throw errors.notFound("Hedge snapshot");
  const byAsset = new Map();
  for (const r of rows) {
    const key = `${r.metal}:${r.finenessPpm}`;
    if (!byAsset.has(key) || r.snapshotVersion > byAsset.get(key).snapshotVersion) {
      byAsset.set(key, r);
    }
  }
  return {
    businessDate,
    snapshots: [...byAsset.values()].map((r) => ({
      id: r._id,
      metal: r.metal,
      finenessPpm: r.finenessPpm,
      snapshotVersion: r.snapshotVersion,
      status: r.status,
      coverageIncomplete: r.coverageIncomplete,
      closingObligationUg: stringifyUg(r.closingObligationUg),
      closingHedgePositionUg: stringifyUg(r.closingHedgePositionUg),
      uncoveredUg: stringifyUg(r.uncoveredUg),
      walletReconcileDeltaUg: stringifyUg(r.walletReconcileDeltaUg),
      sourceBreakdown: r.sourceBreakdown ?? [],
      downstreamInvalidatedBusinessDates: r.downstreamInvalidatedBusinessDates ?? [],
      invalidatedAt: r.invalidatedAt ?? null,
    })),
  };
}

export async function listInvalidatedHedgeSnapshots(req) {
  const rows = (await listOutstandingInvalidatedHedgeSnapshots(req.auth.tenantId)).slice(0, 100);
  return {
    items: rows.map((r) => ({
      id: r._id,
      businessDate: r.businessDate,
      metal: r.metal,
      finenessPpm: r.finenessPpm,
      snapshotVersion: r.snapshotVersion,
      invalidatedAt: r.invalidatedAt,
      invalidatedBySnapshotId: r.invalidatedBySnapshotId,
      invalidationReason: r.invalidationReason ?? "",
    })),
  };
}

export function exportHedgeSnapshotCsv(snapshotRows) {
  const header = [
    "businessDate",
    "metal",
    "finenessPpm",
    "closingObligationUg",
    "closingHedgePositionUg",
    "uncoveredUg",
    "coverageIncomplete",
  ].join(",");
  const lines = snapshotRows.map((r) =>
    [
      escapeCsvCell(r.businessDate),
      escapeCsvCell(r.metal),
      escapeCsvCell(r.finenessPpm),
      escapeCsvCell(r.closingObligationUg),
      escapeCsvCell(r.closingHedgePositionUg),
      escapeCsvCell(r.uncoveredUg),
      escapeCsvCell(r.coverageIncomplete),
    ].join(","),
  );
  return `${header}\n${lines.join("\n")}\n`;
}

export async function getPlatformHedgeHealth(_req) {
  const tenants = await DigitalMetalHedgeSnapshot.distinct("tenantId", { status: "CLOSED" });
  let incompleteOpening = 0;
  let positiveUncovered = 0;
  for (const tenantId of tenants.slice(0, 200)) {
    const latest = await DigitalMetalHedgeSnapshot.findOne({ tenantId, status: "CLOSED" })
      .sort({ closedAt: -1 })
      .lean();
    if (!latest) continue;
    if (latest.coverageIncomplete) incompleteOpening += 1;
    if (Number(latest.uncoveredUg) > 0) positiveUncovered += 1;
  }
  return {
    tenantsWithSnapshots: tenants.length,
    tenantsIncompleteOpening: incompleteOpening,
    tenantsPositiveUncovered: positiveUncovered,
    note: "Aggregate health only; no customer or bank fields.",
  };
}
