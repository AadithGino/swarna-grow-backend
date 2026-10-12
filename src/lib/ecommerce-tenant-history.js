import { EcommerceOrder } from "../models/index.js";

/** True when the tenant has at least one ecommerce order row (any customer). */
export async function tenantHasEcommerceOrderHistory(tenantId) {
  if (!tenantId) return false;
  const hit = await EcommerceOrder.exists({ tenantId });
  return Boolean(hit);
}

/** True when this customer has at least one ecommerce order for the tenant. */
export async function customerHasEcommerceOrderHistory(tenantId, customerId) {
  if (!tenantId || !customerId) return false;
  const hit = await EcommerceOrder.exists({ tenantId, customerId });
  return Boolean(hit);
}
