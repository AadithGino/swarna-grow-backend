import { errors } from "./app-error.js";
import { EcommerceCustomerAddress } from "../models/ecommerce-commerce.models.js";

export function mapCustomerDeliveryAddress(row) {
  return {
    id: row._id,
    label: row.label ?? "Home",
    recipientName: row.recipientName ?? "",
    mobile: row.mobile ?? "",
    line1: row.line1,
    line2: row.line2 ?? "",
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    isDefault: row.isDefault === true,
    version: row.version ?? 1,
  };
}

/** Frozen copy stored on orders/quotes (same shape as ecommerce checkout). */
export function snapshotCustomerDeliveryAddress(row) {
  return {
    id: row._id,
    label: row.label ?? "Home",
    recipientName: row.recipientName ?? "",
    mobile: row.mobile ?? "",
    line1: row.line1,
    line2: row.line2 ?? "",
    city: row.city,
    state: row.state,
    pincode: row.pincode,
  };
}

export function formatDeliveryAddressLines(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const parts = [
    snapshot.recipientName,
    snapshot.line1,
    snapshot.line2,
    [snapshot.city, snapshot.state, snapshot.pincode].filter(Boolean).join(", "),
  ]
    .map((p) => (p == null ? "" : String(p).trim()))
    .filter(Boolean);
  return parts.join(" · ");
}

export async function loadOwnedCustomerDeliveryAddress({ tenantId, customerId, addressId, session }) {
  let query = EcommerceCustomerAddress.findOne({
    _id: addressId,
    tenantId,
    customerId,
  });
  if (session) query = query.session(session);
  const row = await query.lean();
  if (!row) throw errors.notFound("Address");
  return row;
}
