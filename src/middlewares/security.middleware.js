import rateLimit, { ipKeyGenerator, MemoryStore } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { env } from "../config/env.js";
import { getRedis, redisReady } from "../config/redis.js";

const PUBLIC_DEDICATED_LIMITER_PATHS = new Set([
  "/auth/otp/request",
  "/auth/otp/verify",
  "/auth/login-password",
  "/tenants/resolve",
]);

function otpRateLimitKey(prefix, req) {
  const ip = ipKeyGenerator(req.ip ?? "127.0.0.1");
  const mobile = String(req.body?.mobile ?? "").trim();
  return `${prefix}:${ip}:${mobile}`;
}

const testRateLimitIntervals = new Set();
const registeredRateLimitStores = new Set();

/** Stops rate-limit window sweeps and pending Redis store inits for clean test exit. */
export async function clearRateLimitStoresForTests() {
  for (const interval of testRateLimitIntervals) clearInterval(interval);
  testRateLimitIntervals.clear();
  await Promise.all(
    [...registeredRateLimitStores].map((store) => store.shutdownForTests()),
  );
}

// Limiters are constructed at module load before connectRedis() runs; pick the store per request.
class RedisOrMemoryStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.memory = new MemoryStore();
    this.redis = null;
    this.redisInitPromise = null;
    this.rateLimitOptions = null;
    registeredRateLimitStores.add(this);
  }

  ensureRedisStore() {
    if (!this.redis) {
      this.redis = new RedisStore({
        prefix: `rl:${this.prefix}:`,
        sendCommand: (command, ...args) => getRedis().call(command, ...args),
      });
    }
    return this.redis;
  }

  init(options) {
    this.rateLimitOptions = options;
    this.memory.init(options);
    if (this.memory.interval) testRateLimitIntervals.add(this.memory.interval);
    if (redisReady()) {
      this.redisInitPromise = this.ensureRedisStore().init(options);
      return this.redisInitPromise;
    }
    return Promise.resolve();
  }

  async ensureRedisReadyForOps() {
    if (!redisReady()) return false;
    if (!this.redisInitPromise && this.rateLimitOptions) {
      this.redisInitPromise = this.ensureRedisStore().init(this.rateLimitOptions);
    }
    if (this.redisInitPromise) {
      try {
        await this.redisInitPromise;
      } catch {
        return false;
      }
    }
    return Boolean(this.redis);
  }

  increment(key) {
    if (redisReady()) {
      const run = async () => {
        const ok = await this.ensureRedisReadyForOps();
        if (!ok) {
          if (env.NODE_ENV === "production") throw new Error("RATE_LIMIT_STORE_UNAVAILABLE");
          return this.memory.increment(key);
        }
        return this.ensureRedisStore().increment(key);
      };
      return run();
    }
    if (env.NODE_ENV === "production") return Promise.reject(new Error("RATE_LIMIT_STORE_UNAVAILABLE"));
    return this.memory.increment(key);
  }

  decrement(key) {
    if (redisReady()) {
      const run = async () => {
        const ok = await this.ensureRedisReadyForOps();
        if (!ok) {
          if (env.NODE_ENV === "production") throw new Error("RATE_LIMIT_STORE_UNAVAILABLE");
          return this.memory.decrement(key);
        }
        return this.ensureRedisStore().decrement(key);
      };
      return run();
    }
    if (env.NODE_ENV === "production") return Promise.reject(new Error("RATE_LIMIT_STORE_UNAVAILABLE"));
    return this.memory.decrement(key);
  }

  resetKey(key) {
    if (redisReady()) {
      const run = async () => {
        const ok = await this.ensureRedisReadyForOps();
        if (!ok) {
          if (env.NODE_ENV === "production") throw new Error("RATE_LIMIT_STORE_UNAVAILABLE");
          return this.memory.resetKey(key);
        }
        return this.ensureRedisStore().resetKey(key);
      };
      return run();
    }
    if (env.NODE_ENV === "production") return Promise.reject(new Error("RATE_LIMIT_STORE_UNAVAILABLE"));
    return this.memory.resetKey(key);
  }

  async shutdownForTests() {
    if (this.redisInitPromise) {
      try {
        await this.redisInitPromise;
      } catch {
        /* ignore closed Redis during teardown */
      }
    }
    this.redisInitPromise = null;
    this.redis = null;
    registeredRateLimitStores.delete(this);
  }
}

export function createRateLimitStore(prefix) {
  return new RedisOrMemoryStore(prefix);
}

export const publicRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: (req) => !env.RATE_LIMIT_ENABLED || PUBLIC_DEDICATED_LIMITER_PATHS.has(req.path),
  store: createRateLimitStore("public"),
});

/** Send OTP — keyed per IP + mobile so verify attempts do not consume this bucket. */
export const otpRequestRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => !env.RATE_LIMIT_ENABLED,
  keyGenerator: (req) => otpRateLimitKey("otp:req", req),
  store: createRateLimitStore("otp-req"),
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
  skip: () => !env.RATE_LIMIT_ENABLED,
  keyGenerator: (req) => otpRateLimitKey("otp:verify", req),
  store: createRateLimitStore("otp-verify"),
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
  skip: () => !env.RATE_LIMIT_ENABLED,
  store: createRateLimitStore("login"),
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
  skip: () => !env.RATE_LIMIT_ENABLED,
  store: createRateLimitStore("tenant-resolve"),
  message: {
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many tenant resolve requests. Please try again later.",
    },
  },
});
