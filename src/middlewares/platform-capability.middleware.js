import { assertPlatformCapability } from "../lib/feature-entitlements.js";

export function requirePlatformCapability(capabilityKey) {
  return (req, _res, next) => {
    try {
      assertPlatformCapability(req.tenant, capabilityKey);
      next();
    } catch (error) {
      next(error);
    }
  };
}
