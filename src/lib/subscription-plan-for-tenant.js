import { SubscriptionPlan } from "../models/index.js";

/** Loaded once per request/settings read; not persisted on the tenant document. */
export const SUBSCRIPTION_CATALOG_PLAN_KEY = "_subscriptionCatalogPlan";

export async function resolveSubscriptionPlanForTenant(tenant) {
  const sub = tenant?.subscription ?? {};
  if (sub.planId) {
    const byId = await SubscriptionPlan.findById(sub.planId).lean();
    if (byId && byId.active !== false) return byId;
  }
  const tier = sub.tier;
  if (!tier) return null;
  return SubscriptionPlan.findOne({ tier, active: { $ne: false } })
    .sort({ sortOrder: 1, pricePaise: 1 })
    .lean();
}

export async function attachSubscriptionCatalogPlan(tenant) {
  if (!tenant) return tenant;
  const catalogPlan = await resolveSubscriptionPlanForTenant(tenant);
  if (!catalogPlan) return tenant;
  return { ...tenant, [SUBSCRIPTION_CATALOG_PLAN_KEY]: catalogPlan };
}

export function subscriptionCatalogPlanFromTenant(tenant) {
  return tenant?.[SUBSCRIPTION_CATALOG_PLAN_KEY] ?? null;
}
