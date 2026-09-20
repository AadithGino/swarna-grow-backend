import { env } from "../config/env.js";
import { TenantStatus } from "../constants/enums.js";
import { Tenant } from "../models/index.js";

/**
 * Live tenants with PhonePe credentials must use PRODUCTION environment (not sandbox).
 */
export function findSandboxPhonePeLiveTenants(tenants, platformPhonePeEnv) {
  const offenders = [];
  for (const tenant of tenants) {
    const phonepe = tenant.integrationSecrets?.phonepe;
    if (!phonepe?.clientId) continue;
    const environment = phonepe.environment ?? platformPhonePeEnv;
    if (environment !== "PRODUCTION") offenders.push(tenant.code ?? tenant._id);
  }
  return offenders;
}

export async function assertProductionTenantPhonePe() {
  if (env.NODE_ENV !== "production") return;
  const tenants = await Tenant.find({
    status: TenantStatus.ACTIVE,
    goLiveAt: { $ne: null },
  })
    .select({ code: 1, integrationSecrets: 1 })
    .lean();
  const offenders = findSandboxPhonePeLiveTenants(tenants, env.PHONEPE_ENV);
  if (offenders.length) {
    throw new Error(
      `Production boot blocked: live tenant(s) use sandbox PhonePe: ${offenders.join(", ")}`,
    );
  }
}
