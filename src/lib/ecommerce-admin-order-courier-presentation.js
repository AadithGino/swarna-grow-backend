import { mapHandoverForDetail } from "../services/ecommerce-order-handover.service.js";
import { EcommerceCourierCodCollectionSource } from "../constants/enums.js";

function mapCourierCodBlock(order) {
  const cc = order.courierCod ?? {};
  if (!cc?.collectionStatus || cc.collectionStatus === "NOT_APPLICABLE") return null;
  const integrationVerified =
    cc.collectionSource === EcommerceCourierCodCollectionSource.COURIER_INTEGRATION;
  return {
    providerId: cc.providerId ?? "MANUAL",
    trackingReference: cc.trackingReference ?? null,
    expectedAmountPaise: cc.expectedAmountPaise ?? order.totalPaise ?? null,
    collectionStatus: cc.collectionStatus ?? null,
    collectionConfirmedAt: cc.collectionConfirmedAt ?? null,
    collectionReference: cc.collectionReference ?? null,
    collectionSource: cc.collectionSource ?? null,
    collectionSourceLabel: integrationVerified
      ? "Courier integration (verified)"
      : cc.collectionSource === EcommerceCourierCodCollectionSource.MANUAL_OPERATOR
        ? "Manual operator entry"
        : null,
    collectionEvidenceNote: cc.collectionEvidenceNote ?? null,
    remittanceStatus: cc.remittanceStatus ?? null,
    activeRemittanceBatchId: cc.activeRemittanceBatchId ?? null,
    remittanceGrossPaise: cc.remittanceGrossPaise ?? null,
    remittanceFeePaise: cc.remittanceFeePaise ?? null,
    remittanceNetPaise: cc.remittanceNetPaise ?? null,
    bankCreditReference: cc.bankCreditReference ?? null,
    bankCreditedAt: cc.bankCreditedAt ?? null,
    reconciliationStatus: cc.reconciliationStatus ?? null,
    reconciliationDiscrepancyPaise: cc.reconciliationDiscrepancyPaise ?? null,
    courierIntegrationLive: false,
  };
}

export function attachAdminOrderCourierPresentation(mappedOrder, rawOrder) {
  return {
    ...mappedOrder,
    fulfilmentHandover: mapHandoverForDetail(rawOrder),
    courierCod: mapCourierCodBlock(rawOrder),
  };
}
