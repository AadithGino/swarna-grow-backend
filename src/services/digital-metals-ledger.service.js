import { AppError, errors } from "../lib/app-error.js";
import { MAX_QUANTITY_UG, UG_PER_G } from "../lib/digital-metals-quote-engine.js";
import { createId } from "../lib/ids.js";
import { buildDigitalMetalPurchaseSummary } from "../lib/digital-metals-purchase-summary.js";
import { buildDigitalMetalSellSummary } from "../lib/digital-metals-sell-summary.js";
import {
  Customer,
  DigitalMetalBuyOrder,
  DigitalMetalBuyPaymentAttempt,
  DigitalMetalJournal,
  DigitalMetalLot,
  DigitalMetalReservation,
  DigitalMetalRedemptionOrder,
  DigitalMetalSellOrder,
  DigitalMetalWallet,
} from "../models/index.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";

export function availableUg(wallet) {
  const held = wallet?.heldUg ?? 0;
  const reserved = wallet?.reservedUg ?? 0;
  return Math.max(0, held - reserved);
}

async function getWalletLocked(session, tenantId, customerId, metal, finenessPpm) {
  let wallet = await DigitalMetalWallet.findOne({ tenantId, customerId, metal, finenessPpm }).session(session);
  if (!wallet) {
    const customer = await Customer.findOne({ _id: customerId, tenantId }).session(session).lean();
    if (!customer) throw errors.notFound("Customer");
    wallet = (
      await DigitalMetalWallet.create(
        [
          {
            _id: createId("dmw"),
            tenantId,
            customerId,
            branchId: customer.branchId ?? null,
            metal,
            finenessPpm,
            heldUg: 0,
            reservedUg: 0,
            pendingBuyUg: 0,
            journalSequence: 0,
            projectionVersion: 1,
          },
        ],
        { session },
      )
    )[0];
  }
  return wallet;
}

async function appendJournal(session, wallet, entry) {
  const nextSeq = (wallet.journalSequence ?? 0) + 1;
  const row = (
    await DigitalMetalJournal.create(
      [
        {
          _id: createId("dmj"),
          tenantId: wallet.tenantId,
          walletId: wallet._id,
          sequence: nextSeq,
          ...entry,
        },
      ],
      { session },
    )
  )[0];
  wallet.journalSequence = nextSeq;
  wallet.projectionVersion = (wallet.projectionVersion ?? 1) + 1;
  await wallet.save({ session });
  return row;
}

function assertQuantityBounds(quantityUg) {
  if (!Number.isSafeInteger(quantityUg) || quantityUg <= 0 || quantityUg > MAX_QUANTITY_UG) {
    throw new AppError("INVALID_QUANTITY", "Quantity is out of allowed bounds.", 422);
  }
}

async function eligibleLotsFifo(session, tenantId, walletId, quantityUg, holdingPeriodDays, now = new Date()) {
  const lots = await DigitalMetalLot.find({ tenantId, walletId, remainingUg: { $gt: 0 } })
    .sort({ acquiredAt: 1, _id: 1 })
    .session(session)
    .lean();
  const cutoffMs = holdingPeriodDays > 0 ? now.getTime() - holdingPeriodDays * 86_400_000 : now.getTime();
  const allocations = [];
  let remaining = quantityUg;
  for (const lot of lots) {
    if (remaining <= 0) break;
    if (holdingPeriodDays > 0 && new Date(lot.acquiredAt).getTime() > cutoffMs) continue;
    const take = Math.min(lot.remainingUg, remaining);
    if (take <= 0) continue;
    allocations.push({ lotId: lot._id, quantityUg: take });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new AppError("INSUFFICIENT_AVAILABLE_UG", "Not enough eligible metal quantity to reserve.", 409);
  }
  return allocations;
}

function assertTestCreditAllowed() {
  if (process.env.NODE_ENV !== "test") {
    throw new AppError("FORBIDDEN", "Test wallet credit is only available in test mode.", 403);
  }
}

async function creditWalletInternal(session, {
  tenantId,
  customerId,
  metal,
  finenessPpm,
  quantityUg,
  idempotencyKey,
  referenceType,
  referenceId,
  metadata = null,
}) {
  assertQuantityBounds(quantityUg);
  const existing = await DigitalMetalJournal.findOne({ tenantId, idempotencyKey }).session(session).lean();
  if (existing) return { idempotent: true, journalId: existing._id, walletId: existing.walletId };
  const wallet = await getWalletLocked(session, tenantId, customerId, metal, finenessPpm);
  wallet.heldUg = (wallet.heldUg ?? 0) + quantityUg;
  await wallet.save({ session });
  const journal = await appendJournal(session, wallet, {
    entryType: "CREDIT",
    quantityUgDelta: quantityUg,
    reservedUgDelta: 0,
    idempotencyKey,
    referenceType,
    referenceId,
    ...(metadata ? { metadata } : {}),
  });
  await DigitalMetalLot.create(
    [
      {
        _id: createId("dmlot"),
        tenantId,
        walletId: wallet._id,
        quantityUg,
        remainingUg: quantityUg,
        acquiredAt: new Date(),
        sourceJournalId: journal._id,
      },
    ],
    { session },
  );
  return { idempotent: false, journalId: journal._id, walletId: wallet._id };
}

/** Purchase finalization only — not routed over HTTP. */
export async function creditWalletFromPurchase(session, params) {
  return creditWalletInternal(session, {
    ...params,
    referenceType: "PURCHASE",
    referenceId: params.orderId,
    idempotencyKey: params.idempotencyKey ?? `purchase-credit:${params.orderId}`,
    metadata: params.metadata ?? null,
  });
}

/**
 * Test/internal credit — not exposed on public routes.
 */
export async function creditWalletForTest(session, {
  tenantId,
  customerId,
  metal,
  finenessPpm,
  quantityUg,
  idempotencyKey,
}) {
  assertTestCreditAllowed();
  return creditWalletInternal(session, {
    tenantId,
    customerId,
    metal,
    finenessPpm,
    quantityUg,
    idempotencyKey,
    referenceType: "TEST_FIXTURE",
    referenceId: idempotencyKey,
  });
}

export async function reserveWalletQuantity(session, params) {
  const {
    tenantId,
    customerId,
    metal,
    finenessPpm,
    quantityUg,
    purpose,
    idempotencyKey,
    holdingPeriodDays = 0,
    journalReferenceType = null,
    journalReferenceId = null,
    metadata = null,
  } = params;
  assertQuantityBounds(quantityUg);
  const dup = await DigitalMetalReservation.findOne({ tenantId, idempotencyKey }).session(session).lean();
  if (dup) return { reservation: dup, idempotent: true };
  const wallet = await getWalletLocked(session, tenantId, customerId, metal, finenessPpm);
  const lotAllocations = await eligibleLotsFifo(session, tenantId, wallet._id, quantityUg, holdingPeriodDays);
  const updated = await DigitalMetalWallet.findOneAndUpdate(
    {
      _id: wallet._id,
      $expr: {
        $gte: [
          { $subtract: [{ $ifNull: ["$heldUg", 0] }, { $ifNull: ["$reservedUg", 0] }] },
          quantityUg,
        ],
      },
    },
    { $inc: { reservedUg: quantityUg } },
    { session, new: true },
  );
  if (!updated) {
    throw new AppError("INSUFFICIENT_AVAILABLE_UG", "Insufficient available metal quantity.", 409);
  }
  wallet.reservedUg = updated.reservedUg;
  await appendJournal(session, wallet, {
    entryType: "RESERVE",
    quantityUgDelta: 0,
    reservedUgDelta: quantityUg,
    idempotencyKey: `${idempotencyKey}:journal`,
    referenceType: journalReferenceType ?? purpose,
    referenceId: journalReferenceId ?? idempotencyKey,
    metadata,
  });
  const reservation = (
    await DigitalMetalReservation.create(
      [
        {
          _id: createId("dmrsv"),
          tenantId,
          walletId: wallet._id,
          customerId,
          metal,
          finenessPpm,
          purpose,
          status: "ACTIVE",
          quantityUg,
          lotAllocations,
          idempotencyKey,
        },
      ],
      { session },
    )
  )[0];
  return { reservation: reservation.toObject(), idempotent: false };
}

export async function releaseReservation(session, tenantId, idempotencyKey, releaseKey) {
  const reservation = await DigitalMetalReservation.findOne({ tenantId, idempotencyKey }).session(session);
  if (!reservation) throw errors.notFound("Reservation");
  if (reservation.status === "RELEASED") return { idempotent: true };
  if (reservation.status !== "ACTIVE") {
    throw new AppError("INVALID_STATE", "Reservation is not active.", 409);
  }
  const wallet = await DigitalMetalWallet.findById(reservation.walletId).session(session);
  if (!wallet) throw errors.notFound("Wallet");
  wallet.reservedUg = Math.max(0, (wallet.reservedUg ?? 0) - reservation.quantityUg);
  await wallet.save({ session });
  reservation.status = "RELEASED";
  await reservation.save({ session });
  await appendJournal(session, wallet, {
    entryType: "RELEASE",
    quantityUgDelta: 0,
    reservedUgDelta: -reservation.quantityUg,
    idempotencyKey: releaseKey,
    referenceType: "RESERVATION",
    referenceId: reservation._id,
  });
  return { idempotent: false };
}

export async function commitReservation(session, tenantId, idempotencyKey, commitKey, journal = {}) {
  const reservation = await DigitalMetalReservation.findOne({ tenantId, idempotencyKey }).session(session);
  if (!reservation) throw errors.notFound("Reservation");
  if (reservation.status === "COMMITTED") return { idempotent: true };
  if (reservation.status !== "ACTIVE") {
    throw new AppError("INVALID_STATE", "Reservation is not active.", 409);
  }
  const wallet = await DigitalMetalWallet.findById(reservation.walletId).session(session);
  if (!wallet) throw errors.notFound("Wallet");
  const qty = reservation.quantityUg;
  wallet.reservedUg = Math.max(0, (wallet.reservedUg ?? 0) - qty);
  wallet.heldUg = Math.max(0, (wallet.heldUg ?? 0) - qty);
  await wallet.save({ session });
  for (const alloc of reservation.lotAllocations ?? []) {
    await DigitalMetalLot.updateOne(
      { _id: alloc.lotId, remainingUg: { $gte: alloc.quantityUg } },
      { $inc: { remainingUg: -alloc.quantityUg } },
      { session },
    );
  }
  reservation.status = "COMMITTED";
  await reservation.save({ session });
  await appendJournal(session, wallet, {
    entryType: "DEBIT",
    quantityUgDelta: -qty,
    reservedUgDelta: -qty,
    idempotencyKey: commitKey,
    referenceType: journal.referenceType ?? "RESERVATION",
    referenceId: journal.referenceId ?? reservation._id,
    metadata: journal.metadata ?? null,
  });
  return { idempotent: false };
}

export async function reverseJournalEntry(session, tenantId, originalJournalId, reversalKey) {
  const original = await DigitalMetalJournal.findOne({ _id: originalJournalId, tenantId }).session(session);
  if (!original) throw errors.notFound("Journal");
  const dup = await DigitalMetalJournal.findOne({ tenantId, idempotencyKey: reversalKey }).session(session).lean();
  if (dup) return { idempotent: true, journalId: dup._id };
  const wallet = await DigitalMetalWallet.findById(original.walletId).session(session);
  if (!wallet) throw errors.notFound("Wallet");
  if (original.entryType === "CREDIT") {
    if (availableUg(wallet) < (original.quantityUgDelta ?? 0)) {
      throw new AppError("INSUFFICIENT_AVAILABLE_UG", "Cannot reverse credit; quantity is reserved or spent.", 409);
    }
    wallet.heldUg = Math.max(0, (wallet.heldUg ?? 0) - (original.quantityUgDelta ?? 0));
    await wallet.save({ session });
  } else if (original.entryType === "RESERVE" || original.entryType === "RELEASE") {
    throw new AppError("INVALID_STATE", "Use reservation release/commit flows for reserve entries.", 409);
  }
  const journal = await appendJournal(session, wallet, {
    entryType: "REVERSAL",
    quantityUgDelta: -(original.quantityUgDelta ?? 0),
    reservedUgDelta: -(original.reservedUgDelta ?? 0),
    idempotencyKey: reversalKey,
    referenceType: "JOURNAL",
    referenceId: original._id,
  });
  return { idempotent: false, journalId: journal._id };
}

export async function applyWalletProjectionFix(session, walletId, { expectedProjectionVersion }) {
  const wallet = await DigitalMetalWallet.findById(walletId).session(session);
  if (!wallet) throw errors.notFound("Wallet");
  if (Number(wallet.projectionVersion) !== Number(expectedProjectionVersion)) {
    throw errors.conflict("PROJECTION_CONFLICT", "Wallet projection changed during rebuild.", {
      current: wallet.projectionVersion,
    });
  }
  const journals = await DigitalMetalJournal.find({ walletId }).session(session).lean();
  let held = 0;
  let reserved = 0;
  for (const j of journals) {
    held += j.quantityUgDelta ?? 0;
    reserved += j.reservedUgDelta ?? 0;
  }
  wallet.heldUg = held;
  wallet.reservedUg = reserved;
  wallet.projectionVersion = (wallet.projectionVersion ?? 1) + 1;
  await wallet.save({ session });
  return { rebuilt: true, heldUg: held, reservedUg: reserved };
}

export async function rebuildWalletProjection(session, walletId, { expectedProjectionVersion }) {
  const wallet = await DigitalMetalWallet.findById(walletId).session(session);
  if (!wallet) throw errors.notFound("Wallet");
  if (Number(wallet.projectionVersion) !== Number(expectedProjectionVersion)) {
    throw errors.conflict("PROJECTION_CONFLICT", "Wallet projection changed during rebuild.", {
      current: wallet.projectionVersion,
    });
  }
  const journals = await DigitalMetalJournal.find({ walletId }).session(session).lean();
  let held = 0;
  let reserved = 0;
  for (const j of journals) {
    held += j.quantityUgDelta ?? 0;
    reserved += j.reservedUgDelta ?? 0;
  }
  const discrepancies = [];
  if (held !== wallet.heldUg) discrepancies.push({ field: "heldUg", projected: held, stored: wallet.heldUg });
  if (reserved !== wallet.reservedUg) discrepancies.push({ field: "reservedUg", projected: reserved, stored: wallet.reservedUg });
  if (discrepancies.length) {
    return { ok: false, discrepancies, rebuilt: false };
  }
  return { ok: true, discrepancies: [], rebuilt: false };
}

export function mapWalletDto(wallet) {
  const held = wallet.heldUg ?? 0;
  const reserved = wallet.reservedUg ?? 0;
  return {
    id: wallet._id,
    metal: wallet.metal,
    finenessPpm: wallet.finenessPpm,
    heldUg: String(held),
    reservedUg: String(reserved),
    availableUg: String(Math.max(0, held - reserved)),
    pendingBuyUg: String(wallet.pendingBuyUg ?? 0),
    branchId: wallet.branchId ?? null,
  };
}

async function attachEstimatedSaleValue(tenantId, walletDto) {
  const { latestEffectiveRate, latestSettings } = await import("./digital-metals-phase2.service.js");
  const { isRateStale } = await import("../lib/digital-metals-quote-engine.js");
  const { DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS } = await import("../models/digital-metals.models.js");
  const rate = await latestEffectiveRate(tenantId, walletDto.metal, walletDto.finenessPpm);
  if (!rate) {
    return { ...walletDto, estimatedSaleValue: null, valuationStatus: "RATE_UNAVAILABLE" };
  }
  const settings = await latestSettings(tenantId, walletDto.metal, walletDto.finenessPpm);
  const maxAgeSeconds = settings?.rateMaxAgeSeconds ?? DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS;
  const stale = isRateStale(rate, maxAgeSeconds);
  const heldUg = Number(walletDto.heldUg);
  const grams = heldUg / 1_000_000;
  const paise = Math.round(grams * Number(rate.customerSellRatePerGramPaise));
  return {
    ...walletDto,
    estimatedSaleValue: stale
      ? null
      : {
          amountPaise: paise,
          currency: "INR",
          ratePerGramPaise: rate.customerSellRatePerGramPaise,
          feeAssumption: "Tenant sell fee per published settings; excludes pending reservations.",
        },
    valuationStatus: stale ? "STALE_RATE" : "OK",
  };
}

export async function listCustomerPortfolio(req) {
  const wallets = await DigitalMetalWallet.find({
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  const items = [];
  for (const w of wallets) {
    items.push(await attachEstimatedSaleValue(req.auth.tenantId, mapWalletDto(w)));
  }
  return {
    items,
    pendingBuyUg: String(wallets.reduce((s, w) => s + (w.pendingBuyUg ?? 0), 0)),
  };
}

export async function listCustomerPassbook(req) {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const cursor = req.query.cursor ? String(req.query.cursor) : null;
  const filter = { tenantId: req.auth.tenantId };
  const walletIds = (
    await DigitalMetalWallet.find({ tenantId: req.auth.tenantId, customerId: req.auth.id }).select("_id").lean()
  ).map((w) => w._id);
  filter.walletId = { $in: walletIds };
  if (cursor) filter._id = { $lt: cursor };
  const rows = await DigitalMetalJournal.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const purchaseOrderIds = [
    ...new Set(
      pageRows
        .filter((r) => r.referenceType === "PURCHASE" && r.referenceId)
        .map((r) => String(r.referenceId)),
    ),
  ];
  const purchaseOrders = purchaseOrderIds.length
    ? await DigitalMetalBuyOrder.find({
        tenantId: req.auth.tenantId,
        _id: { $in: purchaseOrderIds },
        customerId: req.auth.id,
      }).lean()
    : [];
  const orderById = new Map(purchaseOrders.map((o) => [o._id, o]));
  const attemptByOrderId = new Map();
  if (purchaseOrders.length) {
    const attempts = await DigitalMetalBuyPaymentAttempt.find({
      tenantId: req.auth.tenantId,
      orderId: { $in: purchaseOrders.map((o) => o._id) },
      status: "SUCCEEDED",
    }).lean();
    for (const a of attempts) {
      if (!attemptByOrderId.has(a.orderId)) attemptByOrderId.set(a.orderId, a);
    }
  }
  const items = pageRows.map((r) => {
    const base = {
      id: r._id,
      entryType: r.entryType,
      quantityUgDelta: String(r.quantityUgDelta),
      reservedUgDelta: String(r.reservedUgDelta ?? 0),
      sequence: r.sequence,
      referenceType: r.referenceType ?? null,
      referenceId: r.referenceId ?? null,
      createdAt: r.createdAt,
      metadata: r.metadata ?? null,
    };
    if (r.referenceType === "PURCHASE" && r.referenceId) {
      const fromMeta =
        r.metadata?.kind === "PURCHASE" && r.metadata.orderId ? r.metadata : null;
      if (fromMeta) {
        return { ...base, purchaseSummary: fromMeta };
      }
      const order = orderById.get(String(r.referenceId));
      if (order) {
        return {
          ...base,
          purchaseSummary: buildDigitalMetalPurchaseSummary(
            order,
            attemptByOrderId.get(order._id) ?? null,
          ),
        };
      }
    }
    return base;
  });
  const withSell = await attachSellSummariesToPassbookItems(req.auth.tenantId, req.auth.id, items);
  const enrichedItems = await attachRedemptionSummariesToPassbookItems(
    req.auth.tenantId,
    req.auth.id,
    withSell,
  );
  return {
    items: enrichedItems,
    meta: { nextCursor: hasMore ? enrichedItems[enrichedItems.length - 1]?.id ?? null : null, hasMore, limit },
  };
}

async function attachSellSummariesToPassbookItems(tenantId, customerId, items) {
  const orderIds = new Set();
  const reservationIds = new Set();
  const idempotencyKeys = new Set();
  for (const row of items) {
    if (row.metadata?.kind === "SELL" && row.metadata.orderId) continue;
    const ref = row.referenceId ? String(row.referenceId) : "";
    if (row.referenceType === "SELL" && ref) {
      if (ref.startsWith("dmso_")) orderIds.add(ref);
      else idempotencyKeys.add(ref.replace(/:journal$/, "").replace(/:reserve$/, ""));
    }
    if (row.referenceType === "RESERVATION" && ref.startsWith("dmrsv_")) {
      reservationIds.add(ref);
    }
  }
  const sellOrders = [];
  if (orderIds.size) {
    sellOrders.push(
      ...(await DigitalMetalSellOrder.find({
        tenantId,
        customerId,
        _id: { $in: [...orderIds] },
      }).lean()),
    );
  }
  if (reservationIds.size) {
    sellOrders.push(
      ...(await DigitalMetalSellOrder.find({
        tenantId,
        customerId,
        reservationId: { $in: [...reservationIds] },
      }).lean()),
    );
  }
  if (idempotencyKeys.size) {
    sellOrders.push(
      ...(await DigitalMetalSellOrder.find({
        tenantId,
        customerId,
        idempotencyKey: { $in: [...idempotencyKeys] },
      }).lean()),
    );
  }
  const byOrderId = new Map();
  const byReservationId = new Map();
  const byIdempotencyKey = new Map();
  for (const o of sellOrders) {
    byOrderId.set(o._id, o);
    if (o.reservationId) byReservationId.set(o.reservationId, o);
    if (o.idempotencyKey) byIdempotencyKey.set(o.idempotencyKey, o);
  }
  return items.map((row) => {
    if (row.metadata?.kind === "SELL" && row.metadata.orderId) {
      const sellSummary = { ...row.metadata };
      delete sellSummary.kind;
      return {
        ...row,
        sellSummary,
        sellOrderId: row.metadata.orderId,
        referenceType: "SELL",
        referenceId: row.metadata.orderId,
      };
    }
    const ref = row.referenceId ? String(row.referenceId) : "";
    let order = null;
    if (row.referenceType === "SELL" && ref.startsWith("dmso_")) {
      order = byOrderId.get(ref);
    } else if (row.referenceType === "SELL" && ref) {
      const key = ref.replace(/:journal$/, "").replace(/:reserve$/, "");
      order = byIdempotencyKey.get(key);
    } else if (row.referenceType === "RESERVATION" && ref.startsWith("dmrsv_")) {
      order = byReservationId.get(ref);
    }
    if (!order) return row;
    const sellSummary = buildDigitalMetalSellSummary(order);
    return {
      ...row,
      sellOrderId: order._id,
      referenceType: row.referenceType === "RESERVATION" ? "SELL" : row.referenceType,
      referenceId: order._id,
      sellSummary,
    };
  });
}

function normalizeRedemptionOrderIdempotencyKey(referenceId) {
  return String(referenceId).replace(/:journal$/, "").replace(/:reserve$/, "");
}

function buildRedemptionPassbookSummary(order) {
  return {
    kind: "REDEMPTION",
    orderId: order._id,
    status: order.status,
    metal: order.metal,
    finenessPpm: order.finenessPpm,
    quantityUg: String(order.quantityUg),
    fulfilmentMode: order.fulfilmentMode ?? null,
    chargeTotalPaise: order.chargeTotalPaise ?? 0,
    createdAt: order.createdAt ?? null,
  };
}

async function attachRedemptionSummariesToPassbookItems(tenantId, customerId, items) {
  const reservationIds = new Set();
  const idempotencyKeys = new Set();
  for (const row of items) {
    if (row.redemptionOrderId || row.sellOrderId) continue;
    const ref = row.referenceId ? String(row.referenceId) : "";
    if (row.referenceType === "REDEMPTION" && ref) {
      idempotencyKeys.add(normalizeRedemptionOrderIdempotencyKey(ref));
    }
    if (row.referenceType === "RESERVATION" && ref.startsWith("dmrsv_")) {
      reservationIds.add(ref);
    }
  }
  const orders = [];
  if (reservationIds.size) {
    orders.push(
      ...(await DigitalMetalRedemptionOrder.find({
        tenantId,
        customerId,
        reservationId: { $in: [...reservationIds] },
      }).lean()),
    );
  }
  if (idempotencyKeys.size) {
    orders.push(
      ...(await DigitalMetalRedemptionOrder.find({
        tenantId,
        customerId,
        idempotencyKey: { $in: [...idempotencyKeys] },
      }).lean()),
    );
  }
  const byReservationId = new Map();
  const byIdempotencyKey = new Map();
  for (const order of orders) {
    byReservationId.set(order.reservationId, order);
    if (order.idempotencyKey) byIdempotencyKey.set(order.idempotencyKey, order);
  }
  return items.map((row) => {
    if (row.redemptionOrderId) return row;
    const ref = row.referenceId ? String(row.referenceId) : "";
    let order = null;
    if (row.referenceType === "REDEMPTION" && ref) {
      order = byIdempotencyKey.get(normalizeRedemptionOrderIdempotencyKey(ref));
    } else if (row.referenceType === "RESERVATION" && ref.startsWith("dmrsv_") && !row.sellOrderId) {
      order = byReservationId.get(ref);
    }
    if (!order) return row;
    return {
      ...row,
      redemptionOrderId: order._id,
      referenceType: "REDEMPTION",
      referenceId: order._id,
      redemptionSummary: buildRedemptionPassbookSummary(order),
    };
  });
}

export async function listAdminCustomerWallets(req) {
  const customer = await Customer.findOne({ _id: req.params.customerId, tenantId: req.auth.tenantId }).lean();
  if (!customer) throw errors.notFound("Customer");
  assertTenantOwnsCustomerScope(req, customer);
  const wallets = await DigitalMetalWallet.find({
    tenantId: req.auth.tenantId,
    customerId: customer._id,
  }).lean();
  return { items: wallets.map(mapWalletDto) };
}

export async function listAdminCustomerPassbook(req) {
  const customer = await Customer.findOne({ _id: req.params.customerId, tenantId: req.auth.tenantId }).lean();
  if (!customer) throw errors.notFound("Customer");
  assertTenantOwnsCustomerScope(req, customer);
  req.auth.id = customer._id;
  return listCustomerPassbook(req);
}

export { UG_PER_G };
