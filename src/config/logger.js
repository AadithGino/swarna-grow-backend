import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: ["req.headers.authorization", "*.password", "*.otp", "*.token", "*.accessToken", "*.refreshToken", "*.saltKey", "*.appSecret"], censor: "[REDACTED]" },
  base: { service: "swarnagrow-api", environment: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
});
