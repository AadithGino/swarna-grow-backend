import { sendList, sendSuccess } from "../lib/response.js";
import * as plans from "../services/plan.service.js";
import * as schemes from "../services/scheme.service.js";
import { maturityProjectionForScheme } from "../services/maturity-projection.service.js";

export const listPlans = (consumer = "admin") => async (req, res) => sendList(res, await plans.listPlans(req, consumer));
export const createPlan = async (req, res) => sendSuccess(res, await plans.createPlan(req), {}, 201);
export const getPlan = async (req, res) => sendSuccess(res, await plans.getPlan(req));
export const updatePlan = async (req, res) => sendSuccess(res, await plans.updatePlan(req));
export const setPlanStatus = (status) => async (req, res) => sendSuccess(res, await plans.setPlanStatus(req, status));
export const duplicatePlan = async (req, res) => sendSuccess(res, await plans.duplicatePlan(req), {}, 201);
export const previewSchedule = async (req, res) =>
  sendSuccess(res, await plans.previewSchedule(req.body, req.auth.tenantId));
export const planStats = async (req, res) => sendSuccess(res, await plans.planStats(req));
export const validateEnrolment = async (req, res) => sendSuccess(res, await schemes.validateEnrolmentResponse(req));
export const enrol = async (req, res) => sendSuccess(res, await schemes.enrol(req), {}, 201);
export const schemeAnalytics = async (req, res) =>
  sendSuccess(res, await schemes.schemeAnalytics(req));
export const listSchemes = async (req, res) => sendList(res, await schemes.listSchemes(req));
export const getScheme = async (req, res) => sendSuccess(res, await schemes.getScheme(req));
export const payableRange = async (req, res) => sendSuccess(res, await schemes.payableRange(req));
export const ledger = async (req, res) => sendList(res, await schemes.getLedger(req));
export const passbook = async (req, res) => sendSuccess(res, await schemes.getPassbook(req));
export const maturityProjection = async (req, res) =>
  sendSuccess(res, await maturityProjectionForScheme(req));
export const applyLock = async (req, res) => sendSuccess(res, await schemes.applyFlexibleLock(req));
export const recompute = async (req, res) => sendSuccess(res, await schemes.recomputeScheme(req));
