import { env } from "../config/env.js";
import { AppError } from "../lib/app-error.js";
import { resolveTenantCheckoutMode } from "./demo-policy.js";

/** @typedef {"LIVE_REQUIRED" | "MOCK_PROVIDER" | "DIGITAL_METALS_DEMO" | "TENANT_DEMO"} DigitalMetalsCheckoutMode */

/**
 * Central policy for digital-metals PhonePe checkout (buy + redemption charge).
 * Production always requires live provider credentials; demo never inferred from NODE_ENV alone.
 *
 * `tenant` is optional and additive: every existing call site that omits it gets exactly the
 * previous NODE_ENV/PROVIDER_MODE-derived behaviour, unchanged. Passing a platform-created
 * demo tenant (plan section 4.1 `isDemo`) makes this resolve to "TENANT_DEMO" regardless of
 * NODE_ENV, including in production, which is the one case the plan explicitly wants
 * (plan section 6.3 / 16: "Production may simulate for a platform-created demo tenant only").
 * That is distinct from the pre-existing "DIGITAL_METALS_DEMO" mode below, which is a
 * developer/local convenience keyed off env vars and still only available outside production.
 *
 * NOT YET WIRED: no caller of resolveDigitalMetalsCheckoutMode() in this codebase passes a
 * tenant yet (see digital-metals-checkout-init.js and its ~4 current call sites). Threading
 * the tenant through those call sites, persisting checkoutMode=TENANT_DEMO on attempts, and
 * doing the ecommerce-side equivalent is phase 3/6.3 work, not part of this foundation pass.
 *
 * @param {{ isDemo?: boolean } | null | undefined} [tenant]
 * @returns {DigitalMetalsCheckoutMode}
 */
export function resolveDigitalMetalsCheckoutMode(tenant) {
  const tenantDemoMode = resolveTenantCheckoutMode(tenant);
  if (tenantDemoMode) return tenantDemoMode;
  if (env.NODE_ENV === "production") return "LIVE_REQUIRED";
  const explicit = process.env.DIGITAL_METALS_CHECKOUT_MODE?.trim();
  const raw = String(explicit ?? (env.PROVIDER_MODE === "mock" ? "mock" : "demo")).toLowerCase();
  if (raw === "live") return "LIVE_REQUIRED";
  if (raw === "demo") return "DIGITAL_METALS_DEMO";
  if (raw === "mock" || raw === "mock_provider") return "MOCK_PROVIDER";
  if (explicit) {
    throw new AppError(
      "CHECKOUT_MODE_INVALID",
      `Unknown DIGITAL_METALS_CHECKOUT_MODE "${raw}". Use demo, mock, or live.`,
      422,
    );
  }
  return "DIGITAL_METALS_DEMO";
}

export function assertPhonePeCredentialsForLiveCheckout(credentials) {
  if (credentials?.clientId && credentials?.clientSecret) return;
  throw new AppError(
    "PHONEPE_NOT_CONFIGURED",
    "Live PhonePe checkout is required but tenant credentials are missing. Configure PhonePe in tenant settings or set DIGITAL_METALS_CHECKOUT_MODE=demo for local demo checkout.",
    422,
  );
}

export function isPersistedMockCheckoutMode(checkoutMode) {
  return (
    checkoutMode === "MOCK_PROVIDER" ||
    checkoutMode === "DIGITAL_METALS_DEMO" ||
    checkoutMode === "TENANT_DEMO"
  );
}

export function paymentIntentCheckoutLabel(checkoutMode) {
  if (checkoutMode === "DIGITAL_METALS_DEMO") return "Demo checkout (simulated success on poll)";
  if (checkoutMode === "TENANT_DEMO") return "Demo checkout (simulated outcome)";
  if (checkoutMode === "MOCK_PROVIDER") return "Mock provider checkout";
  if (checkoutMode === "LIVE") return "Live PhonePe checkout";
  return null;
}

/** Demo-only: auto-activate bank destinations on create (never on list GET). */
export function digitalMetalsDemoBankAutoVerifyOnCreate() {
  if (env.NODE_ENV === "production") return false;
  return String(process.env.DIGITAL_METALS_DEMO_BANK_VERIFY ?? "").toLowerCase() === "true";
}

export function assertProductionRejectsDemoCheckoutSimulation() {
  if (env.NODE_ENV !== "production") return;
  if (env.PROVIDER_MODE === "mock") {
    throw new AppError(
      "PROVIDER_MODE_INVALID",
      "PROVIDER_MODE=mock is not allowed in production.",
      500,
    );
  }
}
