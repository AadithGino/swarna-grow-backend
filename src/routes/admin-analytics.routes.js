import { Router } from "express";
import * as controller from "../controllers/analytics.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import { exportBody } from "../validators/common.validators.js";
import { sendSuccess } from "../lib/response.js";

export const adminAnalyticsRouter = Router();
adminAnalyticsRouter.get("/dashboard", asyncHandler(controller.dashboard)); adminAnalyticsRouter.get("/dashboard/summary", asyncHandler(controller.dashboard)); adminAnalyticsRouter.get("/dashboard/charts/:chartKey", asyncHandler(controller.chart)); adminAnalyticsRouter.get("/dashboard/activity", asyncHandler(controller.activity));
adminAnalyticsRouter.get("/collections/summary", asyncHandler(controller.collectionSummary)); adminAnalyticsRouter.get("/reports/:reportKey", asyncHandler(controller.report)); adminAnalyticsRouter.post("/reports/:reportKey/export", idempotent, asyncHandler(async (req, res) => { req.body = { type: req.params.reportKey, filters: req.body.filters ?? req.query, format: req.body.format ?? "CSV" }; return controller.createExport(req, res); }));
adminAnalyticsRouter.get("/dues", asyncHandler(controller.dueList("dues"))); adminAnalyticsRouter.get("/overdues", asyncHandler(controller.dueList("overdues"))); adminAnalyticsRouter.get("/defaulters", asyncHandler(controller.dueList("defaulters"))); adminAnalyticsRouter.get("/maturities", asyncHandler(controller.dueList("maturities"))); adminAnalyticsRouter.get("/maturities/calendar", asyncHandler(controller.maturityCalendar)); adminAnalyticsRouter.get("/flexible-locks", asyncHandler(controller.dueList("flexible-locks")));
adminAnalyticsRouter.get("/dues/count", asyncHandler(async (req, res) => sendSuccess(res, { count: await (await import("../models/index.js")).Scheme.countDocuments({ ...req.scope, paymentPattern: "FIXED", "installments.status": { $in: ["DUE", "PARTIALLY_PAID"] } }) })));
adminAnalyticsRouter.post("/dues/bulk-send-links", idempotent, asyncHandler(async (req, res) => sendSuccess(res, { accepted: req.body.schemeIds?.length ?? 0 }, {}, 202)));
adminAnalyticsRouter.post("/overdues/bulk-send-reminders", idempotent, asyncHandler(async (req, res) => sendSuccess(res, { accepted: req.body.schemeIds?.length ?? 0, flexibleSchemesExcluded: true }, {}, 202)));
adminAnalyticsRouter.post("/exports", validate({ body: exportBody }), idempotent, asyncHandler(controller.createExport)); adminAnalyticsRouter.get("/exports", asyncHandler(async (req, res) => sendSuccess(res, await (await import("../models/index.js")).ExportJob.find(req.scope).sort({ createdAt: -1 }).lean()))); adminAnalyticsRouter.get("/exports/:exportId", asyncHandler(controller.getExport)); adminAnalyticsRouter.get("/audit-events", asyncHandler(controller.auditEvents));
