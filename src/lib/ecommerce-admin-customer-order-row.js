import {
  EcommerceCodCollectionStatus,
  EcommerceOrderStatus,
} from "../constants/enums.js";
import { orderUsesCod } from "./ecommerce-cod.js";

function lineSummary(lines) {
  const rows = Array.isArray(lines) ? lines : [];
  if (!rows.length) return { label: "—", itemCount: 0 };
  const first = String(rows[0]?.name ?? rows[0]?.sku ?? "Item");
  const qty = rows.reduce((n, l) => n + Number(l?.quantity ?? 0), 0);
  if (rows.length === 1) {
    return { label: qty > 1 ? `${first} × ${qty}` : first, itemCount: qty };
  }
  const extra = rows.length - 1;
  return { label: `${first} + ${extra} more`, itemCount: qty };
}

function attentionState(row, refundRow) {
  if (row.activeCancellationRequestId) {
    return { kind: "CANCELLATION", label: "Cancellation in progress" };
  }
  if (row.status === EcommerceOrderStatus.REFUND_PENDING) {
    return { kind: "REFUND", label: "Refund in progress" };
  }
  if (row.status === EcommerceOrderStatus.REFUNDED) {
    return { kind: "REFUND", label: "Refunded" };
  }
  if (refundRow?.status === "FAILED") {
    return { kind: "REFUND", label: "Refund attention" };
  }
  return { kind: "NONE", label: null };
}

export function mapAdminCustomerOrderListRow(row, refundRow) {
  const cod = orderUsesCod(row);
  const codCollected =
    row.codCollection?.status === EcommerceCodCollectionStatus.COLLECTED;
  const summary = lineSummary(row.lines);
  const attention = attentionState(row, refundRow);
  return {
    id: row._id,
    orderNumber: row.orderNumber,
    createdAt: row.createdAt ?? null,
    itemSummary: summary.label,
    itemCount: summary.itemCount,
    totalPaise: row.totalPaise ?? 0,
    paymentMethod: row.paymentMethod ?? "ONLINE",
    codCollectionStatus: cod ? row.codCollection?.status ?? EcommerceCodCollectionStatus.PENDING : null,
    paymentCollected: cod ? codCollected : row.status !== EcommerceOrderStatus.PENDING_PAYMENT
      && row.status !== EcommerceOrderStatus.PAYMENT_FAILED
      && row.status !== EcommerceOrderStatus.PAYMENT_EXPIRED,
    fulfilmentMode: row.fulfilmentMode ?? null,
    status: row.status,
    attentionKind: attention.kind,
    attentionLabel: attention.label,
    detailPath: `/ecommerce/orders/${row._id}`,
  };
}

export function summarizeEcommerceCustomerOrderMoney(rows, refundByOrderId) {
  let grossCollectedPaise = 0;
  let refundOutflowPaise = 0;
  for (const row of rows) {
    const cod = orderUsesCod(row);
    const collected = cod
      ? row.codCollection?.status === EcommerceCodCollectionStatus.COLLECTED
      : Boolean(row.paidAt);
    if (collected) grossCollectedPaise += row.totalPaise ?? 0;
    const refund = refundByOrderId.get(row._id);
    if (refund && (refund.status === "SUCCEEDED" || refund.status === "MANUAL_RECORDED")) {
      refundOutflowPaise += refund.amountPaise ?? row.totalPaise ?? 0;
    }
  }
  return {
    orderCount: rows.length,
    grossCollectedPaise,
    refundOutflowPaise,
    netCollectedPaise: grossCollectedPaise - refundOutflowPaise,
    label: "Ecommerce order totals (not scheme savings or gold holdings)",
  };
}
