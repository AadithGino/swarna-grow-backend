import { tenantCodeToCustomerSlug } from "./digital-metals-customer-notice.js";

/** Paths match `customer-router.tsx` (`id` / `extra` segments under `digital-metals`). */
export function digitalMetalCustomerDeepLink(tenantCode, segments) {
  const slug = tenantCodeToCustomerSlug(tenantCode);
  const parts = Array.isArray(segments) ? segments.filter(Boolean) : [segments].filter(Boolean);
  const tail = parts.length ? `/${parts.join("/")}` : "";
  return `/customer/${slug}/digital-metals${tail}`;
}

export function deepLinkBuyOrder(tenantCode, orderId) {
  return digitalMetalCustomerDeepLink(tenantCode, ["order", orderId]);
}

export function deepLinkSellOrder(tenantCode, orderId) {
  return digitalMetalCustomerDeepLink(tenantCode, ["sell-order", orderId]);
}

export function deepLinkRedemptionOrder(tenantCode, orderId) {
  return digitalMetalCustomerDeepLink(tenantCode, ["redeem-order", orderId]);
}

export function deepLinkDocumentArtifact(tenantCode, artifactId) {
  return digitalMetalCustomerDeepLink(tenantCode, ["document", artifactId]);
}

export function deepLinkDigitalMetalsHome(tenantCode) {
  return digitalMetalCustomerDeepLink(tenantCode, []);
}
