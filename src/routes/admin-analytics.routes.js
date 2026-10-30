import { Router } from "express";
import * as controller from "../controllers/analytics.controller.js";
import * as searchController from "../controllers/search.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import { cursorQuery, exportBody } from "../validators/common.validators.js";
import {
  bulkMessagingSchemeIdsBody,
  reportExportAliasBody,
  reportExportAliasParam,
} from "../validators/admin-mutation.validators.js";
import { sendSuccess } from "../lib/response.js";
import { Permission } from "../constants/permissions.js";
import { guarded } from "../lib/route.js";
import * as reporting from "../services/reporting.service.js";

export const adminAnalyticsRouter = Router();
adminAnalyticsRouter.get(
  "/search",
  ...guarded(
    Permission.CUSTOMER_READ,
    validate({ query: cursorQuery }),
    asyncHandler(searchController.global),
  ),
);
adminAnalyticsRouter.get("/dashboard", ...guarded(Permission.REPORT_READ, asyncHandler(controller.dashboard)));
adminAnalyticsRouter.get("/dashboard/summary", ...guarded(Permission.REPORT_READ, asyncHandler(controller.dashboard)));
adminAnalyticsRouter.get("/dashboard/charts/:chartKey", ...guarded(Permission.REPORT_READ, asyncHandler(controller.chart)));
adminAnalyticsRouter.get("/dashboard/activity", ...guarded(Permission.REPORT_READ, asyncHandler(controller.activity)));
adminAnalyticsRouter.get("/collections/summary", ...guarded(Permission.REPORT_READ, asyncHandler(controller.collectionSummary)));
adminAnalyticsRouter.get(
  "/reports/:reportKey",
  ...guarded(
    Permission.REPORT_READ,
    validate({ query: cursorQuery }),
    asyncHandler(controller.report),
  ),
);
adminAnalyticsRouter.post(
  "/reports/:reportKey/export",
  ...guarded(
    Permission.REPORT_EXPORT,
    validate({ params: reportExportAliasParam, body: reportExportAliasBody }),
    idempotent,
    asyncHandler(async (req, res) => {
      req.body = {
        type: req.params.reportKey,
        filters: req.body.filters ?? {},
        format: req.body.format ?? "CSV",
      };
      return controller.createExport(req, res);
    }),
  ),
);
adminAnalyticsRouter.get(
  "/dues",
  ...guarded(
    Permission.REPORT_READ,
    validate({ query: cursorQuery }),
    asyncHandler(controller.dueList("dues")),
  ),
);
adminAnalyticsRouter.get(
  "/overdues",
  ...guarded(
    Permission.REPORT_READ,
    validate({ query: cursorQuery }),
    asyncHandler(controller.dueList("overdues")),
  ),
);
adminAnalyticsRouter.get("/defaulters", ...guarded(Permission.REPORT_READ, asyncHandler(controller.dueList("defaulters"))));
adminAnalyticsRouter.get("/maturities", ...guarded(Permission.REPORT_READ, asyncHandler(controller.dueList("maturities"))));
adminAnalyticsRouter.get("/maturities/calendar", ...guarded(Permission.REPORT_READ, asyncHandler(controller.maturityCalendar)));
adminAnalyticsRouter.get("/flexible-locks", ...guarded(Permission.REPORT_READ, asyncHandler(controller.dueList("flexible-locks"))));
adminAnalyticsRouter.get("/nav-badges", ...guarded(Permission.REPORT_READ, asyncHandler(controller.navBadges)));
adminAnalyticsRouter.get("/dues/count", ...guarded(Permission.REPORT_READ, asyncHandler(async (req, res) => {
  const { Scheme } = await import("../models/index.js");
  const { effectiveScope } = await import("../lib/query-filters.js");
  const { istTodayYmd, workboardSchemeFilter } = await import("../lib/dues-workboard.js");
  const count = await Scheme.countDocuments({
    ...effectiveScope(req),
    ...workboardSchemeFilter("dues", { kind: "ALL", today: istTodayYmd() }),
  });
  return sendSuccess(res, { count });
})));
adminAnalyticsRouter.post(
  "/dues/bulk-send-links",
  ...guarded(
    Permission.MESSAGE_SEND,
    validate({ body: bulkMessagingSchemeIdsBody }),
    idempotent,
    asyncHandler(async (req, res) => {
      const data = await (
        await import("../services/workboard-messaging.service.js")
      ).bulkSendDueLinks(req);
      return sendSuccess(res, data, {}, 202);
    }),
  ),
);
adminAnalyticsRouter.post(
  "/overdues/bulk-send-reminders",
  ...guarded(
    Permission.MESSAGE_SEND,
    validate({ body: bulkMessagingSchemeIdsBody }),
    idempotent,
    asyncHandler(async (req, res) => {
      const data = await (
        await import("../services/workboard-messaging.service.js")
      ).bulkSendOverdueReminders(req);
      return sendSuccess(res, data, {}, 202);
    }),
  ),
);
adminAnalyticsRouter.post("/exports", ...guarded(Permission.REPORT_EXPORT, validate({ body: exportBody }), idempotent, asyncHandler(controller.createExport)));
adminAnalyticsRouter.get("/exports", ...guarded(Permission.REPORT_EXPORT, asyncHandler(async (req, res) => sendSuccess(res, await reporting.listExports(req)))));
adminAnalyticsRouter.get("/exports/:exportId/file", ...guarded(Permission.REPORT_EXPORT, asyncHandler(controller.downloadExportFile)));
adminAnalyticsRouter.get("/exports/:exportId", ...guarded(Permission.REPORT_EXPORT, asyncHandler(controller.getExport)));
adminAnalyticsRouter.get("/audit-events", ...guarded(Permission.AUDIT_READ, asyncHandler(controller.auditEvents)));
