import { DIGITAL_METAL_OUTBOX_TOPICS, enqueueDigitalMetalOutboxEvent } from "../lib/digital-metals-outbox.js";
import {
  DigitalMetalBuyOrder,
  DigitalMetalDocumentArtifact,
  DigitalMetalNotificationIntentRepairCursor,
  DigitalMetalOutboxEvent,
  DigitalMetalPayout,
  DigitalMetalRedemptionOrder,
  DigitalMetalSellOrder,
} from "../models/index.js";
import { enqueueDocumentReadyNotice } from "../lib/digital-metals-customer-notice.js";

const CURSOR_IDS = {
  buyCredited: "repair:buy_credited",
  sellExecuted: "repair:sell_executed",
  documentReady: "repair:document_ready",
  redemptionChargePaid: "repair:redemption_charge_paid",
  payoutNotice: "repair:payout_customer_notice",
};

async function outboxIntentExists(tenantId, topic, key) {
  return DigitalMetalOutboxEvent.exists({ tenantId, topic, key });
}

async function loadCursor(streamId) {
  const row = await DigitalMetalNotificationIntentRepairCursor.findById(streamId).lean();
  if (row) return row;
  return { _id: streamId, sortAt: new Date(0), tieId: "", version: 0 };
}

function cursorAdvanceClause(cursor, sortField, at) {
  const sortAt = cursor.sortAt ? new Date(cursor.sortAt) : new Date(0);
  const tieId = cursor.tieId ?? "";
  return {
    $and: [
      { [sortField]: { $lte: at } },
      { $or: [{ [sortField]: { $gt: sortAt } }, { [sortField]: sortAt, _id: { $gt: tieId } }] },
    ],
  };
}

async function advanceCursor(streamId, lastRow, sortField) {
  if (!lastRow) {
    await DigitalMetalNotificationIntentRepairCursor.findOneAndUpdate(
      { _id: streamId },
      {
        $set: { sortAt: new Date(0), tieId: "", updatedAt: new Date() },
        $inc: { version: 1 },
      },
      { upsert: true },
    );
    return;
  }
  const sortAt = lastRow[sortField] instanceof Date ? lastRow[sortField] : new Date(lastRow[sortField] ?? 0);
  await DigitalMetalNotificationIntentRepairCursor.findOneAndUpdate(
    { _id: streamId },
    {
      $set: { sortAt, tieId: lastRow._id, updatedAt: new Date() },
      $inc: { version: 1 },
    },
    { upsert: true },
  );
}

export async function ensureDocumentReadyNotificationIntent(artifact, { session } = {}) {
  if (!artifact?.customerId || artifact.status !== "READY") return { outcome: "NOT_APPLICABLE" };
  const key = `${artifact._id}:ready`;
  const exists = await outboxIntentExists(artifact.tenantId, DIGITAL_METAL_OUTBOX_TOPICS.DOCUMENT_READY, key);
  if (exists) {
    if (!artifact.customerReadyNoticeEnqueuedAt) {
      await DigitalMetalDocumentArtifact.updateOne(
        { _id: artifact._id, tenantId: artifact.tenantId },
        { $set: { customerReadyNoticeEnqueuedAt: new Date() } },
        session ? { session } : undefined,
      );
      return { outcome: "MARKER_REPAIRED" };
    }
    return { outcome: "ALREADY_ENQUEUED" };
  }
  if (session) {
    await enqueueDocumentReadyNotice({
      tenantId: artifact.tenantId,
      artifactId: artifact._id,
      customerId: artifact.customerId,
      session,
    });
    await DigitalMetalDocumentArtifact.updateOne(
      { _id: artifact._id, tenantId: artifact.tenantId },
      { $set: { customerReadyNoticeEnqueuedAt: new Date() } },
      { session },
    );
  } else {
    await enqueueDocumentReadyNotice({
      tenantId: artifact.tenantId,
      artifactId: artifact._id,
      customerId: artifact.customerId,
    });
    await DigitalMetalDocumentArtifact.updateOne(
      { _id: artifact._id, tenantId: artifact.tenantId, customerReadyNoticeEnqueuedAt: null },
      { $set: { customerReadyNoticeEnqueuedAt: new Date() } },
    );
  }
  return { outcome: "ENQUEUED" };
}

async function repairBuyCreditedBatch({ at, limit }) {
  const streamId = CURSOR_IDS.buyCredited;
  const cursor = await loadCursor(streamId);
  const batch = await DigitalMetalBuyOrder.find({
    status: "CREDITED",
    creditedAt: { $ne: null },
    ...cursorAdvanceClause(cursor, "creditedAt", at),
  })
    .sort({ creditedAt: 1, _id: 1 })
    .limit(limit)
    .lean();

  let enqueued = 0;
  let markers = 0;
  for (const order of batch) {
    const key = order._id;
    const exists = await outboxIntentExists(order.tenantId, DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED, key);
    if (exists) {
      if (!order.purchaseCreditedNoticeEnqueuedAt) {
        await DigitalMetalBuyOrder.updateOne(
          { _id: order._id, tenantId: order.tenantId },
          { $set: { purchaseCreditedNoticeEnqueuedAt: new Date() } },
        );
        markers += 1;
      }
      continue;
    }
    await enqueueDigitalMetalOutboxEvent({
      tenantId: order.tenantId,
      topic: DIGITAL_METAL_OUTBOX_TOPICS.PURCHASE_CREDITED,
      key,
      payload: { orderId: order._id, customerId: order.customerId, repair: true },
    });
    await DigitalMetalBuyOrder.updateOne(
      { _id: order._id, tenantId: order.tenantId },
      { $set: { purchaseCreditedNoticeEnqueuedAt: new Date() } },
    );
    enqueued += 1;
  }
  await advanceCursor(streamId, batch.at(-1), "creditedAt");
  return { scanned: batch.length, enqueued, markers };
}

async function repairSellExecutedBatch({ at, limit }) {
  const streamId = CURSOR_IDS.sellExecuted;
  const cursor = await loadCursor(streamId);
  const batch = await DigitalMetalSellOrder.find({
    status: "PAYABLE_OPEN",
    executedAt: { $ne: null },
    ...cursorAdvanceClause(cursor, "executedAt", at),
  })
    .sort({ executedAt: 1, _id: 1 })
    .limit(limit)
    .lean();

  let enqueued = 0;
  let markers = 0;
  for (const order of batch) {
    const exists = await outboxIntentExists(order.tenantId, DIGITAL_METAL_OUTBOX_TOPICS.SELL_EXECUTED, order._id);
    if (exists) {
      if (!order.sellExecutedNoticeEnqueuedAt) {
        await DigitalMetalSellOrder.updateOne(
          { _id: order._id, tenantId: order.tenantId },
          { $set: { sellExecutedNoticeEnqueuedAt: new Date() } },
        );
        markers += 1;
      }
      continue;
    }
    await enqueueDigitalMetalOutboxEvent({
      tenantId: order.tenantId,
      topic: DIGITAL_METAL_OUTBOX_TOPICS.SELL_EXECUTED,
      key: order._id,
      payload: {
        orderId: order._id,
        customerId: order.customerId,
        eventAt: order.executedAt?.toISOString?.(),
        repair: true,
      },
    });
    await DigitalMetalSellOrder.updateOne(
      { _id: order._id, tenantId: order.tenantId },
      { $set: { sellExecutedNoticeEnqueuedAt: new Date() } },
    );
    enqueued += 1;
  }
  await advanceCursor(streamId, batch.at(-1), "executedAt");
  return { scanned: batch.length, enqueued, markers };
}

async function repairDocumentReadyBatch({ limit }) {
  const streamId = CURSOR_IDS.documentReady;
  const cursor = await loadCursor(streamId);
  const at = new Date();
  const batch = await DigitalMetalDocumentArtifact.find({
    status: "READY",
    customerId: { $ne: null },
    ...cursorAdvanceClause(cursor, "updatedAt", at),
  })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit)
    .lean();

  let enqueued = 0;
  let markers = 0;
  for (const artifact of batch) {
    const r = await ensureDocumentReadyNotificationIntent(artifact);
    if (r.outcome === "ENQUEUED") enqueued += 1;
    if (r.outcome === "MARKER_REPAIRED") markers += 1;
  }
  await advanceCursor(streamId, batch.at(-1), "updatedAt");
  return { scanned: batch.length, enqueued, markers };
}

async function repairRedemptionChargePaidBatch({ at, limit }) {
  const streamId = CURSOR_IDS.redemptionChargePaid;
  const cursor = await loadCursor(streamId);
  const batch = await DigitalMetalRedemptionOrder.find({
    status: "CHARGE_PAID",
    chargePaidAt: { $ne: null },
    ...cursorAdvanceClause(cursor, "chargePaidAt", at),
  })
    .sort({ chargePaidAt: 1, _id: 1 })
    .limit(limit)
    .lean();

  let enqueued = 0;
  let markers = 0;
  for (const order of batch) {
    const key = `${order._id}:CHARGE_PAID`;
    const exists = await outboxIntentExists(
      order.tenantId,
      DIGITAL_METAL_OUTBOX_TOPICS.REDEMPTION_CUSTOMER_NOTICE,
      key,
    );
    if (exists) {
      if (!order.chargePaidCustomerNoticeEnqueuedAt) {
        await DigitalMetalRedemptionOrder.updateOne(
          { _id: order._id, tenantId: order.tenantId },
          { $set: { chargePaidCustomerNoticeEnqueuedAt: new Date() } },
        );
        markers += 1;
      }
      continue;
    }
    await enqueueDigitalMetalOutboxEvent({
      tenantId: order.tenantId,
      topic: DIGITAL_METAL_OUTBOX_TOPICS.REDEMPTION_CUSTOMER_NOTICE,
      key,
      payload: {
        orderId: order._id,
        customerId: order.customerId,
        transition: "CHARGE_PAID",
        eventAt: order.chargePaidAt?.toISOString?.() ?? new Date().toISOString(),
        repair: true,
      },
    });
    await DigitalMetalRedemptionOrder.updateOne(
      { _id: order._id, tenantId: order.tenantId },
      { $set: { chargePaidCustomerNoticeEnqueuedAt: new Date() } },
    );
    enqueued += 1;
  }
  await advanceCursor(streamId, batch.at(-1), "chargePaidAt");
  return { scanned: batch.length, enqueued, markers };
}

const PAYOUT_NOTICE_TRANSITIONS = {
  FAILED: "FAILED",
  SETTLED: "SETTLED",
  UNKNOWN: "UNKNOWN",
};

async function repairPayoutNoticeBatch({ at, limit }) {
  const streamId = CURSOR_IDS.payoutNotice;
  const cursor = await loadCursor(streamId);
  const batch = await DigitalMetalPayout.find({
    status: { $in: Object.keys(PAYOUT_NOTICE_TRANSITIONS) },
    ...cursorAdvanceClause(cursor, "updatedAt", at),
  })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit)
    .lean();

  let enqueued = 0;
  for (const payout of batch) {
    const transition = PAYOUT_NOTICE_TRANSITIONS[payout.status];
    if (!transition) continue;
    const key = `${payout._id}:${transition}`;
    if (await outboxIntentExists(payout.tenantId, DIGITAL_METAL_OUTBOX_TOPICS.PAYOUT_CUSTOMER_NOTICE, key)) {
      continue;
    }
    await enqueueDigitalMetalOutboxEvent({
      tenantId: payout.tenantId,
      topic: DIGITAL_METAL_OUTBOX_TOPICS.PAYOUT_CUSTOMER_NOTICE,
      key,
      payload: {
        payoutId: payout._id,
        customerId: payout.customerId,
        transition,
        eventAt: (payout.settledAt ?? payout.updatedAt ?? new Date()).toISOString?.(),
        repair: true,
      },
    });
    enqueued += 1;
  }
  await advanceCursor(streamId, batch.at(-1), "updatedAt");
  return { scanned: batch.length, enqueued, markers: 0 };
}

export async function reconcileMissingDigitalMetalNotificationIntents({ at = new Date(), limit = 25 } = {}) {
  const buy = await repairBuyCreditedBatch({ at, limit });
  const sell = await repairSellExecutedBatch({ at, limit });
  const documentReady = await repairDocumentReadyBatch({ limit });
  const redemption = await repairRedemptionChargePaidBatch({ at, limit });
  const payout = await repairPayoutNoticeBatch({ at, limit });

  const counts = {
    buyCredited: buy.enqueued,
    sellExecuted: sell.enqueued,
    documentReady: documentReady.enqueued,
    redemptionChargePaid: redemption.enqueued,
    payoutNotice: payout.enqueued,
    markersRepaired:
      buy.markers + sell.markers + documentReady.markers + redemption.markers,
  };
  const total =
    counts.buyCredited +
    counts.sellExecuted +
    counts.documentReady +
    counts.redemptionChargePaid +
    counts.payoutNotice +
    counts.markersRepaired;
  return {
    repaired: total > 0,
    counts,
    cursors: { buy, sell, documentReady, redemption, payout },
    at: at.toISOString(),
  };
}
