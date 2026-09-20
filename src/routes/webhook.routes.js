import { Router } from "express";
import * as controller from "../controllers/webhook.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import {
  assertWebhookBodyWithinLimit,
  webhookPerIpRateLimit,
  webhookPerTenantRateLimit,
} from "../middlewares/webhook.middleware.js";

export const webhookRouter = Router();
webhookRouter.use(webhookPerIpRateLimit, webhookPerTenantRateLimit, assertWebhookBodyWithinLimit);
webhookRouter.post("/phonepe/:tenantId", asyncHandler(controller.phonepe));
webhookRouter.post("/whatsapp/:tenantId", asyncHandler(controller.whatsapp));
