import { env } from "../config/env.js";

/**
 * Per-checkout ceiling for PhonePe (especially sandbox test merchants, often ₹5,000).
 * Override with PHONEPE_CHECKOUT_MAX_PAISE; set 0 to disable clamping.
 */
export function phonePeCheckoutMaxPaise(phonePeEnvironment = env.PHONEPE_ENV) {
  const raw = process.env.PHONEPE_CHECKOUT_MAX_PAISE?.trim();
  if (raw === "0") return null;
  if (raw) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (phonePeEnvironment === "PRODUCTION") return null;
  if (phonePeEnvironment === "SANDBOX" || env.PHONEPE_ENV === "SANDBOX") {
    return 500_000;
  }
  return null;
}

/** Lowers maxPayablePaise so customer UI + validation match PhonePe acceptance. */
export function clampPayableQuoteToPhonePe(quote, phonePeEnvironment) {
  if (!quote) return quote;
  const cap = phonePeCheckoutMaxPaise(phonePeEnvironment);
  if (!cap) return quote;
  const prevMax = quote.maxPayablePaise ?? 0;
  if (prevMax <= cap) return quote;
  const nextMax = cap;
  const nextRemaining =
    quote.remainingPaise != null ? Math.min(quote.remainingPaise, cap) : nextMax;
  return {
    ...quote,
    maxPayablePaise: nextMax,
    remainingPaise: nextRemaining,
    remainingPayablePaise: Math.min(quote.remainingPayablePaise ?? nextMax, cap),
    gatewayCheckoutMaxPaise: cap,
    gatewayCheckoutMaxReason: "PHONEPE_CHECKOUT_CEILING",
  };
}