import {
  DigitalMetalBuyOrder,
  DigitalMetalJournal,
  DigitalMetalPhysicalOutEvent,
  DigitalMetalSellOrder,
  DigitalMetalWallet,
} from "../models/index.js";
import { istBusinessDayBounds } from "./digital-metals-business-calendar.js";
import { today } from "./date.js";


export async function enumerateDailyBookAssets(tenantId, session) {
  const keys = new Map();
  const add = (metal, finenessPpm) => {
    if (!metal || finenessPpm == null) return;
    keys.set(`${metal}:${finenessPpm}`, { metal, finenessPpm: Number(finenessPpm) });
  };

  for (const row of await DigitalMetalWallet.find({ tenantId }).select("metal finenessPpm").lean().session(session ?? null)) {
    add(row.metal, row.finenessPpm);
  }
  for (const row of await DigitalMetalBuyOrder.find({ tenantId, status: "CREDITED" })
    .select("metal finenessPpm")
    .lean()
    .session(session ?? null)) {
    add(row.metal, row.finenessPpm);
  }
  for (const row of await DigitalMetalSellOrder.find({ tenantId, status: { $in: ["PAYABLE_OPEN", "EXECUTED"] } })
    .select("metal finenessPpm")
    .lean()
    .session(session ?? null)) {
    add(row.metal, row.finenessPpm);
  }
  for (const row of await DigitalMetalPhysicalOutEvent.find({ tenantId }).select("metal finenessPpm").lean().session(session ?? null)) {
    add(row.metal, row.finenessPpm);
  }
  if (keys.size === 0) add("GOLD", 999_000);
  return [...keys.values()];
}

async function walletIdsForAsset(tenantId, metal, finenessPpm, session) {
  const wallets = await DigitalMetalWallet.find({ tenantId, metal, finenessPpm }).select("_id").lean().session(session ?? null);
  return wallets.map((w) => w._id);
}

export async function sumLedgerHeldReservedBeforeInstant(tenantId, metal, finenessPpm, beforeInstant, session) {
  const walletIds = await walletIdsForAsset(tenantId, metal, finenessPpm, session);
  if (!walletIds.length) return { heldUg: 0, reservedUg: 0 };

  const rows = await DigitalMetalJournal.aggregate([
    { $match: { tenantId, walletId: { $in: walletIds }, createdAt: { $lt: beforeInstant } } },
    {
      $group: {
        _id: null,
        heldUg: { $sum: "$quantityUgDelta" },
        reservedUg: { $sum: { $ifNull: ["$reservedUgDelta", 0] } },
      },
    },
  ]).session(session ?? null);

  const row = rows[0] ?? { heldUg: 0, reservedUg: 0 };
  return { heldUg: Number(row.heldUg ?? 0), reservedUg: Number(row.reservedUg ?? 0) };
}

export async function sumLedgerHeldReservedAtCutoff(tenantId, metal, finenessPpm, cutoffEnd, session) {
  const walletIds = await walletIdsForAsset(tenantId, metal, finenessPpm, session);
  if (!walletIds.length) return { heldUg: 0, reservedUg: 0 };

  const rows = await DigitalMetalJournal.aggregate([
    { $match: { tenantId, walletId: { $in: walletIds }, createdAt: { $lte: cutoffEnd } } },
    {
      $group: {
        _id: null,
        heldUg: { $sum: "$quantityUgDelta" },
        reservedUg: { $sum: { $ifNull: ["$reservedUgDelta", 0] } },
      },
    },
  ]).session(session ?? null);

  const row = rows[0] ?? { heldUg: 0, reservedUg: 0 };
  return { heldUg: Number(row.heldUg ?? 0), reservedUg: Number(row.reservedUg ?? 0) };
}

async function sumJournalMovementBuckets(tenantId, metal, finenessPpm, periodStart, cutoffEnd, session) {
  const walletIds = await walletIdsForAsset(tenantId, metal, finenessPpm, session);
  if (!walletIds.length) {
    return { creditedBuyUg: 0, executedSellUg: 0, correctionUg: 0 };
  }

  const rows = await DigitalMetalJournal.find({
    tenantId,
    walletId: { $in: walletIds },
    createdAt: { $gt: periodStart, $lte: cutoffEnd },
  })
    .select("quantityUgDelta referenceType")
    .lean()
    .session(session ?? null);

  let creditedBuyUg = 0;
  let executedSellUg = 0;
  let correctionUg = 0;
  let unclassifiedJournalUg = 0;
  for (const j of rows) {
    const delta = Number(j.quantityUgDelta ?? 0);
    const ref = String(j.referenceType ?? "").trim();
    if (!ref) {
      unclassifiedJournalUg += delta;
      continue;
    }
    if (ref === "PURCHASE") creditedBuyUg += delta;
    else if (ref === "SELL") executedSellUg += Math.abs(delta);
    else if (ref === "RESERVATION" || ref === "REDEMPTION") continue;
    else if (ref === "JOURNAL" || ref === "TEST_FIXTURE") correctionUg += delta;
    else unclassifiedJournalUg += delta;
  }
  return { creditedBuyUg, executedSellUg, correctionUg, unclassifiedJournalUg };
}

/** When no wallet/journal exists yet, carry credited buys from prior business days into opening. */
async function sumCreditedBuyUgAtOrBeforePeriodStart(tenantId, metal, finenessPpm, periodStart, session) {
  const rows = await DigitalMetalBuyOrder.find({
    tenantId,
    metal,
    finenessPpm,
    status: "CREDITED",
    creditedAt: { $lte: periodStart },
  })
    .select("quantityUg")
    .lean()
    .session(session ?? null);
  let total = 0;
  for (const row of rows) total += Number(row.quantityUg ?? 0);
  return total;
}

async function resolveOpeningMetalOwedUg(tenantId, metal, finenessPpm, periodStart, session) {
  const walletIds = await walletIdsForAsset(tenantId, metal, finenessPpm, session);
  const openingLedger = await sumLedgerHeldReservedBeforeInstant(tenantId, metal, finenessPpm, periodStart, session);
  if (openingLedger.heldUg !== 0 || walletIds.length > 0) {
    return openingLedger.heldUg;
  }
  return sumCreditedBuyUgAtOrBeforePeriodStart(tenantId, metal, finenessPpm, periodStart, session);
}

async function aggregateBookMovements(
  tenantId,
  metal,
  finenessPpm,
  periodStart,
  cutoffEnd,
  reportBusinessDate,
  session,
  { lite = false } = {},
) {
  const buyRows = await DigitalMetalBuyOrder.find({
    tenantId,
    metal,
    finenessPpm,
    status: "CREDITED",
    creditedAt: { $gt: periodStart, $lte: cutoffEnd },
  })
    .lean()
    .session(session ?? null);

  const handoverRows = await DigitalMetalPhysicalOutEvent.find({
    tenantId,
    metal,
    finenessPpm,
    businessDate: reportBusinessDate,
  })
    .lean()
    .session(session ?? null);

  let physicalHandoverUg = 0;
  for (const h of handoverRows) physicalHandoverUg += Number(h.quantityUg);

  const journalBuckets = await sumJournalMovementBuckets(
    tenantId,
    metal,
    finenessPpm,
    periodStart,
    cutoffEnd,
    session,
  );
  let creditedBuyUg = journalBuckets.creditedBuyUg;
  const executedSellUg = journalBuckets.executedSellUg;
  // Prefer the journal-derived total; only fall back to the buy-order rows when
  // the journal shows no purchase movement. When falling back, sum ALL rows —
  // the previous `if (creditedBuyUg === 0)` inside the loop stopped after the
  // first row, so multiple credited buys in one day were undercounted.
  if (creditedBuyUg === 0) {
    for (const b of buyRows) creditedBuyUg += Number(b.quantityUg);
  }

  const base = {
    creditedBuyUg,
    executedSellUg,
    physicalHandoverUg,
    correctionUg: journalBuckets.correctionUg,
    unclassifiedJournalUg: journalBuckets.unclassifiedJournalUg,
  };
  if (lite) return base;
  return {
    ...base,
    sourceBreakdown: [
      ...buyRows.map((r) => ({ type: "BUY_CREDIT", id: r._id, quantityUg: String(r.quantityUg) })),
      ...handoverRows.map((r) => ({ type: "PHYSICAL_OUT", id: r._id, quantityUg: String(r.quantityUg) })),
    ],
  };
}

/**
 * Lightweight day row for admin history lists — skips wallet projection work.
 * Pass `openingMetalOwedUg` when chaining from the previous day's closing balance.
 */
export async function buildDailyHedgeBookIndexLine(
  tenantId,
  metal,
  finenessPpm,
  reportBusinessDate,
  openingMetalOwedUg,
  session,
  { verifyLedger = false } = {},
) {
  const { start: periodStart, end: cutoffEnd } = istBusinessDayBounds(reportBusinessDate);

  let opening = openingMetalOwedUg;
  if (opening == null) {
    opening = await resolveOpeningMetalOwedUg(tenantId, metal, finenessPpm, periodStart, session);
  }

  const movements = await aggregateBookMovements(
    tenantId,
    metal,
    finenessPpm,
    periodStart,
    cutoffEnd,
    reportBusinessDate,
    session,
    { lite: true },
  );

  const closingMetalOwedUg = computeClosingMetalOwed({
    openingMetalOwedUg: opening,
    ...movements,
  });

  let ledgerReconcileDeltaUg = 0;
  if (verifyLedger) {
    const ledgerAtCutoff = await sumLedgerHeldReservedAtCutoff(tenantId, metal, finenessPpm, cutoffEnd, session);
    ledgerReconcileDeltaUg = ledgerAtCutoff.heldUg - closingMetalOwedUg;
  }

  return {
    metal,
    finenessPpm,
    _numeric: {
      openingMetalOwedUg: opening,
      closingMetalOwedUg,
      creditedBuyUg: movements.creditedBuyUg,
      executedSellUg: movements.executedSellUg,
      physicalHandoverUg: movements.physicalHandoverUg,
      correctionUg: movements.correctionUg,
      unclassifiedJournalUg: movements.unclassifiedJournalUg,
      ledgerReconcileDeltaUg,
    },
  };
}

/** Wallet drift vs live documents only at end-of-day live snapshot (not historical or mid-day `asOf`). */
export function isWalletProjectionDriftApplicable(reportBusinessDate, cutoffInstant) {
  if (reportBusinessDate !== today()) return false;
  const { end: businessDayEnd } = istBusinessDayBounds(reportBusinessDate);
  return cutoffInstant.getTime() >= businessDayEnd.getTime();
}

export function computeClosingMetalOwed({
  openingMetalOwedUg,
  creditedBuyUg,
  executedSellUg,
  physicalHandoverUg,
  correctionUg,
}) {
  return (
    openingMetalOwedUg +
    creditedBuyUg -
    executedSellUg -
    physicalHandoverUg +
    correctionUg
  );
}

export async function buildDailyHedgeBookLine(tenantId, metal, finenessPpm, reportBusinessDate, cutoffEnd, session) {
  const { start: periodStart } = istBusinessDayBounds(reportBusinessDate);

  const openingMetalOwedUg = await resolveOpeningMetalOwedUg(tenantId, metal, finenessPpm, periodStart, session);

  const movements = await aggregateBookMovements(
    tenantId,
    metal,
    finenessPpm,
    periodStart,
    cutoffEnd,
    reportBusinessDate,
    session,
  );

  const closingMetalOwedUg = computeClosingMetalOwed({
    openingMetalOwedUg,
    ...movements,
  });

  const ledgerAtCutoff = await sumLedgerHeldReservedAtCutoff(tenantId, metal, finenessPpm, cutoffEnd, session);
  const walletIds = await walletIdsForAsset(tenantId, metal, finenessPpm, session);
  let walletStoredHeldUg = 0;
  let walletStoredReservedUg = 0;
  if (walletIds.length) {
    const stored = await DigitalMetalWallet.aggregate([
      { $match: { tenantId, _id: { $in: walletIds } } },
      {
        $group: {
          _id: null,
          heldUg: { $sum: "$heldUg" },
          reservedUg: { $sum: "$reservedUg" },
        },
      },
    ]).session(session ?? null);
    walletStoredHeldUg = Number(stored[0]?.heldUg ?? 0);
    walletStoredReservedUg = Number(stored[0]?.reservedUg ?? 0);
  }
  const ledgerReconcileDeltaUg = ledgerAtCutoff.heldUg - closingMetalOwedUg;
  const walletProjectionDriftApplicable = isWalletProjectionDriftApplicable(reportBusinessDate, cutoffEnd);
  const walletProjectionDriftUg = walletProjectionDriftApplicable
    ? walletStoredHeldUg - ledgerAtCutoff.heldUg
    : 0;

  return {
    metal,
    finenessPpm,
    openingMetalOwedUg,
    closingMetalOwedUg,
    ledgerHeldUg: ledgerAtCutoff.heldUg,
    ledgerReservedUg: ledgerAtCutoff.reservedUg,
    ledgerReconcileDeltaUg,
    walletStoredHeldUg,
    walletStoredReservedUg,
    walletProjectionDriftUg,
    walletProjectionDriftApplicable,
    movements,
    _numeric: {
      openingMetalOwedUg,
      closingMetalOwedUg,
      ledgerHeldUg: ledgerAtCutoff.heldUg,
      ledgerReservedUg: ledgerAtCutoff.reservedUg,
      ledgerReconcileDeltaUg,
      walletStoredHeldUg,
      walletStoredReservedUg,
      walletProjectionDriftUg,
      walletProjectionDriftApplicable,
      creditedBuyUg: movements.creditedBuyUg,
      executedSellUg: movements.executedSellUg,
      physicalHandoverUg: movements.physicalHandoverUg,
      correctionUg: movements.correctionUg,
      unclassifiedJournalUg: movements.unclassifiedJournalUg,
    },
  };
}
