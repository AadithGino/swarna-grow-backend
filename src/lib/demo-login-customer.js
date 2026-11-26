import { Customer, Scheme, Tenant } from "../models/index.js";

const ACTIVE_SCHEME_STATUSES = ["PENDING_PAYMENT", "ACTIVE", "LOCKED", "DEFAULTED", "MATURED"];

/** Demo share links: which sample customer to sign in as (FLEXI showcase when configured). */
export async function resolveDemoLoginCustomer(tenantId) {
  const tenant = await Tenant.findById(tenantId)
    .select("demoEntryCustomerId demoEntrySchemeId demoEntryPlanId")
    .lean();
  const preferredCustomerId = tenant?.demoEntryCustomerId;
  if (preferredCustomerId) {
    const preferred = await Customer.findOne({
      _id: preferredCustomerId,
      tenantId,
      isDemo: true,
    }).lean();
    if (preferred) return preferred;
  }

  const preferredSchemeId = tenant?.demoEntrySchemeId;
  if (preferredSchemeId) {
    const scheme = await Scheme.findOne({
      _id: preferredSchemeId,
      tenantId,
      status: { $in: ACTIVE_SCHEME_STATUSES },
    }).lean();
    if (scheme) {
      const customer = await Customer.findOne({
        _id: scheme.customerId,
        tenantId,
        isDemo: true,
      }).lean();
      if (customer) return customer;
    }
  }

  const flexShowcase = await Scheme.findOne({
    tenantId,
    paymentPattern: "FLEXIBLE",
    status: { $in: ["ACTIVE", "LOCKED"] },
    "planSnapshot.code": "FLEXI11",
  })
    .sort({ updatedAt: -1 })
    .select("customerId")
    .lean();
  if (flexShowcase?.customerId) {
    const customer = await Customer.findOne({
      _id: flexShowcase.customerId,
      tenantId,
      isDemo: true,
    }).lean();
    if (customer) return customer;
  }

  return Customer.findOne({ tenantId, isDemo: true }).sort({ createdAt: 1 }).lean();
}

export function demoEntryPathsFromTenantBranding(tenant) {
  return {
    entrySchemeId: tenant?.demoEntrySchemeId ?? null,
    entryPlanId: tenant?.demoEntryPlanId ?? null,
  };
}