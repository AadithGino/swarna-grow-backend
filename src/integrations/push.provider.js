import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export const pushProvider = {
  async send(message) {
    if (env.PROVIDER_MODE === "mock" || !env.FCM_PROJECT_ID) { logger.info({ tokenCount: message.tokens?.length ?? 0, title: message.title }, "Mock push notification queued"); return { successCount: message.tokens?.length ?? 0, failureCount: 0 }; }
    throw new Error("FCM service-account adapter must be configured for live delivery");
  },
};
