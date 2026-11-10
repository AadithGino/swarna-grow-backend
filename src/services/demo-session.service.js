import { Customer, DemoEvent, DemoInstance, Tenant } from "../models/index.js";
import { AppError, errors } from "../lib/app-error.js";
import { sha256, timingSafeEqual } from "../lib/crypto.js";
import { assertInstancePubliclyAccessible } from "../lib/demo-session-guard.js";
import { demoPublicEntryEnabled } from "../lib/demo-policy.js";
import { issueSession } from "./token.service.js";
import { tenantBrandingDto } from "../lib/customer-app-dto.js";
import { DemoEventType, DemoInstanceStatus, UserType } from "../constants/enums.js";

/**
 * Public, pre-authentication Demo Builder endpoints (plan section 6.2): branding for the
 * splash screen, and exchanging a demo link's secret for a real customer session on the
 * provisioned demo tenant. Everything here is reachable without any existing session —
 * guard every lookup accordingly (no stack traces, no enumerable link-not-found vs
 * wrong-secret distinction beyond what's already implied by the instance being public).
 */

function publicInstanceDto(instance, tenant) {
  const branding = instance.branding ?? {};
  const base = tenant
    ? tenantBrandingDto(tenant)
    : {
        displayName: branding.displayName ?? instance.prospectName,
        logoUrl: branding.logoUploadId ? `/uploads/${branding.logoUploadId}` : null,
        primaryColor: branding.primaryColor ?? "#730321",
        accentColor: branding.accentColor ?? "#C9A227",
      };
  return {
    ...base,
    status: instance.status,
    splashBackgroundColor: branding.splashBackgroundColor ?? null,
    splashTagline: branding.splashTagline ?? null,
    splashEnabled: branding.splashEnabled !== false,
  };
}

function assertPublicEntryEnabled() {
  if (!demoPublicEntryEnabled()) {
    throw new AppError("DEMO_PUBLIC_ENTRY_DISABLED", "Demo links are temporarily disabled.", 503);
  }
}

export async function getPublicBranding(publicId) {
  assertPublicEntryEnabled();
  const instance = await DemoInstance.findOne({ publicId }).lean();
  if (!instance) throw new AppError("DEMO_LINK_INVALID", "This demo link is not valid.", 410);
  const tenant = instance.activeTenantId ? await Tenant.findById(instance.activeTenantId).lean() : null;
  return publicInstanceDto(instance, tenant);
}

export async function exchangeSession({ publicId, secret, device, request }) {
  assertPublicEntryEnabled();
  const instance = await DemoInstance.findOne({ publicId }).select("+linkSecretHash").lean();
  if (!instance) throw new AppError("DEMO_LINK_INVALID", "This demo link is not valid.", 410);

  assertInstancePubliclyAccessible(instance);

  const providedHash = sha256(String(secret ?? ""));
  if (!timingSafeEqual(providedHash, instance.linkSecretHash)) {
    throw new AppError("DEMO_LINK_INVALID", "This demo link is not valid.", 401);
  }

  const customer = await Customer.findOne({ tenantId: instance.activeTenantId, isDemo: true })
    .sort({ createdAt: 1 })
    .lean();
  if (!customer) {
    // Should not happen — publishTemplateVersion refuses to publish a version with zero
    // customers — but guarded rather than assumed, since this runs with no session context.
    throw new AppError("DEMO_NO_SAMPLE_CUSTOMER", "This demo has no sample customer to sign in as.", 500);
  }

  const subject = {
    id: customer._id,
    type: UserType.CUSTOMER,
    tenantId: instance.activeTenantId,
    branchId: customer.branchId ?? null,
    role: "CUSTOMER",
    permissions: [],
    mobileClient: true,
    demoSession: true,
    demoInstanceId: instance._id,
    demoGenerationId: instance.activeGenerationId,
    demoLinkVersion: instance.linkVersion,
  };

  // Session.deviceId is required — same pattern as platform/customer web login defaults.
  const tokens = await issueSession(
    subject,
    {
      deviceId: device?.deviceId || "demo-web",
      platform: device?.platform || "web",
      appVersion: device?.appVersion || "demo-entry",
    },
    request,
  );

  await DemoInstance.findByIdAndUpdate(instance._id, { $set: { lastOpenedAt: new Date() } });
  await DemoEvent.create({
    instanceId: instance._id,
    type: DemoEventType.INSTANCE_OPENED,
    sessionId: tokens.sessionId,
    metadata: { customerId: customer._id },
  });

  const tenant = await Tenant.findById(instance.activeTenantId).lean();
  return {
    ...tokens,
    tenant: { id: instance.activeTenantId, ...publicInstanceDto(instance, tenant) },
    customer: { id: customer._id, name: customer.name, customerNumber: customer.customerNumber },
  };
}

/**
 * Used by the authenticated `/app/demo/context` endpoint, so a signed-in demo client can show
 * a persistent "you are viewing a demo" banner/expiry. Takes `req.tenant` (already loaded by
 * authenticate() for every request) rather than JWT claims directly — req.tenant.demoInstanceId
 * is already there on any demo tenant, so this needs no change to auth.middleware.js's claims.
 */
export async function getDemoContextForSession(tenant) {
  if (!tenant?.isDemo || !tenant.demoInstanceId) {
    throw new AppError("NOT_A_DEMO_SESSION", "This session is not a Demo Builder session.", 409);
  }
  const instance = await DemoInstance.findById(tenant.demoInstanceId).lean();
  if (!instance) throw errors.notFound("Demo instance");
  return {
    prospectName: instance.prospectName,
    status: instance.status,
    expiresAt: instance.expiresAt,
    isExpired: instance.status === DemoInstanceStatus.EXPIRED || new Date(instance.expiresAt).getTime() <= Date.now(),
  };
}
