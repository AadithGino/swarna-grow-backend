import { requirePermission } from "../middlewares/auth.middleware.js";

/** Mark a route as intentionally public (no permission). Detected by check-route-coverage. */
export const PUBLIC = "PUBLIC";

/** Require a permission before the remaining handlers. */
export const guarded = (permission, ...handlers) => [requirePermission(permission), ...handlers];
