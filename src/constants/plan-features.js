import { PlanTier } from "./enums.js";

/** Default boolean feature map per subscription tier (v1.2 contract). */
export const DEFAULT_PLAN_FEATURES = Object.freeze({
  [PlanTier.STARTER]: {
    multiBranch: false,
    customApp: false,
    flexibleScheme: false,
    goldWeightScheme: true,
    prematureRedemption: true,
    customerSelfEnrol: false,
    advancedReports: false,
    ecommerce: false,
  },
  [PlanTier.GROWTH]: {
    multiBranch: true,
    customApp: false,
    flexibleScheme: true,
    goldWeightScheme: true,
    prematureRedemption: true,
    customerSelfEnrol: true,
    advancedReports: false,
    ecommerce: false,
  },
  [PlanTier.PRO]: {
    multiBranch: true,
    customApp: true,
    flexibleScheme: true,
    goldWeightScheme: true,
    prematureRedemption: true,
    customerSelfEnrol: true,
    advancedReports: true,
    ecommerce: false,
  },
  [PlanTier.CUSTOM]: {
    multiBranch: true,
    customApp: true,
    flexibleScheme: true,
    goldWeightScheme: true,
    prematureRedemption: true,
    customerSelfEnrol: true,
    advancedReports: true,
    ecommerce: false,
  },
});

export function normalizePlanFeatures(raw, tier) {
  if (raw && !Array.isArray(raw) && typeof raw === "object") return { ...DEFAULT_PLAN_FEATURES[tier], ...raw };
  return { ...(DEFAULT_PLAN_FEATURES[tier] ?? DEFAULT_PLAN_FEATURES[PlanTier.STARTER]) };
}

/** Map API limit keys to persisted tenant/plan limit keys. */
export function limitsFromApi(apiLimits = {}) {
  if (!apiLimits || typeof apiLimits !== "object") return {};
  const out = { ...apiLimits };
  if (out.staffSeats != null) { out.staff = out.staffSeats; delete out.staffSeats; }
  if (out.whatsappMessagesPerMonth != null) { out.whatsappMessages = out.whatsappMessagesPerMonth; delete out.whatsappMessagesPerMonth; }
  return out;
}

export function limitsToApi(stored = {}) {
  const src = stored?.toObject?.() ?? stored ?? {};
  return {
    activeCustomers: src.activeCustomers ?? null,
    branches: src.branches ?? null,
    staffSeats: src.staffSeats ?? src.staff ?? null,
    schemePlans: src.schemePlans ?? null,
    whatsappMessagesPerMonth: src.whatsappMessagesPerMonth ?? src.whatsappMessages ?? null,
    storageMb: src.storageMb ?? null,
  };
}
