import argon2 from "argon2";
import dayjs from "dayjs";
import {
  AuditEvent, Branch, Customer, ErrorLog, Invoice, Message, PlatformSettings, Scheme, SchemePlan, SubscriptionPlan, TemplateDefinition, Tenant, User, WebhookEvent,
} from "../models/index.js";
import { createId } from "../lib/ids.js";
import {
  AuditEntityType, BillingCycle, InvoiceStatus, MessageStatus, PlanTier, SchemePlanStatus, SubscriptionExtensionType, SubscriptionStatus, TenantRole, TenantStatus, UserStatus, UserType,
} from "../constants/enums.js";
import { ROLE_PERMISSIONS } from "../constants/permissions.js";
import { paginate } from "../lib/pagination.js";
import { boundedSearchQuery, containsSearchRegex, escaped } from "../lib/query-filters.js";
import { withTransaction } from "../lib/transaction.js";
import { AppError, errors } from "../lib/app-error.js";
import { seal } from "../lib/crypto.js";

function isSealedSecret(value) {
  const parts = String(value ?? "").split(".");
  return parts.length === 3 && parts[0].length >= 8;
}
import { moneyRef, percentOfPaiseHalfUp } from "../lib/money.js";
import { allocatePlatformInvoiceNumber } from "../lib/platform-invoice-sequence.js";
import { generateTemporaryPassword } from "../lib/password-generator.js";
import {
  PASSWORD_PIN_MESSAGE,
  passwordPolicySchema,
} from "../validators/common.validators.js";
import {
  chartSeries, deriveTenantCodeFromName, mapPublicPlans,
  mapPublicSubscriptionPlan, maskSecret, subscriptionSummaryForTenant, tenantListRow, usagePercent,
} from "../lib/platform-dto.js";
import { limitsFromApi, limitsToApi, normalizePlanFeatures } from "../constants/plan-features.js";
import { normalizeFeatureFlags } from "../constants/platform-feature-flags.js";
import {
  effectivePlatformFlags,
  resolvePlanFeatureBooleans,
} from "../lib/feature-entitlements.js";
import {
  assertPlanAllowsBillingCycle,
  normalizeSupportedBillingCycles,
  subscriptionPatchFromPlan,
} from "../lib/subscription-provision.js";
import { PLATFORM_TEMPLATE_DEFINITIONS, REQUIRED_TEMPLATE_TYPES, getTemplateDefinition } from "../constants/template-registry.js";
import { auditPlatformMutation } from "../lib/platform-audit.js";

export const DEFAULT_APP_CONFIG = Object.freeze({
  android: {
    minimumVersion: "1.0.0",
    latestVersion: "1.0.0",
    forceUpdate: false,
    storeUrl: null,
  },
  ios: {
    minimumVersion: "1.0.0",
    latestVersion: "1.0.0",
    forceUpdate: false,
    storeUrl: null,
  },
  maintenance: { enabled: false, title: null, message: null },
});

async function tenantCountsByTier() {
  const rows = await Tenant.aggregate([{ $group: { _id: "$subscription.tier", count: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
}

export async function mapPlanRow(plan, tenantCounts) {
  return mapPublicSubscriptionPlan(plan, { tenantCount: tenantCounts[plan.tier] ?? 0 });
}

export async function listSubscriptionPlans() {
  const [plans, tenantCounts] = await Promise.all([
    SubscriptionPlan.find({}).sort({ sortOrder: 1, pricePaise: 1 }).lean(),
    tenantCountsByTier(),
  ]);
  return mapPublicPlans(plans, { tenantCounts });
}

export async function createSubscriptionPlan(body, req) {
  const patch = { ...body };
  delete patch.expectedVersion;
  delete patch.code;
  const billingCycle = body.billingCycle ?? patch.billingCycle;
  delete patch.billingCycle;
  patch.supportedBillingCycles = normalizeSupportedBillingCycles(patch, billingCycle);
  patch.billingCycle = patch.supportedBillingCycles[0];
  if (patch.yearlyPricePaise == null && patch.annualPricePaise != null) {
    patch.yearlyPricePaise = patch.annualPricePaise;
  }
  delete patch.annualPricePaise;
  if (patch.monthlyPricePaise != null) patch.pricePaise = patch.monthlyPricePaise;
  if (patch.limits) patch.limits = limitsFromApi(patch.limits);
  if (patch.features) patch.features = normalizePlanFeatures(patch.features, patch.tier);
  if (!patch._id && patch.tier) patch._id = `splan_${String(patch.tier).toLowerCase()}`;
  const row = await SubscriptionPlan.create({ _id: patch._id ?? createId("subscriptionPlan"), ...patch });
  if (req) {
    await auditPlatformMutation({
      req,
      action: "PLATFORM_PLAN_CREATED",
      entityType: AuditEntityType.PLAN,
      entityId: row._id,
      tenantId: "platform",
      after: row.toObject(),
    });
  }
  return mapPublicSubscriptionPlan(row.toObject());
}

export async function getSubscriptionPlan(id) {
  const row = await SubscriptionPlan.findById(id).lean();
  if (!row) throw errors.notFound("Subscription plan");
  const tenantCounts = await tenantCountsByTier();
  return mapPlanRow(row, tenantCounts);
}

export async function updateSubscriptionPlan(id, body, req) {
  if (body.expectedVersion == null) throw new AppError("VALIDATION_FAILED", "expectedVersion is required.", 422);
  const before = await SubscriptionPlan.findById(id).lean();
  const patch = { ...body };
  delete patch.expectedVersion;
  if (patch.monthlyPricePaise != null) patch.pricePaise = patch.monthlyPricePaise;
  if (patch.limits) patch.limits = limitsFromApi(patch.limits);
  if (patch.features != null) {
    const tier = patch.tier ?? before?.tier ?? PlanTier.STARTER;
    patch.features = normalizePlanFeatures(patch.features, tier);
  }
  if (patch.supportedBillingCycles?.length) {
    patch.supportedBillingCycles = normalizeSupportedBillingCycles(patch, patch.billingCycle ?? before?.billingCycle);
    patch.billingCycle = patch.supportedBillingCycles[0];
  }
  const row = await SubscriptionPlan.findOneAndUpdate(
    { _id: id, ...(body.expectedVersion != null ? { version: Number(body.expectedVersion) } : {}) },
    { $set: patch, $inc: { version: 1 } },
    { new: true },
  ).lean();
  if (!row) throw errors.conflict("VERSION_CONFLICT", "Subscription plan not found or changed. Refresh and try again.");
  if (req) {
    await auditPlatformMutation({
      req,
      action: "PLATFORM_PLAN_UPDATED",
      entityType: AuditEntityType.PLAN,
      entityId: id,
      tenantId: "platform",
      before,
      after: row,
    });
  }
  return mapPublicSubscriptionPlan(row);
}

export async function deprecateSubscriptionPlan(id, req) {
  const before = await SubscriptionPlan.findById(id).lean();
  const row = await SubscriptionPlan.findByIdAndUpdate(id, { $set: { active: false }, $inc: { version: 1 } }, { new: true }).lean();
  if (!row) throw errors.notFound("Subscription plan");
  if (req) {
    await auditPlatformMutation({
      req,
      action: "PLATFORM_PLAN_DEPRECATED",
      entityType: AuditEntityType.PLAN,
      entityId: id,
      tenantId: "platform",
      before,
      after: row,
    });
  }
  return mapPublicSubscriptionPlan(row);
}

export async function listTemplates() {
  return { data: PLATFORM_TEMPLATE_DEFINITIONS, meta: { nextCursor: null, hasMore: false, limit: PLATFORM_TEMPLATE_DEFINITIONS.length } };
}

async function provisioningSummary(tenantId) {
  const tenant = await Tenant.findById(tenantId).select("+integrationSecrets").lean();
  const configuredRows = await TemplateDefinition.find({ tenantId, active: true }).select("messageType").lean();
  const configuredTypes = new Set(configuredRows.map((row) => row.messageType));
  const configuredRequired = REQUIRED_TEMPLATE_TYPES.filter((type) => configuredTypes.has(type)).length;
  const whatsappConfigured = Boolean(tenant?.integrationSecrets?.whatsapp?.accessToken);
  const paymentGatewayConfigured = Boolean(tenant?.integrationSecrets?.phonepe?.clientId);
  const templatesRequired = REQUIRED_TEMPLATE_TYPES.length;
  return {
    whatsappConfigured,
    paymentGatewayConfigured,
    templatesConfigured: configuredRequired,
    templatesRequired,
    readyToGoLive: whatsappConfigured && paymentGatewayConfigured && configuredRequired >= templatesRequired,
  };
}

async function usageSnapshot(tenantId, limits = {}) {
  const apiLimits = limitsToApi(limits);
  const [activeCustomers, branches, staff, whatsappUsedThisMonth] = await Promise.all([
    Customer.countDocuments({ tenantId, status: "ACTIVE" }),
    Branch.countDocuments({ tenantId, active: true }),
    User.countDocuments({ tenantId, status: UserStatus.ACTIVE, type: UserType.TENANT_USER }),
    Message.countDocuments({ tenantId, createdAt: { $gte: dayjs().startOf("month").toDate() } }),
  ]);
  return {
    activeCustomers,
    branches,
    staff,
    whatsappUsedThisMonth,
    limits: apiLimits,
    activeCustomersPercent: usagePercent(activeCustomers, apiLimits.activeCustomers),
  };
}

export async function listTenants(req) {
  const filters = {};
  if (req.query.status && req.query.status !== "ALL") filters.status = req.query.status;
  if (req.query.tier && req.query.tier !== "ALL") filters["subscription.tier"] = req.query.tier;
  if (req.query.setupPending === "true") filters.status = TenantStatus.PENDING_SETUP;
  if (req.query.q) {
    const q = boundedSearchQuery(req.query.q);
    if (q) {
      const nameRe = containsSearchRegex(q);
      const ownerTenantIds = q.length >= 2
        ? await User.find({
          role: TenantRole.TENANT_OWNER,
          $or: [{ name: nameRe }, { mobile: q }, { email: nameRe }],
        }).distinct("tenantId")
        : [];
      filters.$or = [
        { name: nameRe },
        { mobile: q },
        { email: q },
        { "address.city": nameRe },
        { code: q.toUpperCase() },
        ...(ownerTenantIds.length ? [{ _id: { $in: ownerTenantIds } }] : []),
      ];
    }
  }
  const page = await paginate(Tenant, { filters, cursor: req.query.cursor, limit: req.query.limit, sort: "createdAt:desc" });
  const ownerByTenant = {};
  if (page.data.length) {
    const owners = await User.find({ tenantId: { $in: page.data.map((row) => row._id) }, role: TenantRole.TENANT_OWNER }).select("tenantId name mobile email").lean();
    for (const owner of owners) ownerByTenant[owner.tenantId] = owner;
  }
  page.data = await Promise.all(page.data.map(async (tenant) => {
    const provisioning = await provisioningSummary(tenant._id);
    const usage = await usageSnapshot(tenant._id, tenant.subscription?.limits);
    const owner = ownerByTenant[tenant._id];
    return tenantListRow(tenant, {
      ownerName: owner?.name ?? null,
      ownerMobile: owner?.mobile ?? null,
      ownerEmail: owner?.email ?? null,
      provisioning,
      usage,
    });
  }));
  const [total, active, pendingSetup, suspended, cancelled, atCustomerLimit] = await Promise.all([
    Tenant.countDocuments(filters),
    Tenant.countDocuments({ ...filters, status: TenantStatus.ACTIVE }),
    Tenant.countDocuments({ ...filters, status: TenantStatus.PENDING_SETUP }),
    Tenant.countDocuments({ ...filters, status: TenantStatus.SUSPENDED }),
    Tenant.countDocuments({ ...filters, status: TenantStatus.CANCELLED }),
    countTenantsAtCustomerLimit(filters),
  ]);
  page.meta.summary = { total, active, pendingSetup, suspended, cancelled, atCustomerLimit };
  return page;
}

async function countTenantsAtCustomerLimit(filters) {
  const tenants = await Tenant.find(filters).select("_id subscription.limits").lean();
  if (!tenants.length) return 0;
  const checks = await Promise.all(tenants.map(async (tenant) => {
    const limit = limitsToApi(tenant.subscription?.limits).activeCustomers;
    if (limit == null || limit <= 0) return false;
    const used = await Customer.countDocuments({ tenantId: tenant._id, status: "ACTIVE" });
    return used >= Math.ceil(limit * 0.9);
  }));
  return checks.filter(Boolean).length;
}

function resolvePlanFromBody(body) {
  if (body.subscriptionPlanId) return SubscriptionPlan.findById(body.subscriptionPlanId).lean();
  if (body.subscription?.tier) return SubscriptionPlan.findOne({ tier: body.subscription.tier, active: true }).lean();
  return null;
}

export async function createTenant(req) {
  const body = req.body;
  const plan = await resolvePlanFromBody(body);
  const trialDays = body.trialDays ?? plan?.trialDays ?? 14;
  const billingCycle = body.billingCycle ?? BillingCycle.MONTHLY;
  const temporaryPassword = generateTemporaryPassword();
  const businessName = body.businessName ?? body.name;
  const tenantCode = body.code ?? body.tenantCode ?? await (async () => {
    const base = deriveTenantCodeFromName(businessName);
    let code = base;
    let n = 0;
    while (await Tenant.exists({ code })) { n += 1; code = `${base.slice(0, 10)}${n}`; }
    return code;
  })();
  if (plan) assertPlanAllowsBillingCycle(plan, billingCycle);
  const subscription = subscriptionPatchFromPlan(plan, {
    billingCycle,
    trialEndsAt: dayjs().add(trialDays, "day").toDate(),
    status: SubscriptionStatus.TRIAL,
  });
  const ownerPasswordHash = await argon2.hash(temporaryPassword, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const result = await withTransaction(async (session) => {
    const tenant = (await Tenant.create([{
      _id: createId("tenant"),
      code: tenantCode,
      name: businessName,
      displayName: body.displayName ?? businessName,
      mobile: body.ownerMobile ?? body.mobile,
      email: body.ownerEmail ?? body.email,
      supportNumber: body.supportNumber,
      address: body.city || body.address ? { line1: body.address, city: body.city } : undefined,
      status: TenantStatus.PENDING_SETUP,
      subscription,
    }], { session }))[0];
    let branch = null;
    if (body.createDefaultBranch !== false) {
      branch = (await Branch.create([{
        _id: createId("branch"),
        tenantId: tenant._id,
        code: "MAIN",
        name: body.defaultBranchName ?? body.headOfficeName ?? "Main Showroom",
        isHeadOffice: true,
      }], { session }))[0];
    }
    const owner = (await User.create([{
      _id: createId("user"),
      type: UserType.TENANT_USER,
      tenantId: tenant._id,
      branchId: branch?._id ?? null,
      role: TenantRole.TENANT_OWNER,
      name: body.ownerName ?? body.name,
      mobile: body.ownerMobile ?? body.mobile,
      email: body.ownerEmail ?? body.email,
      passwordHash: ownerPasswordHash,
      mustSetPassword: true,
      status: UserStatus.ACTIVE,
      permissions: ROLE_PERMISSIONS.TENANT_OWNER,
    }], { session }))[0];
    return {
      tenant: {
        id: tenant._id,
        businessName: tenant.name,
        tenantCode: tenant.code,
        status: tenant.status,
        subscription: {
          tier: tenant.subscription.tier,
          status: tenant.subscription.status,
          trialEndsAt: tenant.subscription.trialEndsAt,
        },
      },
      ownerUser: {
        id: owner._id,
        name: owner.name,
        mobile: owner.mobile,
        role: owner.role,
        temporaryPassword,
        mustChangePassword: true,
      },
      defaultBranch: branch ? { id: branch._id, name: branch.name, code: branch.code } : null,
      nextSteps: [
        { key: "WHATSAPP_CREDENTIALS", done: false },
        { key: "PAYMENT_GATEWAY", done: false },
        { key: "WHATSAPP_TEMPLATES", done: false },
        { key: "GO_LIVE", done: false },
      ],
      ...(body.sendWelcomeMessage ? { welcomeMessageQueued: true } : {}),
    };
  });
  await auditPlatformMutation({
    req,
    action: "PLATFORM_TENANT_CREATED",
    entityType: AuditEntityType.TENANT,
    entityId: result.tenant.id,
    tenantId: result.tenant.id,
    after: result.tenant,
  });
  return result;
}

export async function tenantDetail(id) {
  const tenant = await Tenant.findById(id).select("-integrationSecrets").lean();
  if (!tenant) throw errors.notFound("Tenant");
  const secrets = await Tenant.findById(id).select("+integrationSecrets").lean();
  const [branches, owner, templates, stats] = await Promise.all([
    Branch.find({ tenantId: id }).lean(),
    User.findOne({ tenantId: id, role: TenantRole.TENANT_OWNER }).select("-passwordHash").lean(),
    TemplateDefinition.find({ tenantId: id, active: true }).lean(),
    Promise.all([
      Scheme.countDocuments({ tenantId: id }),
      Scheme.countDocuments({ tenantId: id, status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED", "MATURED"] } }),
    ]),
  ]);
  const limits = limitsToApi(tenant.subscription?.limits);
  const usageLimits = limits;
  const [activeCustomers, branchCount, staffCount, schemePlanCount, whatsappUsed] = await Promise.all([
    Customer.countDocuments({ tenantId: id, status: "ACTIVE" }),
    Branch.countDocuments({ tenantId: id, active: true }),
    User.countDocuments({ tenantId: id, status: UserStatus.ACTIVE, type: UserType.TENANT_USER }),
    SchemePlan.countDocuments({
      tenantId: id,
      status: { $in: [SchemePlanStatus.ACTIVE, SchemePlanStatus.INACTIVE] },
    }),
    Message.countDocuments({ tenantId: id, createdAt: { $gte: dayjs().startOf("month").toDate() } }),
  ]);
  const configuredTypes = new Set(templates.map((row) => row.messageType));
  const missing = REQUIRED_TEMPLATE_TYPES.filter((type) => !configuredTypes.has(type));
  const featureMap = resolvePlanFeatureBooleans(tenant);
  const provisioning = await provisioningSummary(id);
  const { flags, effectiveFlags } = await tenantFlags(id);
  const metric = (used, limitKey) => ({
    used,
    limit: usageLimits[limitKey] ?? null,
    percentage: usagePercent(used, usageLimits[limitKey]) ?? 0,
  });
  return {
    id: tenant._id,
    tenantCode: tenant.code,
    businessName: tenant.name,
    displayName: tenant.displayName ?? tenant.branding?.displayName ?? tenant.name,
    gstin: tenant.gstin ?? null,
    address: tenant.address?.line1 ?? null,
    city: tenant.address?.city ?? null,
    supportNumber: tenant.supportNumber ?? null,
    ownerEmail: owner?.email ?? tenant.email ?? null,
    status: tenant.status,
    goLiveAt: tenant.goLiveAt ?? null,
    branding: tenant.branding ?? {},
    settings: { ...tenant.settings, ...tenant.operations },
    subscription: {
      ...subscriptionSummaryForTenant(tenant),
      currentPeriodStart: tenant.subscription?.startsAt ? dayjs(tenant.subscription.startsAt).format("YYYY-MM-DD") : null,
      limits,
      limitOverrides: tenant.subscription?.limitOverrides ?? {},
      features: featureMap,
    },
    provisioning,
    integrations: {
      whatsapp: {
        configured: Boolean(secrets?.integrationSecrets?.whatsapp?.accessToken),
        provider: "META_CLOUD",
        phoneNumberDisplay: secrets?.integrationSecrets?.whatsapp?.phoneNumberId ?? null,
        lastVerifiedAt: secrets?.integrationSecrets?.whatsapp?.verifiedAt ?? null,
        accessTokenMasked: maskSecret(secrets?.integrationSecrets?.whatsapp?.accessToken),
        verificationStatus: secrets?.integrationSecrets?.whatsapp?.verificationStatus
          ?? (secrets?.integrationSecrets?.whatsapp?.verifiedAt ? "VERIFIED" : "NOT_VERIFIED"),
      },
      fcm: {
        configured: Boolean(secrets?.integrationSecrets?.fcm?.projectId
          && secrets?.integrationSecrets?.fcm?.serviceAccountJsonSealed),
        projectId: secrets?.integrationSecrets?.fcm?.projectId ?? null,
        credentialVersion: secrets?.integrationSecrets?.fcm?.credentialVersion ?? null,
        updatedAt: secrets?.integrationSecrets?.fcm?.updatedAt ?? null,
      },
      paymentGateway: {
        configured: Boolean(secrets?.integrationSecrets?.phonepe?.clientId),
        clientCredentialsConfigured: Boolean(
          secrets?.integrationSecrets?.phonepe?.clientId
            && secrets?.integrationSecrets?.phonepe?.clientSecret,
        ),
        provider: "PHONEPE",
        clientIdMasked: maskSecret(secrets?.integrationSecrets?.phonepe?.clientId),
        environment: secrets?.integrationSecrets?.phonepe?.environment ?? "SANDBOX",
        lastVerifiedAt: secrets?.integrationSecrets?.phonepe?.verifiedAt ?? null,
        verificationStatus: secrets?.integrationSecrets?.phonepe?.verificationStatus
          ?? (secrets?.integrationSecrets?.phonepe?.verifiedAt ? "VERIFIED" : "NOT_VERIFIED"),
      },
    },
    templates: {
      configured: REQUIRED_TEMPLATE_TYPES.filter((type) => configuredTypes.has(type)).length,
      required: REQUIRED_TEMPLATE_TYPES.length,
      missing,
    },
    usage: {
      activeCustomers,
      branches: branchCount,
      staff: staffCount,
      whatsappUsedThisMonth: whatsappUsed,
    },
    usageDetail: {
      activeCustomers: metric(activeCustomers, "activeCustomers"),
      branches: metric(branchCount, "branches"),
      staff: metric(staffCount, "staffSeats"),
      schemePlans: metric(schemePlanCount, "schemePlans"),
      whatsappMessages: {
        ...metric(whatsappUsed, "whatsappMessagesPerMonth"),
        resetDate: dayjs().add(1, "month").startOf("month").format("YYYY-MM-DD"),
      },
    },
    branches: branches.map((row) => ({ id: row._id, name: row.name, code: row.code, status: row.active ? "ACTIVE" : "INACTIVE" })),
    owner: owner
      ? { id: owner._id, name: owner.name, mobile: owner.mobile, email: owner.email ?? "" }
      : { id: "", name: "—", mobile: "—", email: "" },
    stats: { totalSchemes: stats[0], activeSchemes: stats[1] },
    flags,
    effectiveFlags,
    audit: { createdAt: tenant.createdAt, version: tenant.version },
  };
}

export async function tenantAction(id, action, body = {}, req) {
  const before = await Tenant.findById(id).select("-integrationSecrets").lean();
  if (action === "go-live") {
    const issues = [];
    const tenant = await Tenant.findById(id).select("+integrationSecrets").lean();
    if (!tenant) throw errors.notFound("Tenant");
    if (!tenant.integrationSecrets?.whatsapp?.verifiedAt) issues.push({ key: "WHATSAPP", message: "WhatsApp integration is not verified." });
    if (!tenant.integrationSecrets?.phonepe?.verifiedAt) issues.push({ key: "PAYMENT_GATEWAY", message: "Payment gateway is not verified." });
    const templates = await TemplateDefinition.find({ tenantId: id, active: true }).select("messageType").lean();
    const configured = new Set(templates.map((row) => row.messageType));
    for (const messageType of REQUIRED_TEMPLATE_TYPES.filter((type) => !configured.has(type))) {
      issues.push({ key: "WHATSAPP_TEMPLATES", message: `Template for ${messageType} is not configured` });
    }
    const branchCount = await Branch.countDocuments({ tenantId: id, active: true });
    if (branchCount < 1) issues.push({ key: "BRANCH", message: "At least one active branch is required" });
    if (issues.length) {
      throw new AppError("VALIDATION_FAILED", `Tenant cannot go live yet. ${issues.length} setup item(s) are incomplete.`, 422, issues);
    }
    const updated = await Tenant.findByIdAndUpdate(id, { $set: { status: TenantStatus.ACTIVE, goLiveAt: new Date() }, $inc: { version: 1 } }, { new: true }).lean();
    const response = {
      ok: true,
      checklist: [
        { key: "WHATSAPP_CREDENTIALS", done: true },
        { key: "PAYMENT_GATEWAY", done: true },
        { key: "WHATSAPP_TEMPLATES", done: true },
        { key: "GO_LIVE", done: true },
      ],
      tenant: { id: updated._id, status: updated.status, goLiveAt: updated.goLiveAt },
    };
    if (req) {
      await auditPlatformMutation({
        req,
        action: "PLATFORM_TENANT_GO_LIVE",
        entityType: AuditEntityType.TENANT,
        entityId: id,
        tenantId: id,
        before,
        after: updated,
      });
    }
    return response;
  }
  const status = action === "suspend" ? TenantStatus.SUSPENDED : TenantStatus.ACTIVE;
  const tenant = await Tenant.findByIdAndUpdate(id, { $set: { status, suspendReason: body.reason }, $inc: { version: 1 } }, { new: true });
  if (!tenant) throw errors.notFound("Tenant");
  if (req) {
    await auditPlatformMutation({
      req,
      action: action === "suspend" ? "PLATFORM_TENANT_SUSPENDED" : "PLATFORM_TENANT_REACTIVATED",
      entityType: AuditEntityType.TENANT,
      entityId: id,
      tenantId: id,
      before,
      after: tenant.toObject(),
    });
  }
  if (action === "suspend") {
    return {
      id: tenant._id,
      status: tenant.status,
      suspendedAt: new Date().toISOString(),
      reason: body.reason ?? null,
      effects: {
        tenantWritesBlocked: true,
        readsAllowed: true,
        reminderJobsStopped: true,
        tenantApiErrorCode: "SUBSCRIPTION_INACTIVE",
      },
    };
  }
  return {
    id: tenant._id,
    status: tenant.status,
    reactivatedAt: new Date().toISOString(),
    effects: { tenantWritesBlocked: false, reminderJobsStopped: false },
  };
}

export async function platformSummary() {
  const monthStart = dayjs().startOf("month").toDate();
  const [
    total, active, pendingSetup, suspended, cancelled, tierRows, paidInvoices, customers, schemes,
    whatsappSent, whatsappFailed, webhookFailures, pastDue,
  ] = await Promise.all([
    Tenant.countDocuments(),
    Tenant.countDocuments({ status: TenantStatus.ACTIVE }),
    Tenant.countDocuments({ status: TenantStatus.PENDING_SETUP }),
    Tenant.countDocuments({ status: TenantStatus.SUSPENDED }),
    Tenant.countDocuments({ status: TenantStatus.CANCELLED }),
    Tenant.aggregate([{ $group: { _id: "$subscription.tier", count: { $sum: 1 } } }]),
    Invoice.find({ status: InvoiceStatus.PAID, paidAt: { $gte: monthStart } }).select("amountPaise").lean(),
    Customer.countDocuments({ status: "ACTIVE" }),
    Scheme.countDocuments({ status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED", "MATURED"] } }),
    Message.countDocuments({ createdAt: { $gte: monthStart }, status: { $in: [MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ] } }),
    Message.countDocuments({ createdAt: { $gte: monthStart }, status: MessageStatus.FAILED }),
    WebhookEvent.countDocuments({ status: { $in: ["FAILED", "SIGNATURE_FAILED", "DEAD_LETTER"] } }),
    Tenant.countDocuments({ "subscription.status": SubscriptionStatus.PAST_DUE }),
  ]);
  const mrrPaise = paidInvoices.reduce((sum, row) => sum + (row.amountPaise ?? 0), 0);
  const collectionPaise = mrrPaise;
  const whatsappTotal = whatsappSent + whatsappFailed;
  return {
    tenants: { total, active, pendingSetup, suspended, cancelled },
    tenantsByTier: tierRows.map((row) => ({ tier: row._id ?? "UNKNOWN", count: row.count })),
    mrr: moneyRef(mrrPaise),
    platformVolume: {
      collectionThisMonth: moneyRef(collectionPaise),
      activeCustomersTotal: customers,
      activeSchemesTotal: schemes,
    },
    whatsapp: {
      sentThisMonth: whatsappSent,
      failedThisMonth: whatsappFailed,
      deliveryRatePercent: whatsappTotal ? Math.round((whatsappSent / whatsappTotal) * 1000) / 10 : 100,
    },
    alerts: [
      ...(webhookFailures ? [{ severity: "HIGH", key: "WEBHOOK_FAILURES", message: `${webhookFailures} unprocessed webhook failures`, count: webhookFailures }] : []),
      ...(pastDue ? [{ severity: "MEDIUM", key: "SUBSCRIPTION_PAST_DUE", message: `${pastDue} tenants past due`, count: pastDue }] : []),
    ],
  };
}

export async function upsertTenantTemplate(tenantId, messageType, body, req) {
  const definition = getTemplateDefinition(messageType);
  if (definition && body.variableOrder) {
    const required = definition.variables.map((row) => row.key);
    const provided = body.variableOrder ?? [];
    const missing = required.filter((key) => !provided.includes(key));
    const extra = provided.filter((key) => !required.includes(key));
    if (missing.length || extra.length) {
      throw new AppError("VALIDATION_FAILED", "Template variable order does not match the platform definition.", 400, { missing, extra });
    }
  }
  const before = await TemplateDefinition.findOne({ tenantId, messageType }).lean();
  const updated = await TemplateDefinition.findOneAndUpdate(
    { tenantId, messageType },
    {
      $set: {
        providerTemplateName: body.templateName ?? body.providerTemplateName,
        body: body.notes ?? body.body,
        variables: body.variableOrder ?? body.variables,
        language: body.languageCode ?? body.language ?? "en",
        approvalStatus: body.approvalStatus,
        providerTemplateId: body.templateId,
        buttonUrlVariableKey: body.buttonUrlVariableKey,
      },
      $setOnInsert: { _id: createId("template") },
      $inc: { version: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  await auditPlatformMutation({ req, action: before ? "TENANT_TEMPLATE_UPDATED" : "TENANT_TEMPLATE_CREATED", entityType: AuditEntityType.TEMPLATE, entityId: updated._id, tenantId, before, after: updated });
  return updated;
}

export async function createInvoice(tenantId, body, req) {
  const lineItems = body.lineItems?.length
    ? body.lineItems
    : [{ description: body.description ?? "Platform subscription", amountPaise: body.amountPaise ?? 0 }];
  const subtotalPaise = lineItems.reduce((sum, row) => sum + (row.amountPaise ?? 0), 0);
  const taxPercent = body.taxPercent ?? 0;
  const taxPaise = percentOfPaiseHalfUp(subtotalPaise, taxPercent, { fieldName: "taxPercent" });
  const totalPaise = subtotalPaise + taxPaise;
  const invoiceNumber = body.invoiceNumber ?? (await allocatePlatformInvoiceNumber());
  const row = await Invoice.create({
    _id: createId("invoice"),
    tenantId,
    invoiceNumber,
    periodStart: body.periodStart,
    periodEnd: body.periodEnd,
    lineItems,
    subtotalPaise,
    taxPercent,
    taxPaise,
    amountPaise: totalPaise,
    dueDate: body.dueDate,
    notes: body.notes,
    status: InvoiceStatus.ISSUED,
    pdfUrl: body.pdfUrl ?? null,
  });
  if (req) {
    await auditPlatformMutation({
      req,
      action: "PLATFORM_INVOICE_CREATED",
      entityType: AuditEntityType.INVOICE,
      entityId: row._id,
      tenantId,
      after: row.toObject(),
    });
  }
  return {
    id: row._id,
    invoiceNumber: row.invoiceNumber,
    subtotal: moneyRef(row.subtotalPaise),
    tax: moneyRef(row.taxPaise),
    total: moneyRef(row.amountPaise),
    status: row.status === InvoiceStatus.ISSUED ? "UNPAID" : row.status,
    dueDate: row.dueDate,
    pdfUrl: row.pdfUrl,
  };
}

export async function updateTenant(id, body, req) {
  if (body.expectedVersion == null) throw new AppError("VALIDATION_FAILED", "expectedVersion is required.", 422);
  const before = await Tenant.findById(id).select("-integrationSecrets").lean();
  const patch = {};
  if (body.businessName ?? body.name) patch.name = body.businessName ?? body.name;
  if (body.displayName) patch.displayName = body.displayName;
  if (body.ownerEmail ?? body.email) patch.email = body.ownerEmail ?? body.email;
  if (body.supportNumber) patch.supportNumber = body.supportNumber;
  if (body.gstin) patch.gstin = body.gstin;
  if (body.city || body.address) patch.address = { line1: body.address, city: body.city };
  if (body.tenantCode ?? body.code) {
    const tenant = await Tenant.findById(id).lean();
    if (tenant?.goLiveAt) throw new AppError("VALIDATION_FAILED", "Tenant code cannot be changed after go-live.", 422);
    patch.code = String(body.tenantCode ?? body.code).toUpperCase();
  }
  if (body.branding) patch.branding = body.branding;
  if (body.settings) patch.settings = body.settings;
  const expectedVersion = Number(body.expectedVersion);
  const row = await Tenant.findOneAndUpdate(
    { _id: id, version: expectedVersion },
    { $set: patch, $inc: { version: 1 } },
    { new: true },
  ).select("-integrationSecrets");
  if (!row) {
    if (await Tenant.exists({ _id: id })) {
      throw errors.conflict("VERSION_CONFLICT", "This tenant changed. Refresh and try again.");
    }
    throw errors.notFound("Tenant");
  }
  if (req) {
    await auditPlatformMutation({
      req,
      action: "PLATFORM_TENANT_UPDATED",
      entityType: AuditEntityType.TENANT,
      entityId: id,
      tenantId: id,
      before,
      after: row.toObject(),
    });
  }
  return tenantDetail(id);
}

export async function tenantUsage(id) {
  const tenant = await Tenant.findById(id).select("subscription").lean();
  if (!tenant) throw errors.notFound("Tenant");
  const limits = limitsToApi(tenant.subscription?.limits);
  const schemePlanFilter = {
    tenantId: id,
    status: { $in: [SchemePlanStatus.ACTIVE, SchemePlanStatus.INACTIVE] },
  };
  const [activeCustomers, branches, staff, schemePlanTemplates, whatsappUsed] = await Promise.all([
    Customer.countDocuments({ tenantId: id, status: "ACTIVE" }),
    Branch.countDocuments({ tenantId: id, active: true }),
    User.countDocuments({ tenantId: id, status: UserStatus.ACTIVE }),
    SchemePlan.countDocuments(schemePlanFilter),
    Message.countDocuments({ tenantId: id, createdAt: { $gte: dayjs().startOf("month").toDate() } }),
  ]);
  const mk = (used, limitKey) => ({
    used,
    limit: limits[limitKey] ?? null,
    percentage: usagePercent(used, limits[limitKey]),
    ...(limitKey === "whatsappMessagesPerMonth" ? { resetDate: dayjs().add(1, "month").startOf("month").format("YYYY-MM-DD") } : {}),
  });
  return {
    activeCustomers: mk(activeCustomers, "activeCustomers"),
    branches: mk(branches, "branches"),
    staff: mk(staff, "staffSeats"),
    schemePlans: mk(schemePlanTemplates, "schemePlans"),
    whatsappMessages: mk(whatsappUsed, "whatsappMessagesPerMonth"),
  };
}

export async function setOwnerCredentials(id, body, req) {
  const owner = await User.findOne({ tenantId: id, role: TenantRole.TENANT_OWNER });
  if (!owner) throw errors.notFound("Tenant owner");
  const parsedPassword = passwordPolicySchema.safeParse(
    body.temporaryPassword ?? generateTemporaryPassword(),
  );
  if (!parsedPassword.success) {
    throw errors.validation([
      { field: "temporaryPassword", message: PASSWORD_PIN_MESSAGE },
    ]);
  }
  const temporaryPassword = parsedPassword.data;
  owner.passwordHash = await argon2.hash(temporaryPassword, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  owner.mustSetPassword = true;
  await owner.save();
  if (req) {
    await auditPlatformMutation({
      req,
      action: "PLATFORM_OWNER_CREDENTIALS_RESET",
      entityType: AuditEntityType.STAFF,
      entityId: owner._id,
      tenantId: id,
      after: { ownerId: owner._id, mustSetPassword: true, mustChangePassword: true },
    });
  }
  return { ownerId: owner._id, temporaryPassword, mustSetPassword: true, mustChangePassword: true };
}

export async function setIntegration(id, kind, body, req) {
  const before = await Tenant.findById(id).select("+integrationSecrets").lean();
  const integrationKey = kind === "phonepe" ? "phonepe" : kind;
  if (kind === "fcm") {
    const existingBucket = before?.integrationSecrets?.fcm ?? {};
    const { invalidateFcmAuthCache } = await import("../lib/fcm-config.js");
    const value = {
      ...existingBucket,
      projectId: body.projectId ?? existingBucket.projectId,
      credentialVersion: body.serviceAccountJson !== undefined
        ? Number(existingBucket.credentialVersion ?? 0) + 1
        : Number(existingBucket.credentialVersion ?? 1),
      updatedAt: new Date(),
    };
    if (body.serviceAccountJson !== undefined) {
      value.serviceAccountJsonSealed = seal(
        typeof body.serviceAccountJson === "string"
          ? body.serviceAccountJson
          : JSON.stringify(body.serviceAccountJson),
      );
    }
    const row = await Tenant.findByIdAndUpdate(
      id,
      { $set: { "integrationSecrets.fcm": value }, $inc: { version: 1 } },
      { new: true },
    ).select("_id version");
    if (!row) throw errors.notFound("Tenant");
    invalidateFcmAuthCache(id);
    const after = await Tenant.findById(id).select("+integrationSecrets").lean();
    if (req) {
      await auditPlatformMutation({
        req,
        action: "PLATFORM_FCM_INTEGRATION_UPDATED",
        entityType: AuditEntityType.TENANT,
        entityId: id,
        tenantId: id,
        before: before?.integrationSecrets?.fcm,
        after: after?.integrationSecrets?.fcm,
      });
    }
    return {
      configured: Boolean(value.projectId && value.serviceAccountJsonSealed),
      projectId: value.projectId ?? null,
      credentialVersion: value.credentialVersion,
      version: row.version,
    };
  }
  const allowed = kind === "whatsapp"
    ? ["phoneNumberId", "businessAccountId", "accessToken", "appSecret", "verifyToken", "environment", "callbackUrlOverride"]
    : [
      "clientId",
      "clientSecret",
      "clientVersion",
      "webhookUsername",
      "webhookPassword",
      "environment",
      "provider",
    ];
  const existingBucket = before?.integrationSecrets?.[integrationKey] ?? {};
  const value = {
    ...existingBucket,
    provider: body.provider ?? existingBucket.provider ?? (kind === "whatsapp" ? "META_CLOUD" : "PHONEPE"),
  };
  const sealedKeys = new Set(["accessToken", "appSecret", "verifyToken", "clientSecret", "webhookPassword"]);
  for (const key of allowed) if (body[key] !== undefined) {
    value[key] = sealedKeys.has(key)
      ? (isSealedSecret(body[key]) ? body[key] : seal(body[key]))
      : key === "clientVersion"
        ? Number(body[key])
        : body[key];
  }
  if (
    integrationKey === "phonepe"
    && (body.clientSecret !== undefined
      || body.webhookPassword !== undefined
      || body.clientId !== undefined)
  ) {
    value.credentialVersion = Number(existingBucket.credentialVersion ?? 0) + 1;
  }
  const row = await Tenant.findByIdAndUpdate(id, { $set: { [`integrationSecrets.${integrationKey}`]: value }, $inc: { version: 1 } }, { new: true }).select("_id version");
  if (integrationKey === "phonepe") {
    const { invalidatePhonePeClientCache } = await import("../integrations/phonepe.provider.js");
    invalidatePhonePeClientCache(id);
  }
  if (!row) throw errors.notFound("Tenant");
  const after = await Tenant.findById(id).select("+integrationSecrets").lean();
  if (req) {
    await auditPlatformMutation({
      req,
      action: kind === "whatsapp" ? "PLATFORM_WHATSAPP_INTEGRATION_UPDATED" : "PLATFORM_PAYMENT_GATEWAY_UPDATED",
      entityType: AuditEntityType.TENANT,
      entityId: id,
      tenantId: id,
      before: before?.integrationSecrets,
      after: after?.integrationSecrets,
    });
  }
  return {
    configured: true,
    verificationStatus: "NOT_VERIFIED",
    version: row.version,
    ...(kind === "whatsapp"
      ? { provider: "META_CLOUD", phoneNumberDisplay: body.phoneNumberId, accessTokenMasked: maskSecret(body.accessToken) }
      : {
        provider: "PHONEPE",
        clientIdMasked: maskSecret(body.clientId ?? existingBucket.clientId),
        clientCredentialsConfigured: Boolean(
          (body.clientId ?? existingBucket.clientId)
            && (body.clientSecret ?? existingBucket.clientSecret),
        ),
        environment: body.environment ?? existingBucket.environment ?? "SANDBOX",
      }),
  };
}

export async function verifyIntegration(id, kind, body = {}, req) {
  const tenant = await Tenant.findById(id).select("+integrationSecrets");
  if (!tenant?.integrationSecrets?.[kind === "phonepe" ? "phonepe" : kind]) throw errors.notFound("Integration configuration");
  const bucket = kind === "phonepe" ? tenant.integrationSecrets.phonepe : tenant.integrationSecrets.whatsapp;
  if (kind === "phonepe") {
    if (!bucket.clientId || !bucket.clientSecret || bucket.clientVersion == null) {
      throw errors.business("INTEGRATION_INCOMPLETE", "The phonepe integration is incomplete.");
    }
    const { phonePeProvider, resolvePhonePeCredentials } = await import("../integrations/phonepe.provider.js");
    await phonePeProvider.verifyCredentials(resolvePhonePeCredentials(tenant), tenant._id);
  } else {
    const required = ["phoneNumberId", "accessToken", "appSecret"];
    if (required.some((key) => !bucket[key])) throw errors.business("INTEGRATION_INCOMPLETE", `The ${kind} integration is incomplete.`);
  }
  const before = tenant.toObject();
  bucket.verifiedAt = new Date();
  bucket.verificationStatus = "VERIFIED";
  await tenant.save();
  await auditPlatformMutation({ req, action: "TENANT_INTEGRATION_VERIFIED", entityType: AuditEntityType.TENANT, entityId: id, tenantId: id, before, after: tenant.toObject() });
  return {
    tenantId: id,
    integration: kind,
    verified: true,
    verificationStatus: "VERIFIED",
    verifiedAt: bucket.verifiedAt,
    ...(kind === "whatsapp" && body.testMobile ? { messageId: `wamid.mock.${Date.now()}`, deliveryStatus: "SENT", testMobile: body.testMobile } : {}),
  };
}

function mapTenantTemplateRegistration(row) {
  return {
    id: row._id,
    messageType: row.messageType,
    templateName: row.providerTemplateName ?? null,
    templateId: row.providerTemplateId ?? null,
    languageCode: row.language ?? "en",
    variableOrder: row.variables ?? [],
    buttonUrlVariableKey: row.buttonUrlVariableKey ?? null,
    approvalStatus: row.approvalStatus ?? null,
    notes: row.body ?? null,
    active: row.active !== false,
    version: row.version,
  };
}

export async function listTenantTemplates(id) {
  const rows = await TemplateDefinition.find({ tenantId: id }).sort({ messageType: 1 }).lean();
  return rows.map(mapTenantTemplateRegistration);
}

export async function deleteTenantTemplate(id, messageType, req) {
  const before = await TemplateDefinition.findOne({ tenantId: id, messageType }).lean();
  const result = await TemplateDefinition.deleteOne({ tenantId: id, messageType });
  if (before) await auditPlatformMutation({ req, action: "TENANT_TEMPLATE_DELETED", entityType: AuditEntityType.TEMPLATE, entityId: before._id, tenantId: id, before });
  return { deleted: result.deletedCount === 1 };
}

export async function testTenantTemplate(id, messageType, body) {
  const template = await TemplateDefinition.findOne({ tenantId: id, messageType, active: true }).lean();
  if (!template) throw errors.notFound("Template");
  const testMobile = body.testMobile ?? body.mobile;
  return { queued: true, testMobile, templateId: template._id, messageId: `wamid.mock.${Date.now()}` };
}

async function currentUsageForLimits(tenantId) {
  const [activeCustomers, branches, staff, schemePlans] = await Promise.all([
    Customer.countDocuments({ tenantId, status: "ACTIVE" }),
    Branch.countDocuments({ tenantId, active: true }),
    User.countDocuments({ tenantId, status: UserStatus.ACTIVE, type: UserType.TENANT_USER }),
    SchemePlan.countDocuments({ tenantId, status: SchemePlanStatus.ACTIVE }),
  ]);
  return { activeCustomers, branches, staffSeats: staff, schemePlans };
}

export async function changeSubscription(id, action, body, req) {
  const tenant = await Tenant.findById(id);
  if (!tenant) throw errors.notFound("Tenant");
  const before = tenant.toObject();
  if (action === "change-plan") {
    const planId = body.subscriptionPlanId ?? body.planId;
    const plan = await SubscriptionPlan.findById(planId).lean();
    if (!plan) throw errors.notFound("Subscription plan");
    const targetLimits = limitsToApi(plan.limits);
    const used = await currentUsageForLimits(id);
    const blocking = Object.entries(targetLimits)
      .filter(([, limit]) => limit != null)
      .map(([limitKey, targetLimit]) => {
        const key = limitKey === "staffSeats" ? "staffSeats" : limitKey === "branches" ? "branches" : limitKey;
        const usedValue = used[key] ?? used[limitKey];
        if (usedValue > targetLimit) return { limitKey, used: usedValue, targetLimit };
        return null;
      })
      .filter(Boolean);
    if (blocking.length) {
      throw new AppError("VALIDATION_FAILED", "Current usage exceeds the target plan's limits.", 422, blocking);
    }
    tenant.subscription.tier = plan.tier;
    tenant.subscription.limits = limitsFromApi(plan.limits);
    const billingCycle = body.billingCycle ?? tenant.subscription.billingCycle ?? BillingCycle.MONTHLY;
    assertPlanAllowsBillingCycle(plan, billingCycle);
    const patch = subscriptionPatchFromPlan(plan, {
      billingCycle,
      status: SubscriptionStatus.ACTIVE,
      existingSubscription: tenant.subscription?.toObject?.() ?? tenant.subscription,
    });
    Object.assign(tenant.subscription, patch);
    tenant.subscription.status = SubscriptionStatus.ACTIVE;
  } else if (action === "limits") {
    if (body.expectedVersion == null) throw new AppError("VALIDATION_FAILED", "expectedVersion is required.", 422);
    if (tenant.subscription.tier !== PlanTier.CUSTOM) {
      throw new AppError("VALIDATION_FAILED", "Limit overrides are only allowed for CUSTOM tier tenants.", 422);
    }
    tenant.subscription.limits = { ...limitsFromApi(tenant.subscription.limits?.toObject?.() ?? tenant.subscription.limits), ...limitsFromApi(body.limitOverrides ?? body.limits) };
    if (body.featureOverrides) tenant.subscription.featureOverrides = body.featureOverrides;
  } else if (action === "extend") {
    const extensionType = body.extensionType ?? SubscriptionExtensionType.SUBSCRIPTION;
    const days = body.days;
    if (!Number.isInteger(days) || days < 1) throw new AppError("VALIDATION_FAILED", "days must be a positive integer.", 422);
    if (extensionType === SubscriptionExtensionType.GRACE) {
      const base = tenant.subscription.graceEndsAt ?? tenant.subscription.renewsAt ?? new Date();
      tenant.subscription.graceEndsAt = dayjs(base).add(days, "day").toDate();
      tenant.subscription.status = SubscriptionStatus.GRACE;
    } else {
      const base = tenant.subscription.renewsAt ?? tenant.subscription.trialEndsAt ?? new Date();
      tenant.subscription.renewsAt = dayjs(base).add(days, "day").toDate();
    }
    if (body.reason) tenant.subscription.extensionReason = body.reason;
  } else if (action === "cancel") {
    tenant.subscription.status = SubscriptionStatus.CANCELLED;
    if (body.reason) tenant.subscription.cancelReason = body.reason;
  }
  tenant.version += 1;
  await tenant.save();
  if (req) {
    await auditPlatformMutation({
      req,
      action: `PLATFORM_SUBSCRIPTION_${action.replace(/-/g, "_").toUpperCase()}`,
      entityType: AuditEntityType.SUBSCRIPTION,
      entityId: id,
      tenantId: id,
      before: before.subscription,
      after: tenant.subscription?.toObject?.() ?? tenant.subscription,
    });
  }
  if (action === "extend") {
    return {
      status: tenant.subscription.status,
      currentPeriodEnd: tenant.subscription.renewsAt ? dayjs(tenant.subscription.renewsAt).format("YYYY-MM-DD") : null,
      graceEndsAt: tenant.subscription.graceEndsAt ?? null,
      extendedDays: body.days,
    };
  }
  if (action === "cancel") {
    return {
      status: tenant.subscription.status,
      cancelledAt: new Date().toISOString(),
      currentPeriodEnd: tenant.subscription.renewsAt ? dayjs(tenant.subscription.renewsAt).format("YYYY-MM-DD") : null,
      reason: tenant.subscription.cancelReason ?? null,
    };
  }
  if (action === "limits") {
    return {
      tier: tenant.subscription.tier,
      limitOverrides: limitsToApi(tenant.subscription.limits),
      featureOverrides: tenant.subscription.featureOverrides ?? {},
      version: tenant.version,
    };
  }
  return tenant.subscription.toObject();
}

export async function tenantFlags(id, flags, req) {
  if (flags === undefined) {
    const tenant = await Tenant.findById(id).select("featureFlags subscription").lean();
    if (!tenant) throw errors.notFound("Tenant");
    const stored = normalizeFeatureFlags(tenant.featureFlags);
    const effective = effectivePlatformFlags(tenant);
    return { flags: stored, effectiveFlags: effective };
  }
  const before = await Tenant.findById(id).select("featureFlags").lean();
  const normalized = normalizeFeatureFlags(flags);
  const row = await Tenant.findByIdAndUpdate(id, { $set: { featureFlags: normalized }, $inc: { version: 1 } }, { new: true }).select("featureFlags subscription version");
  if (!row) throw errors.notFound("Tenant");
  if (req) {
    await auditPlatformMutation({
      req,
      action: "PLATFORM_TENANT_FLAGS_UPDATED",
      entityType: AuditEntityType.TENANT,
      entityId: id,
      tenantId: id,
      before: before?.featureFlags,
      after: row.featureFlags,
    });
  }
  const stored = normalizeFeatureFlags(row.featureFlags);
  const effective = effectivePlatformFlags(row);
  return { flags: stored, effectiveFlags: effective, version: row.version };
}

function mapInvoice(row) {
  return {
    id: row._id,
    invoiceNumber: row.invoiceNumber,
    subtotal: moneyRef(row.subtotalPaise ?? row.amountPaise ?? 0),
    tax: moneyRef(row.taxPaise ?? 0),
    total: moneyRef(row.amountPaise ?? 0),
    status: row.status === InvoiceStatus.ISSUED ? "UNPAID" : row.status,
    dueDate: row.dueDate,
    pdfUrl: row.pdfUrl ?? null,
    paidAt: row.paidAt ?? null,
  };
}

export async function listInvoices(id) {
  const rows = await Invoice.find({ tenantId: id }).sort({ createdAt: -1 }).lean();
  return rows.map(mapInvoice);
}

export async function markInvoicePaid(invoiceId, body, req) {
  const before = await Invoice.findById(invoiceId).lean();
  const row = await Invoice.findByIdAndUpdate(invoiceId, { $set: { status: InvoiceStatus.PAID, paidAt: body.paidAt ?? new Date(), reference: body.reference }, $inc: { version: 1 } }, { new: true });
  if (!row) throw errors.notFound("Invoice");
  if (req) {
    await auditPlatformMutation({
      req,
      action: "PLATFORM_INVOICE_PAID",
      entityType: AuditEntityType.INVOICE,
      entityId: invoiceId,
      tenantId: row.tenantId,
      before,
      after: row.toObject(),
    });
  }
  return mapInvoice(row.toObject());
}

function mapWebhookFailure(row) {
  return {
    id: row._id,
    tenantId: row.tenantId ?? null,
    provider: row.provider,
    providerEventId: row.providerEventId,
    status: row.status,
    attempts: row.attempts ?? 0,
    lastError: row.error ?? null,
    traceId: row.payload?.traceId ?? null,
    retryEligible: ["FAILED", "SIGNATURE_FAILED"].includes(row.status),
    payloadReference: row.providerEventId,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    processedAt: row.processedAt instanceof Date ? row.processedAt.toISOString() : row.processedAt ?? null,
  };
}

const webhookFailureStatuses = ["FAILED", "SIGNATURE_FAILED", "DEAD_LETTER"];

function webhookFailureFilters(query = {}) {
  const provider = query.provider;
  return {
    status: { $in: webhookFailureStatuses },
    ...(provider && provider !== "ALL" ? { provider } : {}),
  };
}

export async function webhookFailures(req) {
  const filters = webhookFailureFilters(req.query);
  const [total, page] = await Promise.all([
    WebhookEvent.countDocuments(filters),
    paginate(WebhookEvent, {
      filters,
      cursor: req.query.cursor,
      limit: req.query.limit,
      sort: "createdAt:desc",
    }),
  ]);
  page.data = page.data.map(mapWebhookFailure);
  page.meta.total = total;
  return page;
}

function mapErrorLog(row) {
  return {
    id: row._id,
    code: row.code ?? "UNKNOWN",
    message: row.message ?? "",
    statusCode: row.statusCode ?? 500,
    traceId: row.traceId ?? "",
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
    tenantId: row.tenantId ?? null,
  };
}

export async function listErrorLogs(req) {
  const filter = {};
  if (req.query.tenantId) filter.tenantId = req.query.tenantId;
  if (req.query.traceId) filter.traceId = req.query.traceId;
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 500);
  const [total, rows] = await Promise.all([
    ErrorLog.countDocuments(filter),
    ErrorLog.find(filter).sort({ occurredAt: -1 }).limit(limit).lean(),
  ]);
  return { data: rows.map(mapErrorLog), meta: { total, limit } };
}

export async function platformChart(key) {
  if (key === "tenant-growth") {
    const rows = await Tenant.aggregate([
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, value: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    return chartSeries({
      chartType: "line",
      title: "Tenant growth",
      yAxis: { type: "count", label: "Tenants", unit: "count" },
      series: [{ key: "TENANTS", name: "New tenants", data: rows.map((row) => ({ x: row._id, y: row.value, yDisplay: String(row.value) })) }],
    });
  }
  if (key === "tier-distribution" || key === "subscription-distribution") {
    const rows = await Tenant.aggregate([{ $group: { _id: "$subscription.tier", value: { $sum: 1 } } }]);
    return chartSeries({
      chartType: "donut",
      title: "Tenants by tier",
      yAxis: { type: "count", label: "Tenants", unit: "count" },
      series: [{ key: "TIER", name: "Tenants", data: rows.map((row) => ({ x: row._id ?? "UNKNOWN", y: row.value, yDisplay: String(row.value) })) }],
    });
  }
  if (key === "mrr-trend" || key === "revenue") {
    const rows = await Invoice.aggregate([
      { $match: { status: InvoiceStatus.PAID } },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$paidAt" } }, value: { $sum: "$amountPaise" } } },
      { $sort: { _id: 1 } },
    ]);
    return chartSeries({
      chartType: "line",
      title: "MRR trend",
      yAxis: { type: "currency", label: "Amount", unit: "INR" },
      series: [{ key: "MRR", name: "MRR", data: rows.map((row) => ({ x: row._id, y: row.value, yDisplay: moneyRef(row.value).amountDisplay })) }],
    });
  }
  if (key === "platform-collection-volume") {
    const rows = await Invoice.aggregate([
      { $match: { status: InvoiceStatus.PAID } },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$paidAt" } }, value: { $sum: "$amountPaise" } } },
      { $sort: { _id: 1 } },
    ]);
    return chartSeries({
      chartType: "line",
      title: "Platform collection volume",
      yAxis: { type: "currency", label: "Amount", unit: "INR" },
      series: [{ key: "COLLECTED", name: "Collected", data: rows.map((row) => ({ x: row._id, y: row.value, yDisplay: moneyRef(row.value).amountDisplay })) }],
    });
  }
  if (key === "whatsapp-volume") {
    const rows = await Message.aggregate([
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, value: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    return chartSeries({
      chartType: "line",
      title: "WhatsApp volume",
      yAxis: { type: "count", label: "Messages", unit: "count" },
      series: [{ key: "WHATSAPP", name: "Messages", data: rows.map((row) => ({ x: row._id, y: row.value, yDisplay: String(row.value) })) }],
    });
  }
  throw new AppError("NOT_FOUND", "Unknown chart key.", 404);
}

export async function listAuditLogs(req) {
  const filters = {};
  if (req.query.tenantId) filters.tenantId = req.query.tenantId;
  if (req.query.actorId) filters.actorId = req.query.actorId;
  if (req.query.action) {
    const action = String(req.query.action).trim();
    if (action) {
      filters.action = { $regex: escaped(action), $options: "i" };
    }
  }
  if (req.query.entityType) filters.entityType = req.query.entityType;
  if (req.query.entityId) filters.entityId = req.query.entityId;
  if (req.query.from || req.query.to) {
    filters.occurredAt = {};
    if (req.query.from) filters.occurredAt.$gte = new Date(req.query.from);
    if (req.query.to) filters.occurredAt.$lte = new Date(req.query.to);
  }
  const page = await paginate(AuditEvent, { filters, cursor: req.query.cursor, limit: req.query.limit, sort: "occurredAt:desc" });
  page.data = page.data.map((row) => ({
    id: row._id,
    at: row.occurredAt,
    actor: row.actorId ? { id: row.actorId, type: row.actorType } : { type: row.actorType },
    tenant: row.tenantId ? { id: row.tenantId } : null,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    changes: row.metadata?.changes ?? [],
    ip: row.ip ?? null,
    traceId: row.traceId ?? null,
  }));
  return page;
}

export async function getAppConfig() {
  const row = await PlatformSettings.findById("global").lean();
  return row?.appConfig ?? DEFAULT_APP_CONFIG;
}

export async function updateAppConfig(body, req) {
  const before = await getAppConfig();
  const next = {
    android: { ...before.android, ...(body.android ?? {}) },
    ios: { ...before.ios, ...(body.ios ?? {}) },
    maintenance: { ...before.maintenance, ...(body.maintenance ?? {}) },
  };
  await PlatformSettings.findOneAndUpdate(
    { _id: "global" },
    { $set: { appConfig: next }, $inc: { version: 1 } },
    { upsert: true },
  );
  if (req) {
    await auditPlatformMutation({
      req,
      action: "PLATFORM_APP_CONFIG_UPDATED",
      entityType: AuditEntityType.TENANT,
      entityId: "global",
      tenantId: "platform",
      before,
      after: next,
    });
  }
  return next;
}
