import { Customer } from "../models/index.js";
import { maskMobile } from "./mobile.js";

function snapshotRecipientName(addressSnapshot) {
  if (!addressSnapshot || typeof addressSnapshot !== "object") return null;
  const name = addressSnapshot.recipientName ?? addressSnapshot.name;
  return name ? String(name).trim() || null : null;
}

function snapshotMobile(addressSnapshot) {
  if (!addressSnapshot || typeof addressSnapshot !== "object") return null;
  const mobile = addressSnapshot.mobile;
  return mobile ? String(mobile).trim() || null : null;
}

/** @param {string} tenantId @param {Array<{ customerId?: string, addressSnapshot?: unknown }>} orders */
export async function attachAdminOrderCustomerDisplay(tenantId, orders) {
  if (!orders.length) return orders;
  const customerIds = [...new Set(orders.map((o) => String(o.customerId ?? "")).filter(Boolean))];
  const customers = customerIds.length
    ? await Customer.find({ tenantId, _id: { $in: customerIds } })
        .select("_id name mobile customerNumber")
        .lean()
    : [];
  const byId = new Map(customers.map((c) => [String(c._id), c]));

  return orders.map((order) => {
    const customer = byId.get(String(order.customerId ?? ""));
    const snapName = snapshotRecipientName(order.addressSnapshot);
    const snapMobile = snapshotMobile(order.addressSnapshot);
    const mobile = customer?.mobile ?? snapMobile ?? null;
    return {
      ...order,
      customerDisplay: {
        customerId: order.customerId ?? null,
        name: customer?.name ?? snapName ?? null,
        maskedMobile: mobile ? maskMobile(mobile) : null,
        customerNumber: customer?.customerNumber ?? null,
      },
    };
  });
}
