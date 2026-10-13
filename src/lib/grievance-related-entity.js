import { GrievanceRelatedEntityType } from "../constants/enums.js";
import { errors } from "./app-error.js";
import {
  EcommerceOrder,
  Payment,
  Redemption,
  Scheme,
} from "../models/index.js";

export async function assertGrievanceRelatedEntityForCustomer(req, relatedEntity, session) {
  if (!relatedEntity?.type || !relatedEntity?.id) return;
  const tenantId = req.auth.tenantId;
  const customerId = req.auth.id;
  const id = String(relatedEntity.id).trim();
  const type = relatedEntity.type;

  if (type === GrievanceRelatedEntityType.ORDER) {
    const order = await EcommerceOrder.findOne({ _id: id, tenantId, customerId })
      .session(session ?? null)
      .select("_id orderNumber")
      .lean();
    if (!order) {
      throw errors.business("GRIEVANCE_RELATED_ENTITY_INVALID", "Order not found for this customer.");
    }
    return { type, id: order._id, label: order.orderNumber };
  }
  if (type === GrievanceRelatedEntityType.SCHEME) {
    const scheme = await Scheme.findOne({ _id: id, tenantId, customerId })
      .session(session ?? null)
      .select("_id enrollmentNumber")
      .lean();
    if (!scheme) throw errors.business("GRIEVANCE_RELATED_ENTITY_INVALID", "Scheme not found for this customer.");
    return { type, id: scheme._id, label: scheme.enrollmentNumber };
  }
  if (type === GrievanceRelatedEntityType.PAYMENT) {
    const payment = await Payment.findOne({ _id: id, tenantId, customerId })
      .session(session ?? null)
      .select("_id receiptNumber")
      .lean();
    if (!payment) throw errors.business("GRIEVANCE_RELATED_ENTITY_INVALID", "Payment not found for this customer.");
    return { type, id: payment._id, label: payment.receiptNumber };
  }
  if (type === GrievanceRelatedEntityType.REDEMPTION) {
    const redemption = await Redemption.findOne({ _id: id, tenantId })
      .session(session ?? null)
      .select("_id schemeId")
      .lean();
    if (!redemption) {
      throw errors.business("GRIEVANCE_RELATED_ENTITY_INVALID", "Redemption not found.");
    }
    const scheme = await Scheme.findOne({ _id: redemption.schemeId, tenantId, customerId })
      .session(session ?? null)
      .select("_id")
      .lean();
    if (!scheme) {
      throw errors.business("GRIEVANCE_RELATED_ENTITY_INVALID", "Redemption not found for this customer.");
    }
    return { type, id: redemption._id, label: redemption._id };
  }
  throw errors.business("GRIEVANCE_RELATED_ENTITY_INVALID", "Unsupported related entity type.");
}

/** Admin/customer detail: human label + portal path for linked records. */
export async function presentGrievanceRelatedEntity(tenantId, relatedEntity) {
  if (!relatedEntity?.type || !relatedEntity?.id) return null;
  const type = relatedEntity.type;
  const id = String(relatedEntity.id).trim();

  if (type === GrievanceRelatedEntityType.ORDER) {
    const order = await EcommerceOrder.findOne({ _id: id, tenantId })
      .select("orderNumber")
      .lean();
    const label = order?.orderNumber ? `Order ${order.orderNumber}` : `Order ${id}`;
    return { type, id, displayLabel: label, path: `/ecommerce/orders/${id}` };
  }
  if (type === GrievanceRelatedEntityType.SCHEME) {
    const scheme = await Scheme.findOne({ _id: id, tenantId }).select("enrollmentNumber").lean();
    const label = scheme?.enrollmentNumber ? `Scheme ${scheme.enrollmentNumber}` : `Scheme ${id}`;
    return { type, id, displayLabel: label, path: `/schemes/${id}` };
  }
  if (type === GrievanceRelatedEntityType.PAYMENT) {
    const payment = await Payment.findOne({ _id: id, tenantId }).select("receiptNumber").lean();
    const label = payment?.receiptNumber ? `Receipt ${payment.receiptNumber}` : `Payment ${id}`;
    return { type, id, displayLabel: label, path: `/payments/${id}` };
  }
  if (type === GrievanceRelatedEntityType.REDEMPTION) {
    return { type, id, displayLabel: `Redemption ${id}`, path: `/maturity?redemption=${id}` };
  }
  return { type, id, displayLabel: id, path: null };
}
