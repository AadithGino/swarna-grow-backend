import { ROLE_SCOPE } from "../constants/permissions.js";
import { errors } from "./app-error.js";
import { EcommerceBooking } from "../models/index.js";

/**
 * Branch scope for staff access to bookings. A booking belongs to its pickup branch, which is fixed
 * when the booking is created, so the scope is a plain match on `pickupBranchId`. Tenant-wide roles
 * see every branch; branch roles see only their own. The branch comes from the verified token
 * (or the owner-only acting-branch header resolved by tenantScope), never from the request body or
 * query.
 */

/** `{ branchId: null }` for a tenant-wide role, `{ branchId }` for a branch role. */
export function bookingStaffScope(req) {
  if (req.auth?.type !== "TENANT_USER" || !req.auth?.tenantId) throw errors.forbidden();
  const roleScope = ROLE_SCOPE[req.auth.role] ?? "BRANCH";
  if (roleScope === "TENANT") return { branchId: null };
  const branchId = req.scope?.branchId ?? req.auth.branchId ?? null;
  if (!branchId) throw errors.forbidden("Branch scope is required for this role.");
  return { branchId: String(branchId) };
}

/** Mongo condition for a staff scope; empty for tenant-wide roles. */
export const bookingBranchCondition = (branchId) => (branchId ? { pickupBranchId: String(branchId) } : {});

/**
 * Load one booking the caller may act on. A booking in another branch is reported as not found, so
 * a branch user cannot tell it exists.
 */
export async function loadBookingInScope({ tenantId, bookingId, branchId = null, session = null, select = null }) {
  const query = EcommerceBooking.findOne({ _id: bookingId, tenantId, ...bookingBranchCondition(branchId) });
  if (select) query.select(select);
  if (session) query.session(session);
  const row = await query.lean();
  if (!row) throw errors.notFound("Booking");
  return row;
}

/** The pickup branch of a booking, for stamping alerts so they reach the right branch. */
export async function bookingBranchOf({ tenantId, bookingId, session = null }) {
  const query = EcommerceBooking.findOne({ _id: bookingId, tenantId }).select("pickupBranchId");
  if (session) query.session(session);
  const row = await query.lean();
  return row?.pickupBranchId ?? null;
}
