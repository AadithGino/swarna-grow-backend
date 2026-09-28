import dayjs from "dayjs";
import { PlanTier, TenantStatus } from "../constants/enums.js";
import { DEFAULT_PLAN_FEATURES, limitsToApi, normalizePlanFeatures } from "../constants/plan-features.js";
import { normalizeSupportedBillingCycles } from "./subscription-provision.js";
import { moneyRef } from "./money.js";

export function mapPlanId(plan) {
  return plan._id;
}

export function mapPublicSubscriptionPlan(plan, { tenantCount } = {}) {
  const tier = plan.tier;
  const monthlyPaise = plan.monthlyPricePaise ?? plan.pricePaise ?? 0;
  const features = normalizePlanFeatures(plan.features, tier);
  const limits = limitsToApi(plan.limits);
  const billingCycle = plan.billingCycle ?? "MONTHLY";
  const row = {
    id: mapPlanId(plan),
    tier,
    name: plan.name ?? tier,
    displayName: plan.displayName ?? plan.name ?? tier,
    limits,
    features,
    highlighted: Boolean(plan.highlighted),
    sortOrder: plan.sortOrder ?? 0,
    trialDays: plan.trialDays ?? 0,
    status: plan.active === false ? "DEPRECATED" : "ACTIVE",
    version: plan.version ?? 1,
    tenantCount: tenantCount ?? 0,
    supportedBillingCycles: normalizeSupportedBillingCycles(plan, billingCycle),
    displayFeatures: plan.displayFeatures ?? [],
  };
  if (tier === PlanTier.CUSTOM && !monthlyPaise) {
    row.monthlyPrice = { amountPaise: 0, amountDisplay: plan.priceLabel ?? "Contact Us" };
    row.yearlyPrice = { amountPaise: 0, amountDisplay: plan.priceLabel ?? "Contact Us" };
    row.priceLabel = plan.priceLabel ?? "Contact Us";
  } else {
    row.monthlyPrice = moneyRef(monthlyPaise);
    row.yearlyPrice = plan.yearlyPricePaise ? moneyRef(plan.yearlyPricePaise) : moneyRef(monthlyPaise * 12);
  }
  return row;
}

export function maskSecret(value, visible = 4) {
  if (!value || typeof value !== "string") return null;
  const tail = value.slice(-visible);
  return `${value.slice(0, Math.min(4, value.length)).replace(/./g, "•")}••••${tail}`;
}

export function usagePercent(used, limit) {
  if (limit == null || limit <= 0) return null;
  return Math.round((used / limit) * 1000) / 10;
}

export function signupStageFromStatus(status, paymentProcessing = false) {
  if (paymentProcessing) return "PAYMENT_PROCESSING";
  const map = {
    OTP_PENDING: "OTP_PENDING",
    OTP_VERIFIED: "PLAN_PENDING",
    PLAN_SELECTED: "PAYMENT_PENDING",
    PAYMENT_PENDING: "PAYMENT_PENDING",
    PROVISIONED: "COMPLETED",
    EXPIRED: "FAILED",
  };
  return map[status] ?? status;
}

export function deriveTenantCodeFromName(businessName) {
  const base = String(businessName ?? "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 12);
  return base || "JEWELLER";
}

export function subscriptionSummaryForTenant(tenant) {
  const sub = tenant.subscription ?? {};
  const end = sub.renewsAt ?? sub.trialEndsAt;
  const daysRemaining = end ? Math.max(0, dayjs(end).startOf("day").diff(dayjs().startOf("day"), "day")) : null;
  return {
    tier: sub.tier,
    status: sub.status,
    billingCycle: sub.billingCycle ?? "MONTHLY",
    currentPeriodEnd: end ? dayjs(end).format("YYYY-MM-DD") : null,
    daysRemaining,
  };
}

export function tenantListRow(tenant, extras = {}) {
  return {
    id: tenant._id,
    tenantCode: tenant.code,
    businessName: tenant.name,
    displayName: tenant.displayName ?? tenant.branding?.displayName ?? tenant.name,
    ownerName: extras.ownerName ?? null,
    ownerMobile: extras.ownerMobile ?? tenant.mobile,
    ownerEmail: extras.ownerEmail ?? tenant.email ?? null,
    city: tenant.address?.city ?? extras.city ?? null,
    status: tenant.status,
    subscription: subscriptionSummaryForTenant(tenant),
    provisioning: extras.provisioning ?? {
      whatsappConfigured: false,
      paymentGatewayConfigured: false,
      templatesConfigured: 0,
      templatesRequired: 0,
      readyToGoLive: false,
    },
    usage: extras.usage ?? {},
    createdAt: tenant.createdAt,
  };
}

export function chartSeries({ chartType, title, yAxis, series, summary }) {
  return {
    chartType,
    title,
    xAxis: { type: "category", label: "Period" },
    yAxis,
    series,
    ...(summary ? { summary } : {}),
  };
}

export function defaultPlanFeaturesForTier(tier) {
  return { ...(DEFAULT_PLAN_FEATURES[tier] ?? DEFAULT_PLAN_FEATURES[PlanTier.STARTER]) };
}

export function isSetupPendingTenant(tenant) {
  return tenant.status === TenantStatus.PENDING_SETUP;
}

export function mapPublicPlans(plans, { includeTenantCount = true, tenantCounts = {} } = {}) {
  return plans.map((plan) => mapPublicSubscriptionPlan(plan, includeTenantCount ? { tenantCount: tenantCounts[plan.tier] ?? 0 } : {}));
}
