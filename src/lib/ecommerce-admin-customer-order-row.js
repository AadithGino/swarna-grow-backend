import {
  EcommerceCourierCodCollectionStatus,
  EcommerceCourierCodRemittanceStatus,
  EcommerceOrderStatus,
} from "../constants/enums.js";
import { orderUsesCod } from "./ecommerce-cod.js";
import { isCourierCodCollectionConfirmed } from "./ecommerce-courier-cod.js";

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

function codCollectionLabel(row) {
  const cc = row.courierCod ?? {};
  if (cc.remittanceStatus === EcommerceCourierCodRemittanceStatus.BANK_RECONCILED) {
    return "BANK_RECONCILED";
  }
  if (cc.remittanceStatus === EcommerceCourierCodRemittanceStatus.DISCREPANCY) {
    return "REMITTANCE_DISCREPANCY";
  }
  if (isCourierCodCollectionConfirmed(row)) {
    return EcommerceCourierCodCollectionStatus.CONFIRMED;
  }
  return cc.collectionStatus ?? EcommerceCourierCodCollectionStatus.PENDING;
}

export function mapAdminCustomerOrderListRow(row, refundRow) {
  const cod = orderUsesCod(row);
  const codCollected = cod && isCourierCodCollectionConfirmed(row);
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
    courierCodCollectionStatus: cod ? codCollectionLabel(row) : null,
    paymentCollected: cod
      ? codCollected
      : row.status !== EcommerceOrderStatus.PENDING_PAYMENT
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
  let onlineCollectedPaise = 0;
  let codCourierConfirmedPaise = 0;
  let codBankRemittanceReconciledPaise = 0;
  let refundOutflowPaise = 0;
  for (const row of rows) {
    const cod = orderUsesCod(row);
    if (cod) {
      if (isCourierCodCollectionConfirmed(row)) {
        codCourierConfirmedPaise += row.totalPaise ?? 0;
      }
      if (row.courierCod?.remittanceStatus === EcommerceCourierCodRemittanceStatus.BANK_RECONCILED) {
        codBankRemittanceReconciledPaise += row.courierCod?.remittanceNetPaise ?? row.totalPaise ?? 0;
      }
    } else if (row.paidAt) {
      onlineCollectedPaise += row.totalPaise ?? 0;
    }
    const refund = refundByOrderId.get(row._id);
    if (refund && (refund.status === "SUCCEEDED" || refund.status === "MANUAL_RECORDED")) {
      refundOutflowPaise += refund.amountPaise ?? row.totalPaise ?? 0;
    }
  }
  const grossCollectedPaise = onlineCollectedPaise + codBankRemittanceReconciledPaise;
  return {
    orderCount: rows.length,
    onlineCollectedPaise,
    codCourierConfirmedPaise,
    codBankRemittanceReconciledPaise,
    grossCollectedPaise,
    refundOutflowPaise,
    netCollectedPaise: grossCollectedPaise - refundOutflowPaise,
    label: "Ecommerce order totals (not scheme savings or gold holdings)",
  };
}
