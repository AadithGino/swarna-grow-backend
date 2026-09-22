import { z } from "zod";
import * as E from "../constants/enums.js";
import { passwordPolicySchema, platformAppConfigBody, positivePaise } from "./common.validators.js";

const enumSchema = (enumeration) => z.enum(Object.values(enumeration));
const id = z.string().trim().min(4).max(80);
const tenantIdParam = z.object({ tenantId: id });
const planIdParam = z.object({ planId: id });
const invoiceIdParam = z.object({ invoiceId: id });
const messageTypeParam = z.object({ messageType: z.string().trim().min(2).max(64) });
const webhookRetryParam = z.object({ id: id });

export const platformTenantListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.string().trim().max(32).optional(),
  tier: z.string().trim().max(32).optional(),
  setupPending: z.enum(["true", "false"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export const platformCreatePlanBody = z.object({
  code: z.string().trim().min(2).max(32),
  name: z.string().trim().min(2).max(120),
  tier: enumSchema(E.PlanTier),
  monthlyPricePaise: positivePaise,
  annualPricePaise: positivePaise.optional(),
  limits: z.object({
    activeCustomers: z.number().int().positive(),
    branches: z.number().int().positive(),
    staff: z.number().int().positive(),
    schemePlans: z.number().int().positive(),
    whatsappMessages: z.number().int().positive(),
  }).strict(),
}).strict();

export const platformUpdatePlanBody = platformCreatePlanBody.partial().extend({
  expectedVersion: z.number().int().min(0),
}).strict();
export const platformDeprecatePlanBody = z.object({ reason: z.string().trim().min(3).max(500).optional() }).strict();

export const platformCreateTenantBody = z.object({
  name: z.string().trim().min(2).max(160),
  code: z.string().trim().min(2).max(32),
  mobile: z.string().trim().min(10).max(16),
  email: z.string().email(),
  city: z.string().trim().min(2).max(80),
  subscriptionPlanId: id,
  billingCycle: enumSchema(E.BillingCycle).optional(),
}).strict();

export const platformUpdateTenantBody = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  mobile: z.string().trim().min(10).max(16).optional(),
  email: z.string().email().optional(),
  address: z.object({
    line1: z.string().trim().max(200).optional(),
    city: z.string().trim().max(80).optional(),
    state: z.string().trim().max(80).optional(),
    pincode: z.string().trim().max(12).optional(),
  }).strict().optional(),
}).strict();

export const platformOwnerCredentialsBody = z.object({
  password: passwordPolicySchema,
}).strict();

export const platformTenantActionBody = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
  note: z.string().trim().max(500).optional(),
}).strict();

export const platformWhatsappIntegrationBody = z.object({
  phoneNumberId: z.string().trim().min(4).max(80),
  wabaId: z.string().trim().min(4).max(80).optional(),
  appSecret: z.string().trim().min(8).max(512).optional(),
  accessToken: z.string().trim().min(8).max(2048).optional(),
}).strict();

export const platformPhonePeIntegrationBody = z.object({
  clientId: z.string().trim().min(4).max(120),
  clientSecret: z.string().trim().min(8).max(512).optional(),
  clientVersion: z.coerce.number().int().min(1).max(99).optional(),
  webhookUsername: z.string().trim().min(2).max(120).optional(),
  webhookPassword: z.string().trim().min(4).max(512).optional(),
  environment: z.enum(["SANDBOX", "PRODUCTION"]).optional(),
}).strict();

export const platformFcmIntegrationBody = z.object({
  projectId: z.string().trim().min(4).max(120),
  clientEmail: z.string().email(),
  privateKey: z.string().trim().min(32).max(8192).optional(),
}).strict();

export const platformTenantTemplateBody = z.object({
  body: z.string().trim().min(1).max(2000),
  enabled: z.boolean().optional(),
}).strict();

export const platformTemplateTestBody = z.object({
  mobile: z.string().trim().min(10).max(16),
}).strict();

export const platformSubscriptionChangeBody = z.object({
  subscriptionPlanId: id,
  billingCycle: enumSchema(E.BillingCycle).optional(),
  effectiveAt: z.string().datetime().optional(),
}).strict();

export const platformSubscriptionLimitsBody = z.object({
  activeCustomers: z.number().int().positive().optional(),
  branches: z.number().int().positive().optional(),
  staff: z.number().int().positive().optional(),
  schemePlans: z.number().int().positive().optional(),
  whatsappMessages: z.number().int().positive().optional(),
}).strict();

export const platformSubscriptionExtendBody = z.object({
  days: z.number().int().min(1).max(365),
  type: enumSchema(E.SubscriptionExtensionType).optional(),
}).strict();

export const platformSubscriptionCancelBody = z.object({
  reason: z.string().trim().min(3).max(500),
  effectiveAt: z.string().datetime().optional(),
}).strict();

export const platformInvoiceCreateBody = z.object({
  amountPaise: positivePaise,
  description: z.string().trim().min(3).max(500),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export const platformMarkInvoicePaidBody = z.object({
  paidAt: z.string().datetime().optional(),
  reference: z.string().trim().max(120).optional(),
}).strict();

export const platformFlagsBody = z.object({
  flags: z.record(z.string(), z.boolean()),
}).strict();

export const platformWebhookRetryBody = z.object({}).strict();

export const platformRouteValidators = {
  "POST /subscription-plans": { body: platformCreatePlanBody },
  "PATCH /subscription-plans/:planId": { params: planIdParam, body: platformUpdatePlanBody },
  "POST /subscription-plans/:planId/deprecate": { params: planIdParam, body: platformDeprecatePlanBody },
  "POST /tenants": { body: platformCreateTenantBody },
  "PATCH /tenants/:tenantId": { params: tenantIdParam, body: platformUpdateTenantBody },
  "POST /tenants/:tenantId/owner-credentials": { params: tenantIdParam, body: platformOwnerCredentialsBody },
  "POST /tenants/:tenantId/go-live": { params: tenantIdParam, body: platformTenantActionBody },
  "POST /tenants/:tenantId/suspend": { params: tenantIdParam, body: platformTenantActionBody },
  "POST /tenants/:tenantId/reactivate": { params: tenantIdParam, body: platformTenantActionBody },
  "PUT /tenants/:tenantId/integrations/whatsapp": { params: tenantIdParam, body: platformWhatsappIntegrationBody },
  "POST /tenants/:tenantId/integrations/whatsapp/verify": { params: tenantIdParam, body: z.object({}).strict() },
  "PUT /tenants/:tenantId/integrations/payment-gateway": { params: tenantIdParam, body: platformPhonePeIntegrationBody },
  "POST /tenants/:tenantId/integrations/payment-gateway/verify": { params: tenantIdParam, body: z.object({}).strict() },
  "PUT /tenants/:tenantId/integrations/fcm": { params: tenantIdParam, body: platformFcmIntegrationBody },
  "PUT /tenants/:tenantId/templates/:messageType": { params: tenantIdParam.merge(messageTypeParam), body: platformTenantTemplateBody },
  "DELETE /tenants/:tenantId/templates/:messageType": { params: tenantIdParam.merge(messageTypeParam) },
  "POST /tenants/:tenantId/templates/:messageType/test": { params: tenantIdParam.merge(messageTypeParam), body: platformTemplateTestBody },
  "POST /tenants/:tenantId/subscription/change-plan": { params: tenantIdParam, body: platformSubscriptionChangeBody },
  "PATCH /tenants/:tenantId/subscription/limits": { params: tenantIdParam, body: platformSubscriptionLimitsBody },
  "POST /tenants/:tenantId/subscription/extend": { params: tenantIdParam, body: platformSubscriptionExtendBody },
  "POST /tenants/:tenantId/subscription/cancel": { params: tenantIdParam, body: platformSubscriptionCancelBody },
  "POST /tenants/:tenantId/invoices": { params: tenantIdParam, body: platformInvoiceCreateBody },
  "POST /invoices/:invoiceId/mark-paid": { params: invoiceIdParam, body: platformMarkInvoicePaidBody },
  "PUT /tenants/:tenantId/flags": { params: tenantIdParam, body: platformFlagsBody },
  "POST /webhook-failures/:id/retry": { params: webhookRetryParam, body: platformWebhookRetryBody },
  "PUT /app-config": { body: platformAppConfigBody },
};
