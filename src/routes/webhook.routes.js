import { Router } from "express";
import * as controller from "../controllers/webhook.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import {
  assertWebhookBodyWithinLimit,
  webhookPerIpRateLimit,
  webhookPerTenantRateLimit,
} from "../middlewares/webhook.middleware.js";

export const webhookRouter = Router();
webhookRouter.use(webhookPerIpRateLimit, assertWebhookBodyWithinLimit);
webhookRouter.post(
  "/phonepe/:tenantId",
  webhookPerTenantRateLimit,
  asyncHandler(controller.phonepe),
);
webhookRouter.post(
  "/whatsapp/:tenantId",
  webhookPerTenantRateLimit,
  asyncHandler(controller.whatsapp),
);
