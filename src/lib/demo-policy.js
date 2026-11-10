import { env } from "../config/env.js";
import { DemoCheckoutMode, DemoInstanceStatus } from "../constants/enums.js";

/**
 * Single trusted source of Demo Builder policy (plan section 6, opening paragraph).
 *
 * Every predicate here reads server-owned tenant/instance/generation state passed in by the
 * caller (a Mongoose document or lean object already loaded from the database in this
 * request/job) and returns a plain value. Nothing here reads query strings, headers, posted
 * body fields, or NODE_ENV/PROVIDER_MODE to decide demo behaviour — those are exactly the
 * shortcuts the plan calls out as unsuitable (plan section 2, "digital-metal demo checkout
 * policy forces live checkout in production" row) and this module exists to replace, not
 * add to, them.
 *
 * Phase 1/2 scope: this module is the policy surface new code should be written against.
 * It is deliberately NOT yet called from auth.middleware.js, the payment services, or the
 * workers/schedulers — wiring each call site is phase 2/3/6 work (see
 * docs/demo-builder-phase-1-2-foundation.md for the exact list), because each of those call
 * sites needs its own review, not a blanket "if isDemo, skip checks" patch.
 */

/** @param {{ isDemo?: boolean } | null | undefined} tenant */
export function isDemoTenant(tenant) {
  return Boolean(tenant?.isDemo);
}

/** @param {{ status?: string } | null | undefined} instance */
export function isInstanceAccessible(instance) {
  return instance?.status === DemoInstanceStatus.READY;
}

/**
 * The checkout mode a tenant-aware payment adapter should use, or null to mean "this is not
 * a demo tenant — fall back to whatever policy already governs this checkout path."
 * Returning null (rather than LIVE_REQUIRED) keeps this module purely additive: existing
 * non-demo behaviour in digital-metals-demo-policy.js and the (not-yet-built) ecommerce
 * equivalent is unchanged by this function's existence.
 *
 * @param {{ isDemo?: boolean } | null | undefined} tenant
 * @returns {import("../constants/enums.js").DemoCheckoutMode | null}
 */
export function resolveTenantCheckoutMode(tenant) {
  if (!isDemoTenant(tenant)) return null;
  if (!env.TENANT_DEMO_SIMULATION_ENABLED) return null;
  return DemoCheckoutMode.TENANT_DEMO;
}

/**
 * True when a tenant must never reach an external provider (PhonePe collection/refund,
 * bank verification/payout, procurement/hedging, shipping/courier, WhatsApp, SMS/OTP, email,
 * FCM — plan section 6.3). Workers and schedulers must call this with a freshly re-read
 * tenant immediately before any outbound call, not with a tenant loaded earlier in the same
 * job run, because an already-queued job can outlive a reset or disable (plan section 6.3,
 * "Re-read current server state when processing queued work").
 *
 * @param {{ isDemo?: boolean } | null | undefined} tenant
 */
export function mustBlockExternalDispatch(tenant) {
  return isDemoTenant(tenant);
}

/** Default/maximum expiry windows, read from env rather than hardcoded so ops can tune them. */
export function demoExpiryPolicy() {
  return {
    defaultDays: env.DEMO_DEFAULT_EXPIRY_DAYS,
    maxDays: env.DEMO_MAX_EXPIRY_DAYS,
    purgeRetentionDays: env.DEMO_PURGE_RETENTION_DAYS,
  };
}

export function demoBuilderEnabled() {
  return env.DEMO_BUILDER_ENABLED;
}

export function demoPublicEntryEnabled() {
  return env.DEMO_PUBLIC_ENTRY_ENABLED;
}

export function maxActiveDemoInstances() {
  return env.DEMO_MAX_ACTIVE_INSTANCES;
}

/**
 * Fields that must never be settable through any public/customer/ordinary tenant or
 * customer update schema (plan section 4.1). Every z.object(...).strict() validator in
 * src/validators already rejects unknown keys by convention — this list exists so that
 * convention is a documented, checkable contract rather than an implicit assumption. Add a
 * test asserting none of these appear in platformUpdateTenantBody's live-tenant-facing
 * siblings (customer/self-service update bodies) once those are touched.
 */
export const DEMO_TENANT_RESTRICTED_FIELDS = Object.freeze([
  "isDemo",
  "demoInstanceId",
  "demoGenerationId",
  "demoTemplateVersionId",
]);
export const DEMO_CUSTOMER_RESTRICTED_FIELDS = Object.freeze(["isDemo"]);
export const DEMO_SESSION_RESTRICTED_FIELDS = Object.freeze([
  "demoSession",
  "demoInstanceId",
  "demoGenerationId",
  "demoLinkVersion",
]);
