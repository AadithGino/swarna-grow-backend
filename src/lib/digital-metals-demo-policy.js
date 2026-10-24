import { env } from "../config/env.js";
import { AppError } from "../lib/app-error.js";

/** @typedef {"LIVE_REQUIRED" | "MOCK_PROVIDER" | "DIGITAL_METALS_DEMO"} DigitalMetalsCheckoutMode */

/**
 * Central policy for digital-metals PhonePe checkout (buy + redemption charge).
 * Production always requires live provider credentials; demo never inferred from NODE_ENV alone.
 * @returns {DigitalMetalsCheckoutMode}
 */
export function resolveDigitalMetalsCheckoutMode() {
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
  return checkoutMode === "MOCK_PROVIDER" || checkoutMode === "DIGITAL_METALS_DEMO";
}

export function paymentIntentCheckoutLabel(checkoutMode) {
  if (checkoutMode === "DIGITAL_METALS_DEMO") return "Demo checkout (simulated success on poll)";
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
