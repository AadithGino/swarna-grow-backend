import { AppError } from "../lib/app-error.js";
import { buildDigitalMetalsCapability } from "../lib/digital-metals-capability.js";
import {
  customerDigitalMetalLegacyContext,
  presentDigitalMetalsAccessStateForTenant,
} from "../lib/digital-metals-access.js";
import { ROLE_SCOPE } from "../constants/permissions.js";

async function capabilityForReq(req) {
  const access = await presentDigitalMetalsAccessStateForTenant(req.tenant);
  let legacy = {
    hasHoldings: false,
    hasOpenSettlement: false,
    hasOpenFulfilment: false,
    hasLegacyActivity: access.hasLegacyActivity,
  };
  if (req.auth?.subject === "CUSTOMER" && req.auth?.id) {
    legacy = await customerDigitalMetalLegacyContext(req.auth.tenantId, req.auth.id);
    legacy.hasLegacyActivity = legacy.hasLegacyAccess || access.hasLegacyActivity;
  }
  const roleScope = ROLE_SCOPE[req.auth?.role] ?? "BRANCH";
  return buildDigitalMetalsCapability(req.tenant, {
    ...legacy,
    scope: { roleScope, branchId: req.scope?.branchId ?? req.auth?.branchId ?? null },
  });
}

/** Require a boolean flag on the server capability DTO (fail closed). */
export function requireDigitalMetalsCapability(flagKey) {
  return async (req, res, next) => {
    try {
      const capability = await capabilityForReq(req);
      req.digitalMetalsCapability = capability;
      if (capability[flagKey] !== true) {
        const primary = capability.blockers?.[0];
        throw new AppError(
          primary?.code ?? "DIGITAL_METALS_DISABLED",
          primary?.message ?? "Digital metals operation is not available.",
          403,
          { capability },
        );
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export async function attachDigitalMetalsCapability(req, res, next) {
  try {
    req.digitalMetalsCapability = await capabilityForReq(req);
    next();
  } catch (error) {
    next(error);
  }
}
