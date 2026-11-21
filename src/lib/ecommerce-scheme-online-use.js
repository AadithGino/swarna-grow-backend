import { EcommerceSchemeReservation } from "../models/ecommerce-scheme-reservation.model.js";

/** An online allocation that still holds part of the scheme's value (held, or consumed and not fully restored). */
const STILL_ALLOCATED = {
  status: { $in: ["HELD", "CONSUMED"] },
  $expr: { $gt: ["$units", { $ifNull: ["$restoredUnits", 0] }] },
};

const within = (query, session) => (session ? query.session(session) : query);

/**
 * Whether this scheme's value is already tied up in online checkout. Such a scheme can only be spent
 * through online checkout (standalone redemption refuses it), so it must stay spendable there even
 * when the jeweller switches scheme checkout off for new schemes.
 */
export function schemeHasOnlineAllocation({ tenantId, schemeId, session }) {
  return within(EcommerceSchemeReservation.exists({ tenantId, schemeId, ...STILL_ALLOCATED }), session);
}

/** The same question for any of a customer's schemes. */
export function customerHasOnlineSchemeAllocation({ tenantId, customerId, session }) {
  return within(EcommerceSchemeReservation.exists({ tenantId, customerId, ...STILL_ALLOCATED }), session);
}
