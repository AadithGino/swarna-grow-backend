import { sendList, sendSuccess } from "../lib/response.js";
import * as landingDemo from "../services/landing-demo-request.service.js";

export const submitPublic = async (req, res) =>
  sendSuccess(res, await landingDemo.createLandingDemoRequest(req.body), {}, 201);

export const listForPlatform = async (req, res) => {
  const result = await landingDemo.listLandingDemoRequests(req.query);
  return sendList(res, {
    data: result.rows,
    meta: { total: result.total, limit: result.limit, offset: result.offset },
  });
};

export const getForPlatform = async (req, res) =>
  sendSuccess(res, await landingDemo.getLandingDemoRequest(req.params.requestId));

export const patchForPlatform = async (req, res) =>
  sendSuccess(res, await landingDemo.updateLandingDemoRequest(req.params.requestId, req.body));

export const shareLinkForPlatform = async (req, res) =>
  sendSuccess(res, await landingDemo.shareLinkForLandingDemoRequest(req.params.requestId));

export const retryProvisionForPlatform = async (req, res) =>
  sendSuccess(res, await landingDemo.retryLandingDemoProvision(req.params.requestId));