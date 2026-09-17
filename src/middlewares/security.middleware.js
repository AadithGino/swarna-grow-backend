import rateLimit, { ipKeyGenerator, MemoryStore } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { env } from "../config/env.js";
import { getRedis, redisReady } from "../config/redis.js";

const skipRateLimit = () => !env.RATE_LIMIT_ENABLED;

function otpRateLimitKey(prefix, req) {
  const ip = ipKeyGenerator(req.ip ?? "127.0.0.1");
  const mobile = String(req.body?.mobile ?? "").trim();
  return `${prefix}:${ip}:${mobile}`;
}

// Limiters are constructed at module load before connectRedis() runs; pick the store per request.
class RedisOrMemoryStore {
  constructor(prefix) {
    this.memory = new MemoryStore();
    this.redis = new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (command, ...args) => getRedis().call(command, ...args),
    });
  }
  init(options) {
    this.memory.init(options);
    return this.redis.init(options);
  }
  increment(key) {
    if (redisReady()) return this.redis.increment(key);
    if (env.NODE_ENV === "production") return Promise.reject(new Error("RATE_LIMIT_STORE_UNAVAILABLE"));
    return this.memory.increment(key);
  }
  decrement(key) {
    if (redisReady()) return this.redis.decrement(key);
    if (env.NODE_ENV === "production") return Promise.reject(new Error("RATE_LIMIT_STORE_UNAVAILABLE"));
    return this.memory.decrement(key);
  }
  resetKey(key) {
    if (redisReady()) return this.redis.resetKey(key);
    if (env.NODE_ENV === "production") return Promise.reject(new Error("RATE_LIMIT_STORE_UNAVAILABLE"));
    return this.memory.resetKey(key);
  }
}

function sharedStore(prefix) {
  return new RedisOrMemoryStore(prefix);
}

export const publicRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: skipRateLimit,
  store: sharedStore("public"),
});

/** Send OTP — keyed per IP + mobile so verify attempts do not consume this bucket. */
export const otpRequestRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: skipRateLimit,
  keyGenerator: (req) => otpRateLimitKey("otp:req", req),
  store: sharedStore("otp-req"),
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
  skip: skipRateLimit,
  keyGenerator: (req) => otpRateLimitKey("otp:verify", req),
  store: sharedStore("otp-verify"),
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
  skip: skipRateLimit,
  store: sharedStore("login"),
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
  skip: skipRateLimit,
  store: sharedStore("tenant-resolve"),
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many tenant resolve requests. Please try again later.",
    },
  },
});
