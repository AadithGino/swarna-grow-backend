/**
 * Shared "exclude demo tenants" filter for platform reporting (plan section 11).
 *
 * Use liveTenantMatch() as a MongoDB match/filter fragment, merged into whatever other
 * filters a query already has. It is written as a backward-compatible condition —
 * { isDemo: { $ne: true } } matches documents where isDemo is false, absent, or null —
 * rather than { isDemo: false }, because every live Tenant/Customer/financial record created
 * before the Demo Builder migration lands has no isDemo field at all (plan section 4.1:
 * "Existing live records missing isDemo continue to behave as live during migration").
 * Once scripts/migrate-tenant-demo-mobile-index.mjs has backfilled isDemo: false everywhere,
 * an exact { isDemo: false } filter becomes equally correct and slightly more index-friendly
 * (a partial index can be built on it); this helper intentionally stays loose until that
 * backfill is confirmed, so switching later is a one-line change here, not a repo-wide one.
 *
 * NOT YET WIRED — this call still needs to be applied at (at least) these existing
 * aggregations once demo tenants start being created, per plan section 11:
 *   - src/services/platform.service.js: the subscription-tier breakdown aggregate, the
 *     tenants() status-count aggregate (ACTIVE/PENDING_SETUP/SUSPENDED/CANCELLED), and the
 *     platform dashboard's total Tenant.countDocuments().
 *   - Any payment/order/ledger aggregation that starts from Payment/EcommerceOrder/
 *     DigitalMetalBuyOrder etc. without going through Tenant membership first needs to join
 *     through Tenant (or filter via a shared tenantId allowlist) rather than filtering those
 *     collections directly for isDemo, per plan section 11's point that "financial
 *     aggregations that start from payments/orders must filter through trusted tenant
 *     membership, including legacy records" — those collections don't all carry isDemo
 *     themselves (see src/lib/demo-clone-registry.js for which ones will, once phase 3 lands).
 */

/** @returns {{ isDemo: { $ne: true } }} */
export function liveTenantMatch() {
  return { isDemo: { $ne: true } };
}

/**
 * Merge the live-tenant condition into an existing filter object. Does not mutate the input.
 * @param {Record<string, unknown>} [filter]
 */
export function withLiveTenantFilter(filter = {}) {
  return { ...filter, ...liveTenantMatch() };
}

/** For aggregation pipelines: a $match stage to prepend. */
export function liveTenantMatchStage() {
  return { $match: liveTenantMatch() };
}
