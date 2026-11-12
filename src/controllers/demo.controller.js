import { sendList, sendSuccess } from "../lib/response.js";
import { demoPublicDoc, demoPublicDocs } from "../lib/demo-dto.js";
import * as demoTemplate from "../services/demo-template.service.js";
import * as demoInstance from "../services/demo-instance.service.js";
import * as demoSession from "../services/demo-session.service.js";
import {
  completePlatformDemoLogo,
  presignPlatformDemoLogo,
  putPlatformDemoLogoContent,
} from "../services/upload.service.js";

function withDemoTemplateResult(result) {
  return {
    ...result,
    template: demoPublicDoc(result.template),
  };
}

function withDemoInstanceResult(result) {
  return {
    ...result,
    instance: demoPublicDoc(result.instance),
  };
}

// --- Platform Manager: templates (plan section 8.1) ---
export const registerTemplate = async (req, res) =>
  sendSuccess(res, withDemoTemplateResult(await demoTemplate.registerTemplate({ ...req.body, actorId: req.auth.id })), {}, 201);
export const listTemplates = async (_req, res) =>
  sendList(res, { data: demoPublicDocs(await demoTemplate.listTemplates()), meta: {} });
export const getTemplate = async (req, res) =>
  sendSuccess(res, demoPublicDoc(await demoTemplate.getTemplate(req.params.templateId)));
export const listTemplateVersions = async (req, res) =>
  sendList(res, { data: demoPublicDocs(await demoTemplate.listTemplateVersions(req.params.templateId)), meta: {} });
export const publishTemplateVersion = async (req, res) =>
  sendSuccess(
    res,
    demoPublicDoc(
      await demoTemplate.publishTemplateVersion({ templateId: req.params.templateId, actorId: req.auth.id }),
    ),
    {},
    201,
  );

// --- Platform Manager: demo instances (plan section 8.2-8.4) ---
export const createDemo = async (req, res) =>
  sendSuccess(res, withDemoInstanceResult(await demoInstance.createDemo({ ...req.body, actorId: req.auth.id })), {}, 201);
export const listDemos = async (req, res) => {
  const page = await demoInstance.listDemos(req.query);
  return sendSuccess(res, demoPublicDocs(page.data), page.meta);
};
export const getDemo = async (req, res) =>
  sendSuccess(res, demoPublicDoc(await demoInstance.getDemo(req.params.instanceId)));
export const updateDemo = async (req, res) => {
  const { expectedVersion, ...patch } = req.body;
  return sendSuccess(
    res,
    demoPublicDoc(await demoInstance.updateDemo({ instanceId: req.params.instanceId, patch, expectedVersion })),
  );
};
export const rotateLink = async (req, res) =>
  sendSuccess(
    res,
    withDemoInstanceResult(
      await demoInstance.rotateLink(req.params.instanceId, {
        rememberLinkSecret: req.body?.rememberLinkSecret,
      }),
    ),
  );
export const copyLink = async (req, res) => sendSuccess(res, await demoInstance.copyLink(req.params.instanceId));
export const disableDemo = async (req, res) =>
  sendSuccess(res, demoPublicDoc(await demoInstance.disableDemo(req.params.instanceId, req.auth.id)));
export const reactivateDemo = async (req, res) =>
  sendSuccess(res, demoPublicDoc(await demoInstance.reactivateDemo(req.params.instanceId, req.auth.id)));

// --- Public (no auth): branding + session exchange (plan section 6.2) ---
export const publicBranding = async (req, res) => sendSuccess(res, await demoSession.getPublicBranding(req.params.publicId));
export const exchangeSession = async (req, res) =>
  sendSuccess(
    res,
    await demoSession.exchangeSession({
      publicId: req.params.publicId,
      secret: req.body.secret,
      device: req.body.device ?? {},
      request: req,
    }),
  );

// --- Authenticated customer app: demo context (plan section 6.1) ---
export const demoContext = async (req, res) => sendSuccess(res, await demoSession.getDemoContextForSession(req.tenant));

// --- Platform Demo Builder logo uploads (TENANT_LOGO under synthetic platform tenant) ---
export const presignDemoLogo = async (req, res) =>
  sendSuccess(res, await presignPlatformDemoLogo(req), {}, 201);
export const completeDemoLogo = async (req, res) =>
  sendSuccess(res, await completePlatformDemoLogo(req));
export const putDemoLogoContent = async (req, res) =>
  sendSuccess(res, await putPlatformDemoLogoContent(req));
