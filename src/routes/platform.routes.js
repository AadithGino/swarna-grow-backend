import { Router } from "express";
import * as auth from "../controllers/auth.controller.js";
import * as controller from "../controllers/platform.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import { authenticate, requireSubject } from "../middlewares/auth.middleware.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { WebhookEvent } from "../models/index.js";
import { sendSuccess } from "../lib/response.js";
import { validate } from "../middlewares/validation.middleware.js";
import { platformAppConfigBody, platformLoginBody } from "../validators/common.validators.js";
import {
  platformCreatePlanBody,
  platformCreateTenantBody,
  platformDeprecatePlanBody,
  platformFcmIntegrationBody,
  platformFlagsBody,
  platformInvoiceCreateBody,
  platformMarkInvoicePaidBody,
  platformOwnerCredentialsBody,
  platformPhonePeIntegrationBody,
  platformSubscriptionCancelBody,
  platformSubscriptionChangeBody,
  platformSubscriptionExtendBody,
  platformSubscriptionLimitsBody,
  platformTemplateTestBody,
  platformTenantActionBody,
  platformTenantListQuery,
  platformTenantTemplateBody,
  platformUpdatePlanBody,
  platformLogoutBody,
  platformUpdateTenantBody,
  platformWebhookRetryBody,
  platformWhatsappIntegrationBody,
} from "../validators/platform.validators.js";
import { loginRateLimit } from "../middlewares/security.middleware.js";
import { z } from "zod";

const tenantIdParam = validate({ params: z.object({ tenantId: z.string().min(4).max(80) }) });
const planIdParam = validate({ params: z.object({ planId: z.string().min(4).max(80) }) });
const invoiceIdParam = validate({ params: z.object({ invoiceId: z.string().min(4).max(80) }) });
const messageTypeParams = validate({
  params: z.object({ tenantId: z.string().min(4).max(80), messageType: z.string().min(2).max(64) }),
});
const webhookRetryParams = validate({ params: z.object({ id: z.string().min(4).max(80) }) });

export const platformRouter = Router();
platformRouter.post("/auth/login", loginRateLimit, validate({ body: platformLoginBody }), asyncHandler(auth.login(true)));
platformRouter.post("/auth/refresh", asyncHandler(auth.refresh));
platformRouter.use(authenticate, requireSubject("PLATFORM_USER"));
platformRouter.post("/auth/logout", validate({ body: platformLogoutBody }), asyncHandler(auth.logout));
platformRouter.get("/subscription-plans", asyncHandler(controller.plans));
platformRouter.post("/subscription-plans", validate({ body: platformCreatePlanBody }), idempotent, asyncHandler(controller.createPlan));
platformRouter.get("/subscription-plans/:planId", planIdParam, asyncHandler(controller.getPlan));
platformRouter.patch("/subscription-plans/:planId", planIdParam, validate({ body: platformUpdatePlanBody }), idempotent, asyncHandler(controller.updatePlan));
platformRouter.post("/subscription-plans/:planId/deprecate", planIdParam, validate({ body: platformDeprecatePlanBody }), idempotent, asyncHandler(controller.deprecatePlan));
platformRouter.get("/tenants", validate({ query: platformTenantListQuery }), asyncHandler(controller.tenants));
platformRouter.post("/tenants", validate({ body: platformCreateTenantBody }), idempotent, asyncHandler(controller.createTenant));
platformRouter.get("/tenants/:tenantId", tenantIdParam, asyncHandler(controller.tenant));
platformRouter.patch("/tenants/:tenantId", tenantIdParam, validate({ body: platformUpdateTenantBody }), idempotent, asyncHandler(controller.updateTenant));
platformRouter.get("/tenants/:tenantId/usage", tenantIdParam, asyncHandler(controller.tenantUsage));
platformRouter.post("/tenants/:tenantId/owner-credentials", tenantIdParam, validate({ body: platformOwnerCredentialsBody }), idempotent, asyncHandler(controller.ownerCredentials));
platformRouter.post("/tenants/:tenantId/go-live", tenantIdParam, validate({ body: platformTenantActionBody }), idempotent, asyncHandler(controller.tenantAction("go-live")));
platformRouter.post("/tenants/:tenantId/suspend", tenantIdParam, validate({ body: platformTenantActionBody }), idempotent, asyncHandler(controller.tenantAction("suspend")));
platformRouter.post("/tenants/:tenantId/reactivate", tenantIdParam, validate({ body: platformTenantActionBody }), idempotent, asyncHandler(controller.tenantAction("reactivate")));
platformRouter.put("/tenants/:tenantId/integrations/whatsapp", tenantIdParam, validate({ body: platformWhatsappIntegrationBody }), idempotent, asyncHandler(controller.integration("whatsapp")));
platformRouter.post("/tenants/:tenantId/integrations/whatsapp/verify", tenantIdParam, validate({ body: z.object({}).strict() }), idempotent, asyncHandler(controller.verifyIntegration("whatsapp")));
platformRouter.put("/tenants/:tenantId/integrations/payment-gateway", tenantIdParam, validate({ body: platformPhonePeIntegrationBody }), idempotent, asyncHandler(controller.integration("phonepe")));
platformRouter.post("/tenants/:tenantId/integrations/payment-gateway/verify", tenantIdParam, validate({ body: z.object({}).strict() }), idempotent, asyncHandler(controller.verifyIntegration("phonepe")));
platformRouter.put("/tenants/:tenantId/integrations/fcm", tenantIdParam, validate({ body: platformFcmIntegrationBody }), idempotent, asyncHandler(controller.integration("fcm")));
platformRouter.put("/tenants/:tenantId/templates/:messageType", messageTypeParams, validate({ body: platformTenantTemplateBody }), asyncHandler(controller.tenantTemplate));
platformRouter.get("/tenants/:tenantId/templates", tenantIdParam, asyncHandler(controller.tenantTemplates));
platformRouter.delete("/tenants/:tenantId/templates/:messageType", messageTypeParams, idempotent, asyncHandler(controller.deleteTenantTemplate));
platformRouter.post("/tenants/:tenantId/templates/:messageType/test", messageTypeParams, validate({ body: platformTemplateTestBody }), idempotent, asyncHandler(controller.testTenantTemplate));
platformRouter.post("/tenants/:tenantId/subscription/change-plan", tenantIdParam, validate({ body: platformSubscriptionChangeBody }), idempotent, asyncHandler(controller.subscriptionAction("change-plan")));
platformRouter.patch("/tenants/:tenantId/subscription/limits", tenantIdParam, validate({ body: platformSubscriptionLimitsBody }), idempotent, asyncHandler(controller.subscriptionAction("limits")));
platformRouter.post("/tenants/:tenantId/subscription/extend", tenantIdParam, validate({ body: platformSubscriptionExtendBody }), idempotent, asyncHandler(controller.subscriptionAction("extend")));
platformRouter.post("/tenants/:tenantId/subscription/cancel", tenantIdParam, validate({ body: platformSubscriptionCancelBody }), idempotent, asyncHandler(controller.subscriptionAction("cancel")));
platformRouter.post("/tenants/:tenantId/invoices", tenantIdParam, validate({ body: platformInvoiceCreateBody }), idempotent, asyncHandler(controller.invoice));
platformRouter.get("/tenants/:tenantId/invoices", tenantIdParam, asyncHandler(controller.invoices));
platformRouter.post("/invoices/:invoiceId/mark-paid", invoiceIdParam, validate({ body: platformMarkInvoicePaidBody }), idempotent, asyncHandler(controller.markInvoicePaid));
platformRouter.get("/tenants/:tenantId/flags", tenantIdParam, asyncHandler(controller.flags(false)));
platformRouter.put("/tenants/:tenantId/flags", tenantIdParam, validate({ body: platformFlagsBody }), idempotent, asyncHandler(controller.flags(true)));
platformRouter.get("/template-definitions", asyncHandler(controller.templates));
platformRouter.get("/app-config", asyncHandler(controller.appConfig(false)));
platformRouter.put("/app-config", idempotent, validate({ body: platformAppConfigBody }), asyncHandler(controller.appConfig(true)));
platformRouter.get("/dashboard/summary", asyncHandler(controller.summary));
platformRouter.get("/dashboard/charts/:chartKey", asyncHandler(controller.chart));
platformRouter.get("/audit-logs", asyncHandler(controller.auditLogs));
platformRouter.get("/webhook-failures", asyncHandler(controller.webhookFailures));
platformRouter.post("/webhook-failures/:id/retry", webhookRetryParams, validate({ body: platformWebhookRetryBody }), idempotent, asyncHandler(async (req, res) => {
  const row = await WebhookEvent.findByIdAndUpdate(req.params.id, { $set: { status: "QUEUED", error: null } }, { new: true });
  return sendSuccess(res, { id: row?._id, queued: Boolean(row) }, {}, 202);
}));
platformRouter.get("/error-logs", asyncHandler(controller.errorLogs));
