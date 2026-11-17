import { SubscriptionPlan } from "../models/index.js";

/** Loaded once per request/settings read; not persisted on the tenant document. */
export const SUBSCRIPTION_CATALOG_PLAN_KEY = "_subscriptionCatalogPlan";

const PLAN_CACHE_MS = 60_000;
const planCache = new Map();

function cachedPlan(key) {
  const hit = planCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    planCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function rememberPlan(key, value) {
  planCache.set(key, { value, expiresAt: Date.now() + PLAN_CACHE_MS });
  return value;
}

export async function resolveSubscriptionPlanForTenant(tenant) {
  const sub = tenant?.subscription ?? {};
  if (sub.planId) {
    const key = `id:${sub.planId}`;
    const hit = cachedPlan(key);
    if (hit !== undefined) return hit;
    const byId = await SubscriptionPlan.findById(sub.planId).lean();
    if (byId && byId.active !== false) return rememberPlan(key, byId);
  }
  const tier = sub.tier;
  if (!tier) return null;
  const key = `tier:${tier}`;
  const hit = cachedPlan(key);
  if (hit !== undefined) return hit;
  const byTier = await SubscriptionPlan.findOne({ tier, active: { $ne: false } })
    .sort({ sortOrder: 1, pricePaise: 1 })
    .lean();
  return rememberPlan(key, byTier);
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
