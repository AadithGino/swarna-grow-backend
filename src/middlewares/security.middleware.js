import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";

const skipRateLimitInLocal = () =>
  env.NODE_ENV === "development" || env.NODE_ENV === "test";

function otpRateLimitKey(prefix, req) {
  const ip = ipKeyGenerator(req.ip ?? "127.0.0.1");
  const mobile = String(req.body?.mobile ?? "").trim();
  return `${prefix}:${ip}:${mobile}`;
}

export const publicRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: skipRateLimitInLocal,
});

/** Send OTP — keyed per IP + mobile so verify attempts do not consume this bucket. */
export const otpRequestRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: skipRateLimitInLocal,
  keyGenerator: (req) => otpRateLimitKey("otp:req", req),
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many OTP requests. Please try again later.",
    },
  },
});

/** Verify OTP — separate bucket; provider still enforces max wrong attempts per otpId. */
export const otpVerifyRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: skipRateLimitInLocal,
  keyGenerator: (req) => otpRateLimitKey("otp:verify", req),
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many OTP verification attempts. Please try again later.",
    },
  },
});

/** @deprecated Use otpRequestRateLimit */
export const otpRateLimit = otpRequestRateLimit;
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
export const tenantResolveRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: skipRateLimitInLocal,
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many tenant resolve requests. Please try again later.",
    },
  },
});
