import {
  EcommerceCodRemittanceReconciliationStatus,
  EcommerceCourierCodCollectionStatus,
  EcommerceCourierCodRemittanceStatus,
  EcommerceCodRefundFundingSource,
  EcommerceCodRefundRemittanceContext,
} from "../constants/enums.js";
import { orderUsesCod } from "./ecommerce-cod.js";

export function initialCourierCodForOrder({ totalPaise, providerId = "MANUAL" }) {
  return {
    providerId: providerId || "MANUAL",
    trackingReference: null,
    expectedAmountPaise: totalPaise,
    collectionStatus: EcommerceCourierCodCollectionStatus.PENDING,
    remittanceStatus: EcommerceCourierCodRemittanceStatus.NOT_DUE,
  };
}

export function isCourierCodCollectionConfirmed(order) {
  if (!orderUsesCod(order)) return false;
  const cc = order.courierCod ?? {};
  return cc.collectionStatus === EcommerceCourierCodCollectionStatus.CONFIRMED;
}

export function resolveCodCollectionAmountPaise(order) {
  if (!orderUsesCod(order)) return null;
  const cc = order.courierCod ?? {};
  if (cc.collectionStatus === EcommerceCourierCodCollectionStatus.CONFIRMED) {
    const expected = Number(cc.expectedAmountPaise ?? order.totalPaise);
    return Number.isInteger(expected) && expected > 0 ? expected : Number(order.totalPaise);
  }
  return null;
}

export function isCourierCodBankReconciled(order) {
  const cc = order.courierCod ?? {};
  return cc.remittanceStatus === EcommerceCourierCodRemittanceStatus.BANK_RECONCILED
    && Boolean(cc.bankCreditedAt);
}

export function deriveCodRefundRemittanceContext(order) {
  if (!isCourierCodCollectionConfirmed(order)) {
    return EcommerceCodRefundRemittanceContext.NOT_COLLECTED;
  }
  const rs = order.courierCod?.remittanceStatus;
  if (rs === EcommerceCourierCodRemittanceStatus.BANK_RECONCILED) {
    return EcommerceCodRefundRemittanceContext.COLLECTED_REMITTANCE_RECONCILED;
  }
  if (
    rs === EcommerceCourierCodRemittanceStatus.OWED
    || rs === EcommerceCourierCodRemittanceStatus.BATCH_PENDING
    || rs === EcommerceCourierCodRemittanceStatus.DISCREPANCY
  ) {
    return EcommerceCodRefundRemittanceContext.COLLECTED_REMITTANCE_PENDING;
  }
  return EcommerceCodRefundRemittanceContext.COLLECTED_REMITTANCE_UNKNOWN;
}

export function suggestCodRefundFundingSource(order) {
  const ctx = deriveCodRefundRemittanceContext(order);
  if (ctx === EcommerceCodRefundRemittanceContext.NOT_COLLECTED) {
    return EcommerceCodRefundFundingSource.NOT_FUNDED;
  }
  if (ctx === EcommerceCodRefundRemittanceContext.COLLECTED_REMITTANCE_RECONCILED) {
    return EcommerceCodRefundFundingSource.REMITTANCE_ADJUSTMENT;
  }
  if (ctx === EcommerceCodRefundRemittanceContext.COLLECTED_REMITTANCE_PENDING) {
    return EcommerceCodRefundFundingSource.UNDETERMINED;
  }
  return EcommerceCodRefundFundingSource.UNDETERMINED;
}

export function codCollectionConfirmedAtForReporting(order) {
  const cc = order.courierCod ?? {};
  if (cc.collectionStatus === EcommerceCourierCodCollectionStatus.CONFIRMED) {
    return cc.collectionConfirmedAt ?? null;
  }
  return null;
}

export function assertRemittanceLineAmounts({ grossPaise, feePaise }) {
  if (!Number.isInteger(grossPaise) || grossPaise < 1) {
    return { ok: false, field: "grossPaise", message: "grossPaise must be a positive integer." };
  }
  if (!Number.isInteger(feePaise) || feePaise < 0) {
    return { ok: false, field: "feePaise", message: "feePaise must be a non-negative integer." };
  }
  if (feePaise > grossPaise) {
    return {
      ok: false,
      field: "feePaise",
      message: "feePaise cannot exceed grossPaise.",
    };
  }
  return { ok: true, netPaise: grossPaise - feePaise };
}

export function matchRemittanceTotals({
  grossTotalPaise,
  feeTotalPaise,
  netExpectedPaise,
  bankCreditPaise,
}) {
  const expectedNet = netExpectedPaise ?? grossTotalPaise - feeTotalPaise;
  if (bankCreditPaise === expectedNet) {
    return { status: EcommerceCodRemittanceReconciliationStatus.MATCHED, discrepancyPaise: 0 };
  }
  const discrepancyPaise = bankCreditPaise - expectedNet;
  return {
    status:
      bankCreditPaise < expectedNet
        ? EcommerceCodRemittanceReconciliationStatus.SHORT
        : EcommerceCodRemittanceReconciliationStatus.OVER,
    discrepancyPaise,
  };
}
