import { requireAnyPermission, requirePermission } from "../middlewares/auth.middleware.js";

/** Mark a route as intentionally public (no permission). Detected by check-route-coverage. */
export const PUBLIC = "PUBLIC";

/** Require a permission before the remaining handlers. */
export const guarded = (permission, ...handlers) => [requirePermission(permission), ...handlers];

/** Require any one of the permissions before the remaining handlers. */
export const guardedAny = (...args) => {
  const permissions = [];
  const handlers = [];
  for (const arg of args) {
    if (typeof arg === "function") handlers.push(arg);
    else if (Array.isArray(arg)) permissions.push(...arg);
    else permissions.push(arg);
  }
  return [requireAnyPermission(...permissions), ...handlers];
};
