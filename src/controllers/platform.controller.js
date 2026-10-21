import { sendList, sendSuccess } from "../lib/response.js";
import * as platform from "../services/platform.service.js";

export const tenants = async (req, res) => sendList(res, await platform.listTenants(req));
export const createTenant = async (req, res) => sendSuccess(res, await platform.createTenant(req), {}, 201);
export const tenant = async (req, res) => sendSuccess(res, await platform.tenantDetail(req.params.tenantId ?? req.params.id));
export const tenantAction = (action) => async (req, res) => sendSuccess(res, await platform.tenantAction(req.params.tenantId, action, req.body, req));
export const summary = async (_req, res) => sendSuccess(res, await platform.platformSummary());
export const plans = async (_req, res) => sendSuccess(res, await platform.listSubscriptionPlans());
export const createPlan = async (req, res) => sendSuccess(res, await platform.createSubscriptionPlan(req.body, req), {}, 201);
export const getPlan = async (req, res) => sendSuccess(res, await platform.getSubscriptionPlan(req.params.planId));
export const updatePlan = async (req, res) => sendSuccess(res, await platform.updateSubscriptionPlan(req.params.planId, req.body, req));
export const deprecatePlan = async (req, res) => sendSuccess(res, await platform.deprecateSubscriptionPlan(req.params.planId, req));
export const templates = async (_req, res) => sendList(res, await platform.listTemplates());
export const tenantTemplate = async (req, res) => sendSuccess(res, await platform.upsertTenantTemplate(req.params.tenantId, req.params.messageType, req.body, req));
export const invoice = async (req, res) => sendSuccess(res, await platform.createInvoice(req.params.tenantId, req.body, req), {}, 201);
export const updateTenant = async (req, res) => sendSuccess(res, await platform.updateTenant(req.params.tenantId, req.body, req));
export const tenantUsage = async (req, res) => sendSuccess(res, await platform.tenantUsage(req.params.tenantId));
export const ownerCredentials = async (req, res) => sendSuccess(res, await platform.setOwnerCredentials(req.params.tenantId, req.body, req));
export const integration = (kind) => async (req, res) => sendSuccess(res, await platform.setIntegration(req.params.tenantId, kind, req.body, req));
export const verifyIntegration = (kind) => async (req, res) => sendSuccess(res, await platform.verifyIntegration(req.params.tenantId, kind, req.body, req));
export const tenantTemplates = async (req, res) => sendSuccess(res, await platform.listTenantTemplates(req.params.tenantId));
export const deleteTenantTemplate = async (req, res) => sendSuccess(res, await platform.deleteTenantTemplate(req.params.tenantId, req.params.messageType, req));
export const testTenantTemplate = async (req, res) => sendSuccess(res, await platform.testTenantTemplate(req.params.tenantId, req.params.messageType, req.body), {}, 202);
export const subscriptionAction = (action) => async (req, res) => sendSuccess(res, await platform.changeSubscription(req.params.tenantId, action, req.body, req));
export const flags = (write = false) => async (req, res) => sendSuccess(res, await platform.tenantFlags(req.params.tenantId, write ? req.body.flags : undefined, write ? req : undefined));
export const invoices = async (req, res) => sendSuccess(res, await platform.listInvoices(req.params.tenantId));
export const markInvoicePaid = async (req, res) => sendSuccess(res, await platform.markInvoicePaid(req.params.invoiceId, req.body, req));
export const webhookFailures = async (req, res) => sendList(res, await platform.webhookFailures(req));
export const errorLogs = async (req, res) => {
  const page = await platform.listErrorLogs(req);
  return sendSuccess(res, page.data, page.meta);
};
export const chart = async (req, res) => sendSuccess(res, await platform.platformChart(req.params.chartKey));
export const auditLogs = async (req, res) => sendList(res, await platform.listAuditLogs(req));
export const appConfig = (write = false) => async (req, res) =>
  sendSuccess(res, write ? await platform.updateAppConfig(req.body, req) : await platform.getAppConfig());
export const digitalMetalsPause = async (req, res) =>
  sendSuccess(res, await platform.setPlatformDigitalMetalsPause(req.params.tenantId, req.body, req));

export const digitalMetalsStatus = async (req, res) => {
  const { getPlatformDigitalMetalsStatus } = await import("../services/digital-metals-phase2.service.js");
  return sendSuccess(res, await getPlatformDigitalMetalsStatus(req.params.tenantId));
};

export const digitalMetalsTaxApprove = async (req, res) => {
  const { platformApproveDigitalMetalsTax } = await import("../services/digital-metals-phase2.service.js");
  return sendSuccess(res, await platformApproveDigitalMetalsTax(req.params.tenantId, req.body, req));
};

export const digitalMetalsOperationsSummary = async (req, res) => {
  const { platformDigitalMetalsOperationsSummary } = await import("./digital-metals.controller.js");
  return platformDigitalMetalsOperationsSummary(req, res);
};

export const digitalMetalsHedgeHealth = async (req, res) => {
  const { platformDigitalMetalsHedgeHealth } = await import("./digital-metals.controller.js");
  return platformDigitalMetalsHedgeHealth(req, res);
};

export const digitalMetalsTermsPublish = async (req, res) => {
  const { platformPublishDigitalMetalsTerms } = await import("../services/digital-metals-phase2.service.js");
  return sendSuccess(res, await platformPublishDigitalMetalsTerms(req.params.tenantId, req.body, req));
};
