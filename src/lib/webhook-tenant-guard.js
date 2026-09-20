import { TenantStatus } from "../constants/enums.js";
import { AppError } from "../lib/app-error.js";
import { Tenant } from "../models/index.js";

/** Reject webhooks for missing or non-active tenants before persisting failures or queueing. */
export async function assertWebhookTenantReceivable(tenantId) {
  const tenant = await Tenant.findById(tenantId).select("status code").lean();
  if (!tenant) {
    throw new AppError("TENANT_NOT_FOUND", "Unknown tenant.", 404);
  }
  if (tenant.status !== TenantStatus.ACTIVE) {
    throw new AppError("TENANT_NOT_ACTIVE", "Tenant is not active.", 403);
  }
  return tenant;
}
