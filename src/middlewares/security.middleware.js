import rateLimit from "express-rate-limit";

export const publicRateLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
export const otpRateLimit = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, error: { code: "RATE_LIMITED", message: "Too many OTP requests. Please try again later." } } });
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many sign-in attempts. Please wait a few minutes and try again.",
    },
  },
});
export const tenantResolveRateLimit = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, error: { code: "RATE_LIMITED", message: "Too many tenant resolve requests. Please try again later." } } });
