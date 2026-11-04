import {
  EcommerceOrder,
  Payment,
  Scheme,
  DigitalMetalBuyOrder,
  DigitalMetalRedemptionOrder,
  DigitalMetalSellOrder,
  DigitalMetalPayable,
} from "../models/index.js";
import { EcommerceOrderStatus } from "../constants/enums.js";
import { moneyRef } from "./money.js";
import {
  isPositiveNetContributionPayment,
  netCollectionStatusFilter,
  paymentNetFieldsFromDoc,
} from "./payment-net-aggregation.js";

const ACTIVITY_CURSOR_VERSION = 1;

function encodeActivityCursor(item) {
  if (!item) return null;
  return Buffer.from(
    JSON.stringify({
      v: ACTIVITY_CURSOR_VERSION,
      occurredAt: item.occurredAt,
      id: item.id,
    }),
  ).toString("base64url");
}

function parseActivityCursor(cursor) {
  if (!cursor || typeof cursor !== "string") return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed?.v !== ACTIVITY_CURSOR_VERSION || !parsed.id || !parsed.occurredAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function compareActivityDesc(a, b) {
  const ta = new Date(a.occurredAt).getTime();
  const tb = new Date(b.occurredAt).getTime();
  if (tb !== ta) return tb - ta;
  return String(b.id).localeCompare(String(a.id));
}

/** Next page: strictly older than cursor in sort order. */
function isBeforeActivityCursor(item, cursor) {
  if (!cursor) return true;
  const ta = new Date(item.occurredAt).getTime();
  const tc = new Date(cursor.occurredAt).getTime();
  if (ta !== tc) return ta < tc;
  return String(item.id) < String(cursor.id);
}

function activityRow({
  id,
  kind,
  direction,
  title,
  subtitle,
  amountPaise,
  occurredAt,
  statusLabel,
  entityId,
  metal,
  lineType = "CASH",
  metalDeltaUg,
  finenessPpm,
}) {
  const row = {
    id,
    kind,
    direction,
    title,
    subtitle: subtitle || undefined,
    amount: moneyRef(Math.max(0, Number(amountPaise ?? 0))),
    occurredAt: new Date(occurredAt ?? Date.now()).toISOString(),
    statusLabel: statusLabel || undefined,
    entityId,
    metal: metal ? String(metal).toUpperCase() : undefined,
    lineType,
  };
  if (metalDeltaUg != null && Number.isFinite(Number(metalDeltaUg)) && Number(metalDeltaUg) !== 0) {
    row.metalDeltaUg = Number(metalDeltaUg);
  }
  if (finenessPpm != null && Number.isFinite(Number(finenessPpm))) {
    row.finenessPpm = Number(finenessPpm);
  }
  return row;
}

async function collectActivityCandidates(auth, { perSource }) {
  const { tenantId, id: customerId } = auth;

  const paymentQuery = {
    tenantId,
    customerId,
    ...netCollectionStatusFilter(),
  };
  const shopQuery = {
    tenantId,
    customerId,
    paidAt: { $ne: null },
    status: { $nin: [EcommerceOrderStatus.PENDING_PAYMENT, EcommerceOrderStatus.PAYMENT_FAILED] },
  };
  const buyQuery = {
    tenantId,
    customerId,
    status: "CREDITED",
  };
  const sellPayableQuery = {
    tenantId,
    customerId,
    status: "SETTLED",
  };
  const sellMetalQuery = {
    tenantId,
    customerId,
    executedAt: { $ne: null },
  };
  const redeemQuery = {
    tenantId,
    customerId,
    status: {
      $in: [
        "CHARGE_PAID",
        "FULFILMENT_ACCEPTED",
        "PACKING",
        "DISPATCHED",
        "PICKUP_READY",
        "COMPLETED",
        "INVESTIGATION",
      ],
    },
  };

  const [schemeRows, shopRows, buyRows, sellPayables, sellMetalRows, redeemRows] = await Promise.all([
    Payment.find(paymentQuery).sort({ paidAt: -1 }).limit(perSource * 2).lean(),
    EcommerceOrder.find(shopQuery).sort({ paidAt: -1 }).limit(perSource).lean(),
    DigitalMetalBuyOrder.find(buyQuery).sort({ creditedAt: -1, updatedAt: -1 }).limit(perSource).lean(),
    DigitalMetalPayable.find(sellPayableQuery).sort({ settledAt: -1 }).limit(perSource).lean(),
    DigitalMetalSellOrder.find(sellMetalQuery).sort({ executedAt: -1 }).limit(perSource).lean(),
    DigitalMetalRedemptionOrder.find(redeemQuery).sort({ updatedAt: -1 }).limit(perSource).lean(),
  ]);

  const schemePayments = schemeRows.filter(isPositiveNetContributionPayment).slice(0, perSource);
  const schemeIds = [...new Set(schemePayments.map((row) => row.schemeId))];
  const schemeDocs = schemeIds.length
    ? await Scheme.find({ _id: { $in: schemeIds } })
        .select("_id enrollmentNumber planSnapshot.name planSnapshot.displayName")
        .lean()
    : [];
  const schemeMap = new Map(schemeDocs.map((row) => [String(row._id), row]));

  const sellOrderIds = sellPayables.map((p) => p.sellOrderId).filter(Boolean);
  const sellOrders = sellOrderIds.length
    ? await DigitalMetalSellOrder.find({ _id: { $in: sellOrderIds } }).lean()
    : [];
  const sellMap = new Map(sellOrders.map((row) => [String(row._id), row]));

  const items = [];

  for (const payment of schemePayments) {
    const scheme = schemeMap.get(String(payment.schemeId));
    const net = paymentNetFieldsFromDoc(payment);
    items.push(
      activityRow({
        id: `scheme_pay_${payment._id}`,
        kind: "SCHEME_PAYMENT",
        direction: "OUT",
        title: "Scheme instalment",
        subtitle:
          scheme?.planSnapshot?.displayName
          ?? scheme?.planSnapshot?.name
          ?? scheme?.enrollmentNumber
          ?? "",
        amountPaise: net.netAmountPaise,
        occurredAt: payment.paidAt ?? payment.createdAt,
        statusLabel: "Paid",
        entityId: payment._id,
      }),
    );
  }

  for (const order of shopRows) {
    const firstLine = order.lines?.[0];
    items.push(
      activityRow({
        id: `shop_${order._id}`,
        kind: "SHOP_ORDER",
        direction: "OUT",
        title: "Shop purchase",
        subtitle: firstLine?.name ? String(firstLine.name) : String(order.orderNumber ?? order._id),
        amountPaise: order.totalPaise ?? 0,
        occurredAt: order.paidAt ?? order.createdAt,
        statusLabel: order.status === EcommerceOrderStatus.PAID ? "Paid" : String(order.status ?? ""),
        entityId: order._id,
      }),
    );
  }

  for (const order of buyRows) {
    const metal = String(order.metal ?? "GOLD");
    const quantityUg = Number(order.quantityUg ?? 0);
    const creditedAt = order.creditedAt ?? order.updatedAt ?? order.createdAt;
    items.push(
      activityRow({
        id: `dm_buy_cash_${order._id}`,
        kind: "DIGITAL_METALS_BUY",
        direction: "OUT",
        lineType: "CASH",
        title: `Digital ${metal.toLowerCase()} buy`,
        subtitle: order.orderNumber ? String(order.orderNumber) : undefined,
        amountPaise: order.totalPayablePaise ?? order.quoteSnapshot?.totalPayablePaise ?? 0,
        occurredAt: creditedAt,
        statusLabel: "Payment",
        entityId: order._id,
        metal,
      }),
    );
    if (quantityUg > 0) {
      items.push(
        activityRow({
          id: `dm_buy_metal_${order._id}`,
          kind: "DIGITAL_METALS_BUY_METAL",
          direction: "IN",
          lineType: "METAL",
          title: "Added to wallet",
          subtitle: `${metal.toLowerCase()} purchase`,
          amountPaise: 0,
          metalDeltaUg: quantityUg,
          finenessPpm: order.finenessPpm,
          occurredAt: creditedAt,
          statusLabel: "Credited to wallet",
          entityId: order._id,
          metal,
        }),
      );
    }
  }

  for (const sell of sellMetalRows) {
    const metal = String(sell.metal ?? "GOLD");
    const quantityUg = Number(sell.quantityUg ?? 0);
    if (quantityUg <= 0) continue;
    items.push(
      activityRow({
        id: `dm_sell_metal_${sell._id}`,
        kind: "DIGITAL_METALS_SELL_METAL",
        direction: "OUT",
        lineType: "METAL",
        title: "Sold from wallet",
        subtitle: `${metal.toLowerCase()} sale`,
        amountPaise: 0,
        metalDeltaUg: -quantityUg,
        finenessPpm: sell.finenessPpm,
        occurredAt: sell.executedAt ?? sell.updatedAt ?? sell.createdAt,
        statusLabel: "Metal debited",
        entityId: sell._id,
        metal,
      }),
    );
  }

  for (const payable of sellPayables) {
    const sell = sellMap.get(String(payable.sellOrderId));
    const metal = String(sell?.metal ?? "GOLD");
    items.push(
      activityRow({
        id: `dm_sell_cash_${payable.sellOrderId}`,
        kind: "DIGITAL_METALS_SELL",
        direction: "IN",
        lineType: "CASH",
        title: `Digital ${metal.toLowerCase()} sell`,
        subtitle: String(payable.sellOrderId ?? ""),
        amountPaise: payable.amountPaise ?? sell?.settlementPaise ?? 0,
        occurredAt: payable.settledAt ?? sell?.executedAt ?? sell?.updatedAt,
        statusLabel: payable.settlementMethod === "CASH" ? "Paid in cash" : "Paid to bank",
        entityId: payable.sellOrderId,
        metal,
      }),
    );
  }

  for (const order of redeemRows) {
    const metal = String(order.metal ?? "GOLD");
    const quantityUg = Number(order.quantityUg ?? 0);
    const chargePaise = Number(order.chargeTotalPaise ?? 0);
    if (chargePaise > 0) {
      items.push(
        activityRow({
          id: `dm_redeem_charge_${order._id}`,
          kind: "DIGITAL_METALS_REDEMPTION",
          direction: "OUT",
          lineType: "CASH",
          title: "Redemption charges",
          subtitle: order.orderNumber ? String(order.orderNumber) : undefined,
          amountPaise: chargePaise,
          occurredAt: order.chargePaidAt ?? order.updatedAt ?? order.createdAt,
          statusLabel: "Charge paid",
          entityId: order._id,
          metal,
        }),
      );
    }
    if (quantityUg > 0) {
      items.push(
        activityRow({
          id: `dm_redeem_metal_${order._id}`,
          kind: "DIGITAL_METALS_REDEMPTION_METAL",
          direction: "OUT",
          lineType: "METAL",
          title: "Physical redemption",
          subtitle: order.orderNumber ? String(order.orderNumber) : undefined,
          amountPaise: 0,
          metalDeltaUg: -quantityUg,
          finenessPpm: order.finenessPpm,
          occurredAt: order.chargePaidAt ?? order.updatedAt ?? order.createdAt,
          statusLabel: String(order.status ?? "").replace(/_/g, " "),
          entityId: order._id,
          metal,
        }),
      );
    }
  }

  items.sort(compareActivityDesc);
  return items;
}

export async function listCustomerActivityPaginated(auth, { cursor, limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const parsedCursor = parseActivityCursor(cursor);
  const perSource = Math.min(Math.max(safeLimit * 8, 40), 200);
  const candidates = await collectActivityCandidates(auth, { perSource });
  const filtered = candidates.filter((item) => isBeforeActivityCursor(item, parsedCursor));
  const page = filtered.slice(0, safeLimit + 1);
  const hasMore = page.length > safeLimit;
  const items = hasMore ? page.slice(0, safeLimit) : page;
  const last = items.at(-1);
  return {
    items,
    meta: {
      limit: safeLimit,
      count: items.length,
      hasMore,
      nextCursor: hasMore && last ? encodeActivityCursor(last) : null,
    },
  };
}

/** Home hero strip (newest N across products). */
export async function buildRecentActivityForHome(auth, limit = 8) {
  const { items } = await listCustomerActivityPaginated(auth, { limit });
  return items;
}
