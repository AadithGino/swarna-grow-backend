#!/usr/bin/env node
/**
 * READ-ONLY: ambiguous digital-metal reservations + ledger context.
 * Usage (from repo root): node --env-file=<env> scripts/reconcile-ambiguous-reservations-readonly.mjs
 */
import mongoose from "mongoose";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { env } from "../src/config/env.js";
import { reservationAccountingIsAmbiguous } from "../src/services/digital-metals-ledger.service.js";
import {
  DigitalMetalReservation,
  DigitalMetalWallet,
  DigitalMetalLot,
  DigitalMetalJournal,
  DigitalMetalSellOrder,
  DigitalMetalRedemptionOrder,
} from "../src/models/index.js";

function uriIdentity(uri) {
  try {
    const u = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, "https://"));
    const db = (u.pathname || "/").replace(/^\//, "").split("?")[0] || "(default)";
    return { host: u.hostname, db, scheme: uri.startsWith("mongodb+srv") ? "mongodb+srv" : "mongodb" };
  } catch {
    return { host: "(unparsed)", db: "(unknown)", scheme: "mongodb" };
  }
}

function summarizeWallet(w) {
  if (!w) return null;
  return {
    id: w._id,
    heldUg: w.heldUg,
    reservedUg: w.reservedUg,
    pendingBuyUg: w.pendingBuyUg,
    availableUg: Math.max(0, (w.heldUg ?? 0) - (w.reservedUg ?? 0)),
  };
}

function summarizeLot(l) {
  return {
    id: l._id,
    quantityUg: l.quantityUg,
    reservedUg: l.reservedUg ?? 0,
    status: l.status,
    sourceKind: l.sourceKind,
  };
}

function journalSummary(j) {
  return {
    id: j._id,
    type: j.type,
    quantityUg: j.quantityUg,
    idempotencyKey: j.idempotencyKey,
    lotId: j.lotId ?? null,
    createdAt: j.createdAt,
  };
}

function repairProposal(record) {
  const { reservation: r, order, journals } = record;
  const proposals = [];
  const hasLotAlloc = Array.isArray(r.lotAllocations) && r.lotAllocations.length > 0;
  const hasLotClaimJournal = journals.some((j) => j.type === "LOT_CLAIM" || j.lotId);
  const hasSellDebit = journals.some((j) => String(j.idempotencyKey ?? "").startsWith("sell-debit:"));

  if (r.status === "RELEASED" || r.status === "CANCELLED") {
    proposals.push({
      action: "CLASSIFY_ONLY",
      rationale:
        "Terminal reservation with null lotAccountingMode: set marker only after human review of release/commit path.",
      suggestedMarker: "UNRESOLVED — do not auto-set from allocation presence alone.",
    });
  } else if (r.status === "COMMITTED") {
    if (hasLotAlloc || hasLotClaimJournal) {
      proposals.push({
        action: "REVIEW_THEN_SET",
        suggestedMarker: "FIFO_LOT_CLAIM",
        rationale: "Lot allocations or lot-linked journals present — verify quantities, then tag if evidence confirms FIFO claim.",
      });
    } else if (hasSellDebit && !hasLotAlloc) {
      proposals.push({
        action: "REVIEW_THEN_SET",
        suggestedMarker: "LEGACY_WALLET_RESERVE",
        rationale: "Sell debit without lot allocations — candidate legacy wallet reserve; verify wallet/lot totals before tagging.",
      });
    } else {
      proposals.push({ action: "UNRESOLVED", rationale: "Committed but insufficient evidence to choose accounting mode." });
    }
  } else if (r.status === "ACTIVE") {
    proposals.push({
      action: "UNRESOLVED",
      rationale: "Active ambiguous reservation — reconcile wallet reservedUg vs lots before classify/expire.",
    });
  }

  if (order && order.status === "PAYABLE_OPEN" && r.status !== "COMMITTED") {
    proposals.push({ action: "UNRESOLVED", rationale: "Order/reservation status mismatch — manual review required." });
  }

  return proposals;
}

const identity = uriIdentity(env.MONGODB_URI);
await mongoose.connect(env.MONGODB_URI, { autoIndex: false });
try {
  const candidates = await DigitalMetalReservation.find({
    status: { $in: ["ACTIVE", "COMMITTED", "RELEASED"] },
    lotAccountingMode: null,
  }).lean();
  const ambiguous = candidates.filter(reservationAccountingIsAmbiguous);

  const records = [];
  for (const r of ambiguous) {
    const wallet = await DigitalMetalWallet.findById(r.walletId).lean();
    const lots = await DigitalMetalLot.find({
      tenantId: r.tenantId,
      customerId: r.customerId,
      metal: r.metal,
      finenessPpm: r.finenessPpm,
    })
      .limit(50)
      .lean();
    const journals = await DigitalMetalJournal.find({
      tenantId: r.tenantId,
      walletId: r.walletId,
      $or: [
        { idempotencyKey: new RegExp(String(r._id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) },
        { idempotencyKey: new RegExp(`sell-debit:|sell-release:|redemption-debit:`) },
      ],
    })
      .sort({ sequence: 1 })
      .limit(40)
      .lean();

    let order = null;
    if (r.purpose === "SELL") {
      order = await DigitalMetalSellOrder.findOne({ reservationId: r._id }).lean();
    } else if (r.purpose === "REDEMPTION") {
      order = await DigitalMetalRedemptionOrder.findOne({ reservationId: r._id }).lean();
    }

    records.push({
      reservationId: r._id,
      tenantId: r.tenantId,
      customerId: r.customerId,
      purpose: r.purpose,
      status: r.status,
      lotAccountingMode: r.lotAccountingMode,
      quantityUg: r.quantityUg,
      lotAllocations: r.lotAllocations ?? [],
      idempotencyKey: r.idempotencyKey,
      wallet: summarizeWallet(wallet),
      lots: lots.map(summarizeLot),
      order: order
        ? {
            kind: r.purpose,
            id: order._id,
            status: order.status,
            reservationId: order.reservationId,
            payableId: order.payableId ?? null,
          }
        : null,
      journals: journals.map(journalSummary),
      repairProposals: repairProposal({ reservation: r, order, journals }),
    });
  }

  const out = {
    readOnly: true,
    generatedAt: new Date().toISOString(),
    preflightTarget: {
      nodeEnv: process.env.NODE_ENV ?? "(unset)",
      mongodb: identity,
      note: "Target is whatever database MONGODB_URI points to in the env file used; not labeled staging or production.",
    },
    ambiguousCount: records.length,
    records,
  };

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outPath =
    process.env.REPORT_OUT ?? join(repoRoot, "..", "evidence", "reservation-reconciliation-report.json");
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ outPath, ambiguousCount: records.length, host: identity.host, db: identity.db }, null, 2));
} finally {
  await mongoose.disconnect();
}
