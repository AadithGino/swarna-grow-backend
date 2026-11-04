import { EcommerceCourierCodCollectionStatus } from "../constants/enums.js";
import { orderUsesCod } from "./ecommerce-cod.js";
import { isCourierCodCollectionConfirmed } from "./ecommerce-courier-cod.js";

/**
 * COD "customer paid" display derives from collection evidence only — never from SHIPPED/DELIVERED status.
 */
export function codCustomerPaymentEvidence(order) {
  if (!orderUsesCod(order)) return null;
  const cc = order.courierCod ?? {};
  if (isCourierCodCollectionConfirmed(order)) {
    return {
      collectionConfirmed: true,
      label: "Customer paid",
      evidence: "COURIER_COLLECTION_CONFIRMED",
      collectionConfirmedAt: cc.collectionConfirmedAt ?? null,
    };
  }
  if (cc.collectionStatus === EcommerceCourierCodCollectionStatus.NEEDS_REVIEW) {
    return {
      collectionConfirmed: false,
      label: "Payment being checked",
      evidence: "COURIER_COLLECTION_NEEDS_REVIEW",
      collectionConfirmedAt: null,
    };
  }
  return {
    collectionConfirmed: false,
    label: "Payment unconfirmed",
    evidence: "COURIER_COLLECTION_PENDING",
    collectionConfirmedAt: null,
  };
}
