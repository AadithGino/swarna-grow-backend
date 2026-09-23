import { Router } from "express";
import * as controller from "../controllers/operations.controller.js";
import * as upload from "../controllers/upload.controller.js";
import { presignUpload } from "../services/upload.service.js";
import { sendSuccess } from "../lib/response.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import {
  branchCreateBody,
  branchUpdateBody,
  goldRateBody,
  tenantOperationsPatchBody,
  uploadBody,
} from "../validators/common.validators.js";
import { Permission } from "../constants/permissions.js";
import { guarded } from "../lib/route.js";

export const adminConfigRouter = Router();
adminConfigRouter.get("/settings/profile", ...guarded(Permission.SETTINGS_READ, asyncHandler(controller.settingsProfile)));
adminConfigRouter.get("/settings/branding", ...guarded(Permission.SETTINGS_READ, asyncHandler(controller.settingsBranding)));
adminConfigRouter.get("/settings/operations", ...guarded(Permission.SETTINGS_READ, asyncHandler(controller.settingsOperations)));
adminConfigRouter.patch("/settings/profile", ...guarded(Permission.SETTINGS_WRITE, idempotent, asyncHandler(controller.patchSettingsProfile)));
adminConfigRouter.patch("/settings/branding", ...guarded(Permission.SETTINGS_WRITE, idempotent, asyncHandler(controller.patchSettingsBranding)));
adminConfigRouter.patch(
  "/settings/operations",
  ...guarded(
    Permission.SETTINGS_WRITE,
    validate({ body: tenantOperationsPatchBody }),
    idempotent,
    asyncHandler(controller.patchSettingsOperations),
  ),
);
adminConfigRouter.get("/branches", ...guarded(Permission.BRANCH_READ, asyncHandler(controller.branches)));
adminConfigRouter.post(
  "/branches",
  ...guarded(
    Permission.BRANCH_WRITE,
    validate({ body: branchCreateBody }),
    idempotent,
    asyncHandler(controller.createBranch),
  ),
);
adminConfigRouter.get(
  "/branches/:branchId/performance/summary",
  ...guarded(Permission.BRANCH_READ, asyncHandler(controller.branchPerformanceSummary)),
);
adminConfigRouter.get(
  "/branches/:branchId/performance/:section",
  ...guarded(Permission.BRANCH_READ, asyncHandler(controller.branchPerformanceSection)),
);
adminConfigRouter.get("/branches/:branchId", ...guarded(Permission.BRANCH_READ, asyncHandler(controller.branchDetail)));
adminConfigRouter.patch(
  "/branches/:branchId",
  ...guarded(
    Permission.BRANCH_WRITE,
    validate({ body: branchUpdateBody }),
    idempotent,
    asyncHandler(controller.updateBranch),
  ),
);
adminConfigRouter.post("/branches/:branchId/deactivate", ...guarded(Permission.BRANCH_WRITE, idempotent, asyncHandler(controller.setBranchActive(false))));
adminConfigRouter.post("/branches/:branchId/activate", ...guarded(Permission.BRANCH_WRITE, idempotent, asyncHandler(controller.setBranchActive(true))));
adminConfigRouter.get("/access/summary", ...guarded(Permission.STAFF_READ, asyncHandler(controller.accessSummary)));
adminConfigRouter.get("/staff", ...guarded(Permission.STAFF_READ, asyncHandler(controller.staff)));
adminConfigRouter.post("/staff", ...guarded(Permission.STAFF_WRITE, idempotent, asyncHandler(controller.createStaff)));
adminConfigRouter.get(
  "/staff/:staffId/performance/summary",
  ...guarded(Permission.STAFF_READ, asyncHandler(controller.staffPerformanceSummary)),
);
adminConfigRouter.get(
  "/staff/:staffId/performance/:section",
  ...guarded(Permission.STAFF_READ, asyncHandler(controller.staffPerformanceSection)),
);
adminConfigRouter.get("/staff/:staffId", ...guarded(Permission.STAFF_READ, asyncHandler(controller.staffDetail)));
adminConfigRouter.patch("/staff/:staffId", ...guarded(Permission.STAFF_WRITE, idempotent, asyncHandler(controller.updateStaff)));
adminConfigRouter.post("/staff/:staffId/deactivate", ...guarded(Permission.STAFF_WRITE, idempotent, asyncHandler(controller.deactivateStaff)));
adminConfigRouter.post("/staff/:staffId/activate", ...guarded(Permission.STAFF_WRITE, idempotent, asyncHandler(controller.activateStaff)));
adminConfigRouter.post("/staff/:staffId/transfer-branch", ...guarded(Permission.STAFF_WRITE, idempotent, asyncHandler(controller.transferStaff)));
adminConfigRouter.post("/staff/:staffId/reset-password", ...guarded(Permission.STAFF_WRITE, idempotent, asyncHandler(controller.resetStaffPassword)));
adminConfigRouter.post("/gold-rate", ...guarded(Permission.GOLD_RATE_WRITE, validate({ body: goldRateBody }), idempotent, asyncHandler(controller.goldRate)));
adminConfigRouter.get("/gold-rate/current", ...guarded(Permission.GOLD_RATE_READ, asyncHandler(controller.currentRate)));
adminConfigRouter.get("/gold-rate/history", ...guarded(Permission.GOLD_RATE_READ, asyncHandler(controller.rateHistory)));
adminConfigRouter.get("/subscription", ...guarded(Permission.SETTINGS_READ, asyncHandler(controller.subscription)));
adminConfigRouter.get("/subscription/available-plans", ...guarded(Permission.SETTINGS_READ, asyncHandler(controller.availablePlans)));
adminConfigRouter.post("/subscription/upgrade-request", ...guarded(Permission.SETTINGS_WRITE, idempotent, asyncHandler(controller.upgradeRequest)));
adminConfigRouter.get("/subscription/usage", ...guarded(Permission.SETTINGS_READ, asyncHandler(controller.subscriptionUsage)));
adminConfigRouter.get("/subscription/invoices", ...guarded(Permission.SETTINGS_READ, asyncHandler(controller.subscriptionInvoices)));
adminConfigRouter.get(
  "/subscription/invoices/:invoiceId/pdf",
  ...guarded(Permission.SETTINGS_READ, asyncHandler(controller.subscriptionInvoicePdf)),
);
adminConfigRouter.get("/alerts", ...guarded(Permission.SETTINGS_READ, asyncHandler(controller.alerts)));
adminConfigRouter.post("/alerts/:alertId/dismiss", ...guarded(Permission.SETTINGS_WRITE, idempotent, asyncHandler(controller.dismissAlert)));
adminConfigRouter.post("/uploads/presign", ...guarded(Permission.SETTINGS_WRITE, validate({ body: uploadBody }), idempotent, asyncHandler(async (req, res) => sendSuccess(res, await presignUpload(req), {}, 201))));
adminConfigRouter.post("/uploads/:uploadId/complete", ...guarded(Permission.SETTINGS_WRITE, idempotent, asyncHandler(upload.complete)));
adminConfigRouter.get("/uploads/:uploadId", ...guarded(Permission.SETTINGS_READ, asyncHandler(upload.download)));
