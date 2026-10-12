import { Tenant } from "../models/index.js";
import {
  attachSubscriptionCatalogPlan,
  subscriptionCatalogPlanFromTenant,
} from "./subscription-plan-for-tenant.js";

/**
 * Tenant document for checkout capability — keeps request-scoped catalog plan attachment
 * while loading integrationSecrets when needed for gateway checks.
 */
export async function tenantForEcommerceCheckout(tenantId, tenantFromRequest) {
  if (!tenantFromRequest) {
    const raw = await Tenant.findById(tenantId).select("+integrationSecrets").lean();
    return raw ? attachSubscriptionCatalogPlan(raw) : null;
  }
  let tenant = tenantFromRequest;
  if (tenant.integrationSecrets == null) {
    const secretsRow = await Tenant.findById(tenantId).select("+integrationSecrets").lean();
    if (secretsRow?.integrationSecrets != null) {
      tenant = { ...tenant, integrationSecrets: secretsRow.integrationSecrets };
    }
  }
  if (!subscriptionCatalogPlanFromTenant(tenant)) {
    tenant = await attachSubscriptionCatalogPlan(tenant);
  }
  return tenant;
}
