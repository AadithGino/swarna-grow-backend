import {
  AuditEntityType,
  BillingCycle,
  CustomerLoginMode,
  CustomerStatus,
  PlanTier,
  SchemePlanStatus,
  TenantRole,
  UserStatus,
  UserType,
  UploadPurpose,
} from "../constants/enums.js";
import {
  Branch,
  Customer,
  Invoice,
  Message,
  SchemePlan,
  SubscriptionPlan,
  SubscriptionUpgradeRequest,
  Tenant,
  User,
} from "../models/index.js";
import { buildBrandingPreviewUrls } from "../lib/branding-preview.js";
import { attachSubscriptionCatalogPlan } from "../lib/subscription-plan-for-tenant.js";
import { planPriceForBillingCycle } from "../lib/subscription-provision.js";
import { resolvePlanFeatureBooleans } from "../lib/feature-entitlements.js";
import {
  assertCanEnableEcommerceStore,
  presentEcommerceAccessState,
  presentEcommerceAccessStateForTenant,
} from "../lib/ecommerce-access.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { now } from "../lib/date.js";
import { moneyRef } from "../lib/money.js";
import { withTransaction } from "../lib/transaction.js";
import { writeAudit } from "./audit.service.js";

const TIER_RANK = {
  [PlanTier.STARTER]: 0,
  [PlanTier.GROWTH]: 1,
  [PlanTier.PRO]: 2,
  [PlanTier.CUSTOM]: 3,
};

const DEFAULT_FEATURES_BY_TIER = {
  [PlanTier.STARTER]: {
    multiBranch: false,
    customApp: false,
    flexibleScheme: false,
    goldWeightScheme: true,
    prematureRedemption: false,
    customerSelfEnrol: true,
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
};

function usageMeter(used, limit) {
  const safeLimit = limit ?? 0;
  if (safeLimit <= 0) {
    return { used, limit: safeLimit, percent: 0, status: "OK" };
  }
  const percent = Math.round((used / safeLimit) * 1000) / 10;
  let status = "OK";
  if (used > safeLimit) status = "EXCEEDED";
  else if (used >= safeLimit) status = "AT_LIMIT";
  else if (percent >= 85) status = "NEAR_LIMIT";
  return { used, limit: safeLimit, percent, status };
}

function isoDate(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function daysUntil(date) {
  if (!date) return null;
  const end = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(end.getTime())) return null;
  return Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86_400_000));
}

async function loadTenant(tenantId) {
  const tenant = await Tenant.findById(tenantId).select("-integrationSecrets").lean();
  if (!tenant) throw errors.notFound("Tenant");
  return attachSubscriptionCatalogPlan(tenant);
}

async function loadTenantOwner(tenantId) {
  return User.findOne({
    tenantId,
    type: UserType.TENANT_USER,
    role: TenantRole.TENANT_OWNER,
  })
    .select("name mobile email")
    .lean();
}

async function loadHeadOfficeAddress(tenantId) {
  const branch = await Branch.findOne({ tenantId, isHeadOffice: true, active: { $ne: false } })
    .select("address")
    .lean();
  if (!branch?.address || typeof branch.address !== "object") return null;
  return {
    line1: branch.address.line1 ?? null,
    city: branch.address.city ?? null,
    state: null,
    pincode: branch.address.pincode ?? null,
  };
}

function resolveProfileAddress(tenant, hqAddress) {
  if (tenant.address && typeof tenant.address === "object") {
    return {
      line1: tenant.address.line1 ?? null,
      city: tenant.address.city ?? null,
      state: tenant.address.state ?? null,
      pincode: tenant.address.pincode ?? null,
    };
  }
  return hqAddress;
}

function presentOperations(tenant) {
  const ops = tenant.operations ?? {};
  const settings = tenant.settings ?? {};
  const multiSchemePerCustomer =
    ops.multiSchemePerCustomer ??
    settings.oneActiveSchemePerCustomer !== true;
  const kycMandatory =
    ops.kycMandatory ?? (settings.requireKycForEnrolment === true);
  const requireKycForRedemption =
    ops.requireKycForRedemption ?? (settings.requireKycForRedemption === true);
  return {
    multiSchemePerCustomer,
    kycMandatory,
    requireKycForRedemption,
    customerAppMaintenance: settings.customerAppMaintenance === true,
    kycAllowedTypes: ops.kycAllowedTypes ?? ["AADHAAR", "PAN"],
    customerSelfEnrolEnabled: ops.customerSelfEnrolEnabled ?? true,
    customerSelfRegistrationEnabled:
      ops.customerSelfRegistrationEnabled ?? true,
    customerLoginMode: ops.customerLoginMode ?? CustomerLoginMode.OTP_ONLY,
    customerAppWriteEnabled: ops.customerAppWriteEnabled ?? true,
    customerAppPaymentsEnabled:
      (ops.customerAppWriteEnabled ?? true) &&
      (ops.customerAppPaymentsEnabled ?? true),
    agentCanRegisterCustomers: ops.agentCanRegisterCustomers === true,
    agentCanEnrolSchemes: ops.agentCanEnrolSchemes === true,
    receiptPrefix: ops.receiptPrefix ?? "",
    receiptNumberFormat:
      ops.receiptNumberFormat ?? "{prefix}/{branchCode}/{year}/{seq:6}",
    passbookNumberFormat:
      ops.passbookNumberFormat ?? "{branchCode}/{year}/{seq:5}",
    schemeNumberFormat:
      ops.schemeNumberFormat ?? "{branchCode}/{planCode}/{year}/{seq:5}",
    goldPurity: ops.goldPurity ?? "22K",
    weightRoundingMode: ops.weightRoundingMode ?? "HALF_UP",
    paymentReversalWindowHours: ops.paymentReversalWindowHours ?? 48,
    redemptionApprovalRequired: ops.redemptionApprovalRequired ?? true,
    termsAndConditions: ops.termsAndConditions ?? "",
    ecommerceEnabled: ops.ecommerceEnabled === true,
    ecommerce: presentEcommerceAccessState(tenant),
    audit: { version: tenant.version ?? 1 },
  };
}

export async function getSettingsProfileForAdmin(req) {
  const tenantId = req.auth.tenantId;
  const [tenant, owner, hqAddress] = await Promise.all([
    loadTenant(tenantId),
    loadTenantOwner(tenantId),
    loadHeadOfficeAddress(tenantId),
  ]);
  return {
    businessName: tenant.name,
    displayName: tenant.displayName ?? tenant.branding?.displayName ?? tenant.name,
    ownerName: owner?.name ?? "",
    ownerMobile: owner?.mobile ?? tenant.mobile ?? "",
    ownerEmail: owner?.email ?? tenant.email ?? "",
    address: resolveProfileAddress(tenant, hqAddress),
    supportNumber: tenant.supportNumber ?? tenant.mobile ?? "",
    gstin: tenant.gstin ?? null,
    tenantCode: tenant.code,
    audit: {
      updatedAt: tenant.updatedAt ?? null,
      version: tenant.version ?? 1,
    },
  };
}

export async function getSettingsBrandingForAdmin(req) {
  const tenant = await loadTenant(req.auth.tenantId);
  const branding = tenant.branding ?? {};
  return {
    logoUrl: branding.logoUploadId
      ? (await import("./upload.service.js")).uploadViewPath(branding.logoUploadId)
      : undefined,
    primaryColor: branding.primaryColor ?? "#730321",
    secondaryColor: branding.accentColor ?? "#C9A227",
    appDisplayName: branding.displayName ?? tenant.displayName ?? tenant.name,
    previewUrls: buildBrandingPreviewUrls(tenant),
    audit: { version: tenant.version ?? 1 },
  };
}

export async function getSettingsOperationsForAdmin(req) {
  const tenant = await loadTenant(req.auth.tenantId);
  const ops = presentOperations(tenant);
  ops.ecommerce = await presentEcommerceAccessStateForTenant(tenant);
  return ops;
}

async function countTenantUsage(tenantId) {
  const monthStart = now().startOf("month").toDate();
  const [activeCustomers, branches, staffSeats, schemePlans, whatsappMessages] =
    await Promise.all([
      Customer.countDocuments({ tenantId, status: CustomerStatus.ACTIVE }),
      Branch.countDocuments({ tenantId, active: { $ne: false } }),
      User.countDocuments({
        tenantId,
        type: UserType.TENANT_USER,
        status: UserStatus.ACTIVE,
      }),
      SchemePlan.countDocuments({
        tenantId,
        status: { $in: [SchemePlanStatus.ACTIVE, SchemePlanStatus.INACTIVE] },
      }),
      Message.countDocuments({ tenantId, createdAt: { $gte: monthStart } }),
    ]);
  return {
    activeCustomers,
    branches,
    staffSeats,
    schemePlans,
    whatsappMessages,
  };
}

async function pendingUpgradeRequest(tenantId) {
  const row = await SubscriptionUpgradeRequest.findOne({
    tenantId,
    status: "PENDING_PLATFORM",
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!row) return null;
  return {
    id: row._id,
    targetTier: row.targetTier,
    billingCycle: row.billingCycle ?? BillingCycle.MONTHLY,
    note: row.note ?? null,
    status: row.status,
    requestedAt: row.createdAt ?? null,
  };
}

export async function getSubscriptionForAdmin(req) {
  const tenantId = req.auth.tenantId;
  const tenant = await loadTenant(tenantId);
  const sub = tenant.subscription ?? {};
  const tier = sub.tier ?? PlanTier.STARTER;
  const billingCycle = sub.billingCycle ?? BillingCycle.MONTHLY;
  const planDoc = sub.planId
    ? await SubscriptionPlan.findById(sub.planId).lean()
    : await SubscriptionPlan.findOne({
      tier,
      billingCycle,
      active: true,
    }).lean();
  const limits = sub.limits ?? planDoc?.limits ?? {};
  const usageCounts = await countTenantUsage(tenantId);
  const renewsAt = sub.renewsAt ?? sub.trialEndsAt ?? null;
  const periodEnd = isoDate(renewsAt);
  const periodStart = periodEnd
    ? isoDate(now().subtract(1, "month").toDate())
    : isoDate(sub.startsAt);

  const cyclePricePaise = planPriceForBillingCycle(planDoc, billingCycle);
  return {
    currentPlan: {
      tier,
      name: planDoc?.name ?? tier,
      planId: planDoc?._id ?? sub.planId ?? null,
      monthlyPrice: moneyRef(planDoc?.monthlyPricePaise ?? planDoc?.pricePaise ?? 0),
      yearlyPrice: moneyRef(planDoc?.yearlyPricePaise ?? 0),
      billingCycle,
      cyclePrice: moneyRef(cyclePricePaise),
    },
    status: sub.status ?? "ACTIVE",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    daysRemaining: daysUntil(renewsAt) ?? 0,
    renewsAutomatically: Boolean(sub.renewsAutomatically),
    usage: {
      activeCustomers: usageMeter(
        usageCounts.activeCustomers,
        limits.activeCustomers,
      ),
      branches: usageMeter(usageCounts.branches, limits.branches),
      staffSeats: usageMeter(usageCounts.staffSeats, limits.staff),
      schemePlans: usageMeter(usageCounts.schemePlans, limits.schemePlans),
      whatsappMessages: {
        ...usageMeter(usageCounts.whatsappMessages, limits.whatsappMessages),
        resetsOn: now().add(1, "month").startOf("month").format("YYYY-MM-DD"),
      },
    },
    features: resolvePlanFeatureBooleans(tenant),
    ecommerce: await presentEcommerceAccessStateForTenant(tenant),
    pendingUpgradeRequest: await pendingUpgradeRequest(tenantId),
  };
}

export async function getSubscriptionUsageForAdmin(req) {
  const subscription = await getSubscriptionForAdmin(req);
  return subscription.usage ?? {};
}

export async function createSubscriptionUpgradeRequest(req) {
  const targetTier = req.body.targetTier ?? req.body.planTier;
  if (!targetTier) {
    throw errors.validation([
      { field: "targetTier", message: "targetTier is required." },
    ]);
  }
  const tenantId = req.auth.tenantId;
  const tenant = await loadTenant(tenantId);
  const currentTier = tenant.subscription?.tier ?? PlanTier.STARTER;
  const relation = compareTier(targetTier, currentTier);
  if (relation === "same") {
    throw errors.validation([
      { field: "targetTier", message: "You are already on this plan tier." },
    ]);
  }
  if (relation === "downgrade") {
    const planDoc = await SubscriptionPlan.findOne({
      tier: targetTier,
      billingCycle: BillingCycle.MONTHLY,
      active: true,
    }).lean();
    const usageCounts = await countTenantUsage(tenantId);
    const blocked = downgradeBlockedReasons(
      planDoc?.limits ?? {},
      usageCounts,
      planDoc?.name ?? targetTier,
    );
    if (blocked.length) {
      throw errors.validation(
        blocked.map((row) => ({ field: row.limitKey, message: row.message })),
      );
    }
  }

  await SubscriptionUpgradeRequest.updateMany(
    { tenantId, status: "PENDING_PLATFORM" },
    { $set: { status: "SUPERSEDED" } },
  );

  const row = await SubscriptionUpgradeRequest.create({
    _id: createId("upg"),
    tenantId,
    requestedBy: req.auth.id,
    targetTier: String(targetTier),
    billingCycle: req.body.billingCycle ?? BillingCycle.MONTHLY,
    note: req.body.note ? String(req.body.note).trim() : null,
    status: "PENDING_PLATFORM",
  });

  await writeAudit({
    req,
    action: "SUBSCRIPTION_CHANGE_REQUESTED",
    entityType: AuditEntityType.TENANT,
    entityId: tenantId,
    after: {
      requestId: row._id,
      targetTier: row.targetTier,
      relation,
    },
  });

  return {
    id: row._id,
    targetTier: row.targetTier,
    planTier: row.targetTier,
    billingCycle: row.billingCycle,
    note: row.note,
    status: row.status,
    relation,
  };
}

function compareTier(target, current) {
  const a = TIER_RANK[target] ?? 0;
  const b = TIER_RANK[current] ?? 0;
  if (a > b) return "upgrade";
  if (a < b) return "downgrade";
  return "same";
}

/** Absolute plan highlights (current-tier card). Upgrades use `gains` (delta vs current). */
function buildPlanIncludes(tier, limits = {}) {
  const features = DEFAULT_FEATURES_BY_TIER[tier] ?? {};
  const lines = [];
  if (limits.activeCustomers != null) {
    lines.push(
      `${Number(limits.activeCustomers).toLocaleString("en-IN")} active customers`,
    );
  }
  if (limits.branches != null) {
    const n = Number(limits.branches);
    lines.push(`${n} showroom${n === 1 ? "" : "s"}`);
  }
  if (limits.staff != null) {
    lines.push(`${Number(limits.staff)} staff seats`);
  }
  if (limits.whatsappMessages != null) {
    lines.push(
      `${Number(limits.whatsappMessages).toLocaleString("en-IN")} WhatsApp messages`,
    );
  }
  if (features.flexibleScheme) lines.push("Flexible schemes");
  if (features.multiBranch && Number(limits.branches ?? 0) > 1) {
    lines.push("Multi-showroom");
  }
  if (features.goldWeightScheme) lines.push("Gold weight schemes");
  if (features.prematureRedemption) lines.push("Premature redemption");
  if (features.customerSelfEnrol) lines.push("Customer self-enrol");
  if (features.ecommerce) lines.push("Online store (ecommerce)");
  if (features.customApp) lines.push("Custom branded app");
  if (features.advancedReports) lines.push("Advanced reports");
  return lines;
}

function downgradeBlockedReasons(planLimits, usage, tierName) {
  const checks = [
    {
      limitKey: "activeCustomers",
      used: usage.activeCustomers,
      limit: planLimits.activeCustomers,
      message: (u, l) =>
        `You have ${u} active customers. ${tierName} allows ${l}.`,
    },
    {
      limitKey: "branches",
      used: usage.branches,
      limit: planLimits.branches,
      message: (u, l) =>
        `You have ${u} showrooms. ${tierName} allows ${l}.`,
    },
    {
      limitKey: "staffSeats",
      used: usage.staffSeats,
      limit: planLimits.staff,
      message: (u, l) =>
        `You have ${u} active staff. ${tierName} allows ${l}.`,
    },
  ];
  return checks
    .filter((row) => row.limit != null && row.used > row.limit)
    .map((row) => ({
      limitKey: row.limitKey,
      message: row.message(row.used, row.limit),
    }));
}

export async function getAvailablePlansForAdmin(req) {
  const tenant = await loadTenant(req.auth.tenantId);
  const currentTier = tenant.subscription?.tier ?? PlanTier.STARTER;
  const usageCounts = await countTenantUsage(req.auth.tenantId);
  const plans = await SubscriptionPlan.find({ active: true, billingCycle: BillingCycle.MONTHLY })
    .sort({ pricePaise: 1 })
    .lean();
  const currentPlan = plans.find((p) => p.tier === currentTier);

  return plans.map((plan) => {
    const relation = compareTier(plan.tier, currentTier);
    const isCurrent = plan.tier === currentTier;
    const limits = plan.limits ?? {};
    const blockedReasons =
      relation === "downgrade"
        ? downgradeBlockedReasons(limits, usageCounts, plan.name ?? plan.tier)
        : [];
    const gains = [];
    const losses = [];
    if (relation === "upgrade" && currentPlan?.limits) {
      if ((limits.activeCustomers ?? 0) > (currentPlan.limits.activeCustomers ?? 0)) {
        gains.push(`${limits.activeCustomers?.toLocaleString("en-IN")} active customers`);
      }
      if ((limits.branches ?? 0) > (currentPlan.limits.branches ?? 0)) {
        gains.push(`${limits.branches} showrooms`);
      }
      if ((limits.whatsappMessages ?? 0) > (currentPlan.limits.whatsappMessages ?? 0)) {
        gains.push(`${limits.whatsappMessages?.toLocaleString("en-IN")} WhatsApp messages`);
      }
      if (plan.tier === PlanTier.PRO) {
        gains.push("Custom branded app");
      }
      if ((limits.staff ?? 0) > (currentPlan.limits.staff ?? 0)) {
        gains.push(`${limits.staff} staff seats`);
      }
    }
    if (relation === "downgrade" && currentPlan?.limits) {
      if ((limits.branches ?? 0) < (currentPlan.limits.branches ?? 0)) {
        losses.push("Multi-showroom");
      }
      if (!DEFAULT_FEATURES_BY_TIER[plan.tier]?.flexibleScheme) {
        losses.push("Flexible schemes");
      }
    }
    return {
      tier: plan.tier,
      name: plan.name ?? plan.tier,
      monthlyPrice: moneyRef(plan.pricePaise ?? 0),
      isCurrent,
      isUpgrade: relation === "upgrade",
      isDowngrade: relation === "downgrade",
      limits: {
        activeCustomers: limits.activeCustomers,
        branches: limits.branches,
        staffSeats: limits.staff,
        whatsappMessagesPerMonth: limits.whatsappMessages,
      },
      includes: buildPlanIncludes(plan.tier, limits),
      gains,
      losses,
      blockedReasons,
    };
  });
}

function invoicePeriodLabel(row) {
  if (row.dueDate && String(row.dueDate).trim()) return String(row.dueDate);
  if (row.paidAt) {
    try {
      return new Intl.DateTimeFormat("en-IN", {
        month: "short",
        year: "numeric",
      }).format(new Date(row.paidAt));
    } catch {
      return isoDate(row.paidAt) ?? "—";
    }
  }
  return "—";
}

export async function listSubscriptionInvoicesForAdmin(req) {
  const rows = await Invoice.find({ tenantId: req.auth.tenantId })
    .sort({ paidAt: -1, createdAt: -1 })
    .limit(50)
    .lean();
  return rows.map((row) => ({
    id: row._id,
    number: row.invoiceNumber ?? row.reference ?? row._id,
    invoiceNumber: row.invoiceNumber ?? null,
    reference: row.reference ?? null,
    periodLabel: invoicePeriodLabel(row),
    dueDate: row.dueDate ?? null,
    amount: moneyRef(row.amountPaise ?? 0),
    status: row.status ?? "ISSUED",
    paidAt: row.paidAt ?? null,
    createdAt: row.createdAt ?? null,
  }));
}

function enforceVersion(record, expectedVersion) {
  if (expectedVersion && record.version !== expectedVersion) {
    throw new AppError(
      "VERSION_CONFLICT",
      "This record changed. Refresh and try again.",
      409,
    );
  }
}

export async function patchSettingsProfile(req) {
  return withTransaction(async (session) => {
    const tenant = await Tenant.findById(req.auth.tenantId).session(session);
    if (!tenant) throw errors.notFound("Tenant");
    enforceVersion(tenant, req.body.expectedVersion);
    const patch = req.body;

    if (patch.businessName != null) tenant.name = String(patch.businessName).trim();
    if (patch.displayName != null) tenant.displayName = String(patch.displayName).trim();
    if (patch.supportNumber != null) tenant.supportNumber = String(patch.supportNumber).trim();
    if (patch.gstin !== undefined) tenant.gstin = patch.gstin || null;
    if (patch.address) {
      tenant.address = {
        ...(tenant.address?.toObject?.() ?? tenant.address ?? {}),
        ...patch.address,
      };
    }

    const owner = await User.findOne({
      tenantId: tenant._id,
      role: TenantRole.TENANT_OWNER,
      type: UserType.TENANT_USER,
    }).session(session);
    if (owner) {
      if (patch.ownerName != null) owner.name = String(patch.ownerName).trim();
      if (patch.ownerMobile != null) owner.mobile = String(patch.ownerMobile).trim();
      if (patch.ownerEmail !== undefined) owner.email = patch.ownerEmail || null;
      await owner.save({ session });
    }

    tenant.version += 1;
    await tenant.save({ session });
    await writeAudit({
      req,
      action: "TENANT_PROFILE_UPDATED",
      entityType: AuditEntityType.TENANT,
      entityId: tenant._id,
      after: tenant.toObject(),
      session,
    });
    return getSettingsProfileForAdmin(req);
  });
}

export async function patchSettingsBranding(req) {
  return withTransaction(async (session) => {
    const tenant = await Tenant.findById(req.auth.tenantId).session(session);
    if (!tenant) throw errors.notFound("Tenant");
    enforceVersion(tenant, req.body.expectedVersion);
    if (req.body.logoUploadId) {
      const { validateUploadReferences } = await import("./upload.service.js");
      await validateUploadReferences({ req, uploadIds: [req.body.logoUploadId], purpose: UploadPurpose.TENANT_LOGO, session, subjectId: req.auth.id, entityType: "TENANT_BRANDING", entityId: tenant._id });
    }
    const patch = { ...req.body };
    const brandingPatch = {};
    if (patch.logoUploadId != null) brandingPatch.logoUploadId = patch.logoUploadId;
    if (patch.primaryColor != null) brandingPatch.primaryColor = patch.primaryColor;
    if (patch.accentColor != null) brandingPatch.accentColor = patch.accentColor;
    if (patch.secondaryColor != null) brandingPatch.accentColor = patch.secondaryColor;
    if (patch.displayName != null) brandingPatch.displayName = patch.displayName;
    if (patch.appDisplayName != null) brandingPatch.displayName = patch.appDisplayName;
    tenant.branding = {
      ...(tenant.branding?.toObject?.() ?? tenant.branding ?? {}),
      ...brandingPatch,
    };
    tenant.version += 1;
    await tenant.save({ session });
    await writeAudit({
      req,
      action: "TENANT_BRANDING_UPDATED",
      entityType: AuditEntityType.TENANT,
      entityId: tenant._id,
      after: tenant.toObject(),
      session,
    });
    const fresh = await Tenant.findById(req.auth.tenantId).lean();
    const presented = {
      ...(await getSettingsBrandingForAdmin(req)),
      previewUrls: buildBrandingPreviewUrls(fresh ?? tenant.toObject()),
    };
    return { ...presented, auditEventId: undefined };
  });
}

export async function patchSettingsOperations(req) {
  return withTransaction(async (session) => {
    const tenant = await Tenant.findById(req.auth.tenantId).session(session);
    if (!tenant) throw errors.notFound("Tenant");
    enforceVersion(tenant, req.body.expectedVersion);
    const patch = { ...req.body };
    delete patch.expectedVersion;
    if (
      patch.customerLoginMode != null &&
      !Object.values(CustomerLoginMode).includes(patch.customerLoginMode)
    ) {
      throw errors.validation([
        {
          field: "customerLoginMode",
          message: `customerLoginMode must be one of ${Object.values(CustomerLoginMode).join(", ")}.`,
        },
      ]);
    }
    if (patch.ecommerceEnabled === true) {
      const tenantForEntitlement =
        req.tenant && String(req.tenant._id) === String(tenant._id)
          ? req.tenant
          : await attachSubscriptionCatalogPlan(tenant.toObject());
      assertCanEnableEcommerceStore(tenantForEntitlement);
    }

    tenant.operations = {
      ...(tenant.operations?.toObject?.() ?? tenant.operations ?? {}),
      ...patch,
    };
    if (patch.customerAppWriteEnabled === false) {
      tenant.operations.customerAppPaymentsEnabled = false;
    }
    if (patch.multiSchemePerCustomer != null) {
      tenant.settings.oneActiveSchemePerCustomer = !patch.multiSchemePerCustomer;
    }
    if (patch.kycMandatory != null) {
      tenant.settings.requireKycForEnrolment = patch.kycMandatory === true;
    }
    if (patch.requireKycForRedemption != null) {
      tenant.settings.requireKycForRedemption = patch.requireKycForRedemption === true;
    }
    if (patch.customerAppMaintenance != null) {
      tenant.settings.customerAppMaintenance = patch.customerAppMaintenance === true;
    }

    tenant.version += 1;
    await tenant.save({ session });
    await writeAudit({
      req,
      action: "TENANT_OPERATIONS_UPDATED",
      entityType: AuditEntityType.TENANT,
      entityId: tenant._id,
      after: tenant.toObject(),
      session,
    });
    return presentOperations(await attachSubscriptionCatalogPlan(tenant.toObject()));
  });
}
