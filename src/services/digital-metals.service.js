import { Permission, ROLE_SCOPE } from "../constants/permissions.js";
import { AppError, errors } from "../lib/app-error.js";
import { enrichCapabilityDto } from "../lib/digital-metals-capability-build.js";
import {
  assertCanEnableDigitalMetalsModule,
  customerDigitalMetalLegacyContext,
  presentDigitalMetalsAccessStateForTenant,
} from "../lib/digital-metals-access.js";
import {
  latestEffectiveRate,
  latestSettings,
  loadNextFutureRate,
} from "./digital-metals-phase2.service.js";
function scopeFromReq(req) {
  const roleScope = ROLE_SCOPE[req.auth?.role] ?? "BRANCH";
  return {
    roleScope,
    branchId: req.scope?.branchId ?? req.auth?.branchId ?? null,
  };
}

async function capabilityLoaders() {
  return {
    loadSettings: (tenantId, metal, finenessPpm) => latestSettings(tenantId, metal, finenessPpm),
    loadEffectiveRate: (tenantId, metal, finenessPpm) => latestEffectiveRate(tenantId, metal, finenessPpm),
    loadNextFutureRate: (tenantId, metal, finenessPpm) => loadNextFutureRate(tenantId, metal, finenessPpm),
  };
}

export async function getAdminDigitalMetalsCapability(req) {
  const access = await presentDigitalMetalsAccessStateForTenant(req.tenant);
  const capability = await enrichCapabilityDto(
    req.tenant,
    { hasLegacyActivity: access.hasLegacyActivity, scope: scopeFromReq(req) },
    await capabilityLoaders(),
  );
  return {
    ...capability,
    permissions: {
      read: req.auth?.permissions?.includes("*")
        || req.auth?.permissions?.includes(Permission.DIGITAL_METALS_READ),
    },
  };
}

export async function getAdminDigitalMetalsWorkspace(req) {
  const capability = await getAdminDigitalMetalsCapability(req);
  return {
    phase: 3,
    workspaceLive: capability.workspaceLive,
    title: "Digital Gold & Silver",
    message: capability.enabled
      ? "Workspace shell is enabled. Trading, wallets, and reports arrive in later phases."
      : "Enable Digital Gold & Silver in Settings → Operations after your plan includes this module.",
    capability,
  };
}

export async function getCustomerDigitalMetalsCapability(req) {
  const access = await presentDigitalMetalsAccessStateForTenant(req.tenant);
  const legacy = await customerDigitalMetalLegacyContext(req.auth.tenantId, req.auth.id);
  return enrichCapabilityDto(
    req.tenant,
    {
      ...legacy,
      customerId: req.auth.id,
      hasLegacyActivity: legacy.hasLegacyAccess || access.hasLegacyActivity,
      scope: { roleScope: "CUSTOMER", branchId: req.auth?.branchId ?? null },
    },
    await capabilityLoaders(),
  );
}

export function assertTenantOwnsCustomerScope(req, customerRow) {
  if (!customerRow || String(customerRow.tenantId) !== String(req.auth.tenantId)) {
    throw errors.notFound("Customer");
  }
  const roleScope = ROLE_SCOPE[req.auth?.role] ?? "BRANCH";
  if (roleScope === "BRANCH") {
    const scopeBranch = req.scope?.branchId ?? req.auth?.branchId;
    if (scopeBranch && customerRow.branchId && String(customerRow.branchId) !== String(scopeBranch)) {
      throw new AppError("FORBIDDEN", "Customer is outside your branch scope.", 403);
    }
  }
}

export { assertCanEnableDigitalMetalsModule };
