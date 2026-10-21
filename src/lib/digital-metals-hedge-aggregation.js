import dayjs from "dayjs";
import { env } from "../config/env.js";
import { istBusinessDayBounds } from "./digital-metals-business-calendar.js";
import { computeClosingPerimeter } from "./digital-metals-hedge-perimeter.js";
import {
  DigitalMetalBuyOrder,
  DigitalMetalHedgeIncludedSource,
  DigitalMetalHedgeSnapshot,
  DigitalMetalJournal,
  DigitalMetalPayable,
  DigitalMetalPhysicalOutEvent,
  DigitalMetalProcurementEntry,
  DigitalMetalRedemptionOrder,
  DigitalMetalSellOrder,
  DigitalMetalWallet,
} from "../models/index.js";

/**
 * Opening-position timing (Phase 8 correction):
 * - effectiveDate < reportBusinessDate → included in static opening baseline.
 * - effectiveDate === reportBusinessDate → applied at IST start-of-day (baseline only, not period procurement).
 * - Prior CLOSED snapshot for date S → opening = snapshot closing; period starts after S (exclusive) / eventCutoffAt.
 */

function dayBeforeBusinessDate(dateStr) {
  return dayjs.tz(`${dateStr}T12:00:00`, env.APP_TIMEZONE).subtract(1, "day").format("YYYY-MM-DD");
}

export async function enumerateTenantAssets(tenantId, session) {
  const keys = new Map();
  const add = (metal, finenessPpm) => {
    if (!metal || finenessPpm == null) return;
    keys.set(`${metal}:${finenessPpm}`, { metal, finenessPpm: Number(finenessPpm) });
  };

  for (const metal of await DigitalMetalWallet.distinct("metal", { tenantId }).session(session ?? null)) {
    const finenessList = await DigitalMetalWallet.distinct("finenessPpm", { tenantId, metal }).session(
      session ?? null,
    );
    for (const f of finenessList) add(metal, f);
  }
  for (const row of await DigitalMetalProcurementEntry.find({ tenantId, status: "APPROVED" })
    .select("metal finenessPpm")
    .lean()
    .session(session ?? null)) {
    add(row.metal, row.finenessPpm);
  }
  for (const row of await DigitalMetalBuyOrder.find({ tenantId, status: "CREDITED" })
    .select("metal finenessPpm")
    .lean()
    .session(session ?? null)) {
    add(row.metal, row.finenessPpm);
  }
  if (keys.size === 0) add("GOLD", 999_000);
  return [...keys.values()];
}

async function latestClosedSnapshotBefore(tenantId, metal, finenessPpm, businessDate, session) {
  return DigitalMetalHedgeSnapshot.findOne({
    tenantId,
    metal,
    finenessPpm,
    businessDate: { $lt: businessDate },
    status: "CLOSED",
    invalidatedAt: null,
  })
    .sort({ businessDate: -1, snapshotVersion: -1 })
    .lean()
    .session(session ?? null);
}

/** INVALIDATED rows are kept for audit; outstanding = no newer CLOSED snapshot for same day/metal/fineness. */
export async function listOutstandingInvalidatedHedgeSnapshots(tenantId, session) {
  const invalidated = await DigitalMetalHedgeSnapshot.find({
    tenantId,
    status: "INVALIDATED",
  })
    .sort({ businessDate: -1, snapshotVersion: -1 })
    .lean()
    .session(session ?? null);

  const outstanding = [];
  for (const row of invalidated) {
    const superseded = await DigitalMetalHedgeSnapshot.exists({
      tenantId,
      businessDate: row.businessDate,
      metal: row.metal,
      finenessPpm: row.finenessPpm,
      status: "CLOSED",
      snapshotVersion: { $gt: row.snapshotVersion },
    }).session(session ?? null);
    if (!superseded) outstanding.push(row);
  }
  return outstanding;
}

export async function tenantHasInvalidatedHedgeSnapshots(tenantId, session) {
  const rows = await listOutstandingInvalidatedHedgeSnapshots(tenantId, session);
  return rows.length ? { _id: rows[0]._id } : null;
}

export async function invalidateDownstreamHedgeSnapshots(
  tenantId,
  metal,
  finenessPpm,
  afterBusinessDate,
  bySnapshotId,
  reason,
  session,
) {
  const rows = await DigitalMetalHedgeSnapshot.find({
    tenantId,
    metal,
    finenessPpm,
    businessDate: { $gt: afterBusinessDate },
    status: "CLOSED",
  })
    .session(session ?? null);

  const invalidated = [];
  for (const row of rows) {
    await DigitalMetalHedgeSnapshot.updateOne(
      { _id: row._id },
      {
        $set: {
          status: "INVALIDATED",
          invalidatedAt: new Date(),
          invalidatedBySnapshotId: bySnapshotId,
          invalidationReason: reason,
        },
      },
      { session },
    );
    await DigitalMetalHedgeIncludedSource.deleteMany(
      { tenantId, includedInSnapshotId: row._id },
      { session },
    );
    invalidated.push({ id: row._id, businessDate: row.businessDate, snapshotVersion: row.snapshotVersion });
  }
  return invalidated;
}

async function sumOpeningPositions(tenantId, metal, finenessPpm, beforeBusinessDate, session) {
  const rows = await DigitalMetalProcurementEntry.find({
    tenantId,
    metal,
    finenessPpm,
    entryType: "OPENING_POSITION",
    status: "APPROVED",
    effectiveDate: { $lt: beforeBusinessDate },
  })
    .lean()
    .session(session ?? null);
  let hedge = 0;
  let obligation = 0;
  for (const o of rows) {
    hedge += Number(o.quantityUg);
    obligation += Number(o.obligationQuantityUg ?? o.quantityUg ?? 0);
  }
  return { openingHedgePositionUg: hedge, openingObligationUg: obligation, count: rows.length };
}

async function sumOpeningOnReportDay(tenantId, metal, finenessPpm, businessDate, session) {
  const rows = await DigitalMetalProcurementEntry.find({
    tenantId,
    metal,
    finenessPpm,
    entryType: "OPENING_POSITION",
    status: "APPROVED",
    effectiveDate: businessDate,
  })
    .lean()
    .session(session ?? null);
  let hedge = 0;
  let obligation = 0;
  for (const o of rows) {
    hedge += Number(o.quantityUg);
    obligation += Number(o.obligationQuantityUg ?? o.quantityUg ?? 0);
  }
  return { hedgeUg: hedge, obligationUg: obligation };
}

function procurementMovementEffect(entry, reversedOriginal) {
  const q = Number(entry.quantityUg);
  const target = reversedOriginal ?? entry;
  switch (target.entryType) {
    case "RECEIPT":
      return { receiptUg: entry.entryType === "REVERSAL" ? -q : q, disposalUg: 0, hedgeAdj: 0, obligationAdj: 0, commitmentUg: 0 };
    case "DISPOSAL":
      return { receiptUg: 0, disposalUg: entry.entryType === "REVERSAL" ? -q : q, hedgeAdj: 0, obligationAdj: 0, commitmentUg: 0 };
    case "COMMITMENT":
      return { receiptUg: 0, disposalUg: 0, hedgeAdj: 0, obligationAdj: 0, commitmentUg: entry.entryType === "REVERSAL" ? -q : q };
    case "OPENING_POSITION": {
      const ob = Number(target.obligationQuantityUg ?? target.quantityUg ?? 0);
      const sign = entry.entryType === "REVERSAL" ? -1 : 1;
      return {
        receiptUg: 0,
        disposalUg: 0,
        hedgeAdj: sign * q,
        obligationAdj: sign * ob,
        commitmentUg: 0,
      };
    }
    default:
      return { receiptUg: 0, disposalUg: 0, hedgeAdj: 0, obligationAdj: 0, commitmentUg: 0 };
  }
}

async function loadReversalOriginal(tenantId, entry, session) {
  if (entry.entryType !== "REVERSAL" || !entry.reversesEntryId) return null;
  return DigitalMetalProcurementEntry.findOne({
    _id: entry.reversesEntryId,
    tenantId,
    status: "APPROVED",
  })
    .lean()
    .session(session ?? null);
}

async function aggregateProcurementPeriod(
  tenantId,
  metal,
  finenessPpm,
  startBusinessDateExclusive,
  reportBusinessDate,
  session,
) {
  const rows = await DigitalMetalProcurementEntry.find({
    tenantId,
    metal,
    finenessPpm,
    status: "APPROVED",
    entryType: { $ne: "OPENING_POSITION" },
    effectiveDate: { $gt: startBusinessDateExclusive, $lte: reportBusinessDate },
  })
    .lean()
    .session(session ?? null);

  let procurementReceiptUg = 0;
  let supplierDisposalUg = 0;
  let obligationAdjustmentUg = 0;
  let hedgeAdjustmentUg = 0;
  let periodCommitmentUg = 0;
  const breakdown = [];

  for (const p of rows) {
    const reversed = p.entryType === "REVERSAL" ? await loadReversalOriginal(tenantId, p, session) : null;
    const fx = procurementMovementEffect(p, reversed);
    procurementReceiptUg += fx.receiptUg;
    supplierDisposalUg += fx.disposalUg;
    obligationAdjustmentUg += fx.obligationAdj;
    hedgeAdjustmentUg += fx.hedgeAdj;
    periodCommitmentUg += fx.commitmentUg;
    breakdown.push({
      type: "PROCUREMENT",
      subType: p.entryType,
      id: p._id,
      quantityUg: String(p.quantityUg),
      effectiveDate: p.effectiveDate,
    });
  }
  return {
    procurementReceiptUg,
    supplierDisposalUg,
    obligationAdjustmentUg,
    hedgeAdjustmentUg,
    periodCommitmentUg,
    breakdown,
  };
}

export async function computeOutstandingCommitmentsUg(tenantId, metal, finenessPpm, session) {
  const commitments = await DigitalMetalProcurementEntry.find({
    tenantId,
    metal,
    finenessPpm,
    entryType: "COMMITMENT",
    status: "APPROVED",
  })
    .lean()
    .session(session ?? null);
  let total = 0;
  for (const c of commitments) {
    const received = Number(c.receivedQuantityUg ?? 0);
    total += Math.max(0, Number(c.quantityUg) - received);
  }
  return total;
}

async function aggregatePeriodMovements(
  tenantId,
  metal,
  finenessPpm,
  reportBusinessDate,
  periodStartInstant,
  cutoffEnd,
  startBusinessDateExclusive,
  session,
) {
  const buyRows = await DigitalMetalBuyOrder.find({
    tenantId,
    metal,
    finenessPpm,
    status: "CREDITED",
    creditedAt: { $gt: periodStartInstant, $lte: cutoffEnd },
  })
    .lean()
    .session(session ?? null);
  const sellRows = await DigitalMetalSellOrder.find({
    tenantId,
    metal,
    finenessPpm,
    status: "PAYABLE_OPEN",
    executedAt: { $gt: periodStartInstant, $lte: cutoffEnd },
  })
    .lean()
    .session(session ?? null);

  const handoverRows = await DigitalMetalPhysicalOutEvent.find({
    tenantId,
    metal,
    finenessPpm,
    businessDate: {
      $gt: startBusinessDateExclusive,
      $lte: reportBusinessDate,
    },
  })
    .lean()
    .session(session ?? null);

  const proc = await aggregateProcurementPeriod(
    tenantId,
    metal,
    finenessPpm,
    startBusinessDateExclusive,
    reportBusinessDate,
    session,
  );

  let completedBuyUg = 0;
  let executedSellUg = 0;
  let physicalHandoverUg = 0;
  for (const b of buyRows) completedBuyUg += Number(b.quantityUg);
  for (const s of sellRows) executedSellUg += Number(s.quantityUg);
  for (const h of handoverRows) physicalHandoverUg += Number(h.quantityUg);

  const inTransit = await DigitalMetalRedemptionOrder.find({
    tenantId,
    metal,
    finenessPpm,
    status: { $in: ["DISPATCHED", "INVESTIGATION", "PICKUP_READY"] },
  })
    .lean()
    .session(session ?? null);
  let reservedInTransitUg = 0;
  for (const o of inTransit) reservedInTransitUg += Number(o.quantityUg);

  const payables = await DigitalMetalPayable.find({ tenantId, status: "OPEN" }).lean().session(session ?? null);
  let outstandingPayablesPaise = 0;
  for (const p of payables) outstandingPayablesPaise += Number(p.amountPaise ?? 0);

  const openCommitmentsUg = await computeOutstandingCommitmentsUg(tenantId, metal, finenessPpm, session);

  const sourceBreakdown = [
    ...buyRows.map((r) => ({ type: "BUY_CREDIT", id: r._id, quantityUg: String(r.quantityUg) })),
    ...sellRows.map((r) => ({ type: "SELL_EXECUTE", id: r._id, quantityUg: String(r.quantityUg) })),
    ...handoverRows.map((r) => ({ type: "PHYSICAL_OUT", id: r._id, quantityUg: String(r.quantityUg) })),
    ...proc.breakdown,
  ];

  return {
    completedBuyUg,
    executedSellUg,
    physicalHandoverUg,
    procurementReceiptUg: proc.procurementReceiptUg,
    supplierDisposalUg: proc.supplierDisposalUg,
    obligationAdjustmentUg: proc.obligationAdjustmentUg,
    hedgeAdjustmentUg: proc.hedgeAdjustmentUg,
    openCommitmentsUg,
    reservedInTransitUg,
    outstandingPayablesPaise,
    sourceBreakdown,
  };
}

export async function sumJournalHeldUgAtCutoff(tenantId, metal, finenessPpm, cutoffEnd, session) {
  const wallets = await DigitalMetalWallet.find({ tenantId, metal, finenessPpm }).lean().session(session ?? null);
  let heldUg = 0;
  let reservedUg = 0;
  for (const w of wallets) {
    const journals = await DigitalMetalJournal.find({
      tenantId,
      walletId: w._id,
      createdAt: { $lte: cutoffEnd },
    })
      .lean()
      .session(session ?? null);
    for (const j of journals) {
      heldUg += j.quantityUgDelta ?? 0;
      reservedUg += j.reservedUgDelta ?? 0;
    }
  }
  return { heldUg, reservedUg };
}

export async function resolvePeriodContext(tenantId, metal, finenessPpm, reportBusinessDate, cutoffEnd, session) {
  const priorSnap = await latestClosedSnapshotBefore(tenantId, metal, finenessPpm, reportBusinessDate, session);
  const staticOpening = await sumOpeningPositions(tenantId, metal, finenessPpm, reportBusinessDate, session);
  const sameDayOpening = await sumOpeningOnReportDay(tenantId, metal, finenessPpm, reportBusinessDate, session);

  let openingObligationUg = staticOpening.openingObligationUg + sameDayOpening.obligationUg;
  let openingHedgePositionUg = staticOpening.openingHedgePositionUg + sameDayOpening.hedgeUg;
  let periodStartInstant = new Date(0);
  let startBusinessDateExclusive = "";

  if (priorSnap) {
    openingObligationUg = Number(priorSnap.closingObligationUg);
    openingHedgePositionUg = Number(priorSnap.closingHedgePositionUg);
    periodStartInstant = priorSnap.eventCutoffAt ?? istBusinessDayBounds(priorSnap.businessDate).end;
    startBusinessDateExclusive = priorSnap.businessDate;
  } else if (staticOpening.count > 0 || sameDayOpening.hedgeUg > 0) {
    const earliest = await DigitalMetalProcurementEntry.findOne({
      tenantId,
      metal,
      finenessPpm,
      entryType: "OPENING_POSITION",
      status: "APPROVED",
    })
      .sort({ effectiveDate: 1 })
      .lean()
      .session(session ?? null);
    if (earliest) {
      const { start } = istBusinessDayBounds(earliest.effectiveDate);
      periodStartInstant = start;
      startBusinessDateExclusive = dayBeforeBusinessDate(earliest.effectiveDate);
    }
  }

  const hasAnyOpening = await DigitalMetalProcurementEntry.exists({
    tenantId,
    metal,
    finenessPpm,
    entryType: "OPENING_POSITION",
    status: "APPROVED",
    effectiveDate: { $lte: reportBusinessDate },
  }).session(session ?? null);
  const coverageIncomplete = !priorSnap && !hasAnyOpening;

  return {
    priorSnap,
    openingObligationUg,
    openingHedgePositionUg,
    periodStartInstant,
    startBusinessDateExclusive,
    coverageIncomplete,
  };
}

export async function buildHedgeAssetLine(
  tenantId,
  metal,
  finenessPpm,
  reportBusinessDate,
  cutoffEnd,
  session,
) {
  const ctx = await resolvePeriodContext(tenantId, metal, finenessPpm, reportBusinessDate, cutoffEnd, session);
  const day = await aggregatePeriodMovements(
    tenantId,
    metal,
    finenessPpm,
    reportBusinessDate,
    ctx.periodStartInstant,
    cutoffEnd,
    ctx.startBusinessDateExclusive,
    session,
  );

  const { closingObligationUg, closingHedgePositionUg, uncoveredUg } = computeClosingPerimeter({
    openingObligationUg: ctx.openingObligationUg,
    openingHedgePositionUg: ctx.openingHedgePositionUg,
    ...day,
  });

  const journalWallet = await sumJournalHeldUgAtCutoff(tenantId, metal, finenessPpm, cutoffEnd, session);
  const walletReconcileDeltaUg = journalWallet.heldUg - closingObligationUg;

  return {
    metal,
    finenessPpm,
    coverageIncomplete: ctx.coverageIncomplete,
    openingObligationUg: ctx.openingObligationUg,
    closingObligationUg,
    openingHedgePositionUg: ctx.openingHedgePositionUg,
    closingHedgePositionUg,
    uncoveredUg,
    openCommitmentsUg: day.openCommitmentsUg,
    reservedInTransitUg: day.reservedInTransitUg,
    outstandingPayablesPaise: day.outstandingPayablesPaise,
    walletHeldUg: journalWallet.heldUg,
    walletReservedUg: journalWallet.reservedUg,
    walletReconcileDeltaUg,
    movements: day,
    sourceBreakdown: day.sourceBreakdown,
    priorSnapshotId: ctx.priorSnap?._id ?? null,
    _numeric: {
      openingObligationUg: ctx.openingObligationUg,
      closingObligationUg,
      openingHedgePositionUg: ctx.openingHedgePositionUg,
      closingHedgePositionUg,
      uncoveredUg,
      ...day,
      walletHeldUg: journalWallet.heldUg,
      walletReservedUg: journalWallet.reservedUg,
      walletReconcileDeltaUg,
    },
  };
}

export async function listDownstreamSnapshotsToRevise(tenantId, metal, finenessPpm, businessDate, session) {
  return DigitalMetalHedgeSnapshot.find({
    tenantId,
    metal,
    finenessPpm,
    businessDate: { $gt: businessDate },
    status: { $in: ["CLOSED", "INVALIDATED"] },
  })
    .sort({ businessDate: 1 })
    .select("businessDate snapshotVersion _id status")
    .lean()
    .session(session ?? null);
}
