import { env } from "../config/env.js";
import { Tenant } from "../models/index.js";

/** Fixed OTP for Google Play / internal app review when tenant flag is enabled (not for go-live jewellery). */
export const PLAYSTORE_REVIEW_OTP_CODE = "123456";

/** Staging / Play Store review only — never true in production boot. */
export function playStoreReviewOtpAllowAfterGoLive(source = env) {
  return source.PLAYSTORE_REVIEW_OTP_ALLOW_AFTER_GO_LIVE === true;
}

/** @param {{ isDemo?: boolean, goLiveAt?: Date | null, operations?: { playStoreReviewOtpEnabled?: boolean } } | null | undefined} tenant */
export function playStoreReviewOtpEligible(tenant, source = env) {
  if (tenant?.operations?.playStoreReviewOtpEnabled !== true) return false;
  if (
    tenant.goLiveAt
    && tenant.isDemo !== true
    && !playStoreReviewOtpAllowAfterGoLive(source)
  ) {
    return false;
  }
  return true;
}

/**
 * @param {string | null | undefined} tenantId
 * @param {{ tenant?: Record<string, unknown> | null }} [deps]
 */
export async function playStoreReviewOtpEligibleForTenant(tenantId, deps = {}) {
  if (!tenantId) return false;
  const source = deps.env ?? env;
  const tenant = deps.tenant
    ?? await Tenant.findById(tenantId)
      .select("isDemo goLiveAt operations.playStoreReviewOtpEnabled")
      .lean();
  return playStoreReviewOtpEligible(tenant, source);
}

/**
 * @param {string} otpPlain
 * @param {{ otpLength?: number } | null | undefined} record
 */
export function isPlayStoreReviewOtpSubmission(otpPlain, record) {
  const code = String(otpPlain ?? "").trim();
  if (code !== PLAYSTORE_REVIEW_OTP_CODE) return false;
  const expectedLength = Number(record?.otpLength ?? 6);
  return new RegExp(`^\\d{${expectedLength}}$`).test(code);
}