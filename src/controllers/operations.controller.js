import {
  Alert,
  Branch,
  GoldRate,
  Grievance,
  Message,
  Redemption,
  TemplateDefinition,
  Tenant,
  User,
} from "../models/index.js";
import { sendList, sendSuccess } from "../lib/response.js";
import { errors } from "../lib/app-error.js";
import * as tenant from "../services/tenant.service.js";
import * as tenantSettings from "../services/tenant-settings.service.js";
import * as cash from "../services/cash.service.js";
import * as redemption from "../services/redemption.service.js";
import * as grievance from "../services/grievance.service.js";
import * as messaging from "../services/messaging.service.js";
import * as audit from "../services/audit.service.js";
import { effectiveScope } from "../lib/query-filters.js";

export const settingsProfile = async (req, res) =>
  sendSuccess(res, await tenantSettings.getSettingsProfileForAdmin(req));
export const settingsBranding = async (req, res) =>
  sendSuccess(res, await tenantSettings.getSettingsBrandingForAdmin(req));
export const settingsOperations = async (req, res) =>
  sendSuccess(res, await tenantSettings.getSettingsOperationsForAdmin(req));
export const patchSettingsProfile = async (req, res) =>
  sendSuccess(res, await tenantSettings.patchSettingsProfile(req));
export const patchSettingsBranding = async (req, res) =>
  sendSuccess(res, await tenantSettings.patchSettingsBranding(req));
export const patchSettingsOperations = async (req, res) =>
  sendSuccess(res, await tenantSettings.patchSettingsOperations(req));
export const branches = async (req, res) =>
  sendList(res, await tenant.listBranchesForAdmin(req));
export const createBranch = async (req, res) =>
  sendSuccess(res, await tenant.createBranch(req), {}, 201);
export const branchDetail = async (req, res) =>
  sendSuccess(res, await tenant.getBranchDetailForAdmin(req));
export const branchPerformanceSummary = async (req, res) =>
  sendSuccess(res, await tenant.getBranchPerformanceSummary(req));
export const branchPerformanceSection = async (req, res) =>
  sendList(res, await tenant.listBranchPerformanceSection(req));
export const updateBranch = async (req, res) =>
  sendSuccess(res, await tenant.updateBranch(req));
export const setBranchActive = (active) => async (req, res) =>
  sendSuccess(res, await tenant.setBranchActive(req, active));
export const accessSummary = async (req, res) => {
  const { adminAccessSummary } = await import("../services/admin-summary.service.js");
  sendSuccess(res, await adminAccessSummary(req));
};
export const staff = async (req, res) =>
  sendList(res, await tenant.listStaffForAdmin(req));
export const createStaff = async (req, res) =>
  sendSuccess(res, await tenant.createStaff(req), {}, 201);
export const deactivateStaff = async (req, res) =>
  sendSuccess(res, await tenant.deactivateStaff(req));
export const staffDetail = async (req, res) =>
  sendSuccess(res, await tenant.getStaffDetailForAdmin(req));
export const staffPerformanceSummary = async (req, res) =>
  sendSuccess(res, await tenant.getStaffPerformanceSummary(req));
export const staffPerformanceSection = async (req, res) =>
  sendList(res, await tenant.listStaffPerformanceSection(req));
export const updateStaff = async (req, res) =>
  sendSuccess(res, await tenant.updateStaff(req));
export const activateStaff = async (req, res) =>
  sendSuccess(res, await tenant.activateStaff(req));
export const transferStaff = async (req, res) =>
  sendSuccess(res, await tenant.transferStaff(req));
export const resetStaffPassword = async (req, res) =>
  sendSuccess(res, await tenant.resetStaffPassword(req));
export const goldRate = async (req, res) =>
  sendSuccess(res, await tenant.setGoldRate(req), {}, 201);
export const currentRate = async (req, res) => {
  const date =
    req.query.date ??
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const row = await tenant.currentGoldRate(effectiveScope(req), date);
  if (!row) {
    return sendSuccess(res, { isSetForToday: false, effectiveDate: date });
  }
  return sendSuccess(res, { ...row, isSetForToday: true });
};
export const rateHistory = async (req, res) =>
  sendList(res, await tenant.listGoldRateHistory(req));
export const subscription = async (req, res) =>
  sendSuccess(res, await tenantSettings.getSubscriptionForAdmin(req));
export const availablePlans = async (req, res) =>
  sendSuccess(res, await tenantSettings.getAvailablePlansForAdmin(req));
export const subscriptionInvoices = async (req, res) =>
  sendSuccess(res, await tenantSettings.listSubscriptionInvoicesForAdmin(req));
export const subscriptionInvoicePdf = async (req, res) => {
  const { loadSubscriptionInvoiceForTenant, streamSubscriptionInvoicePdf } =
    await import("../services/subscription-invoice-pdf.service.js");
  const ctx = await loadSubscriptionInvoiceForTenant(
    req.auth.tenantId,
    req.params.invoiceId,
  );
  streamSubscriptionInvoicePdf(res, ctx);
};
export const upgradeRequest = async (req, res) =>
  sendSuccess(
    res,
    await tenantSettings.createSubscriptionUpgradeRequest(req),
    {},
    202,
  );
export const subscriptionUsage = async (req, res) =>
  sendSuccess(res, await tenantSettings.getSubscriptionUsageForAdmin(req));
export const cashSummary = async (req, res) =>
  sendSuccess(
    res,
    await cash.cashBalance({
      tenantId: req.auth.tenantId,
      branchId: effectiveScope(req).branchId ?? req.auth.branchId,
      staffId: req.auth.id,
    }),
  );
export const createHandover = (initiator) => async (req, res) =>
  sendSuccess(res, await cash.createHandover(req, initiator), {}, 201);
export const settleHandover = (action) => async (req, res) =>
  sendSuccess(res, await cash.settleHandover(req, action));
export const cancelHandover = async (req, res) =>
  sendSuccess(res, await cash.cancelHandover(req));
export const handovers =
  (staffOnly = false) =>
  async (req, res) =>
    sendList(res, await cash.listHandovers(req, staffOnly));
export const cashOverview = async (req, res) =>
  sendSuccess(res, await cash.adminCashOverview(req));
export const cashStaffBalances = async (req, res) =>
  sendList(res, await cash.adminStaffBalances(req));
export const cashStaffBalanceDetail = async (req, res) =>
  sendSuccess(res, await cash.adminStaffBalanceDetail(req));
export const cashReport = async (req, res) =>
  sendSuccess(res, await cash.adminCashReport(req));
export const cashAdjustment = async (req, res) =>
  sendSuccess(res, await cash.createCashAdjustment(req), {}, 201);
export const alerts = async (req, res) => {
  const scope = effectiveScope(req);
  return sendSuccess(
    res,
    await Alert.find({
      ...scope,
      ...(req.query.status ? { status: req.query.status } : { status: "OPEN" }),
    })
      .sort({ createdAt: -1 })
      .lean(),
  );
};
export const dismissAlert = async (req, res) => {
  const scope = effectiveScope(req);
  return sendSuccess(
    res,
    await Alert.findOneAndUpdate(
      { _id: req.params.alertId, ...scope, status: "OPEN" },
      {
        $set: {
          status: "DISMISSED",
          dismissedAt: new Date(),
          dismissedBy: req.auth.id,
        },
      },
      { new: true },
    ).lean(),
  );
};
export const settlementPreview = (type) => async (req, res) =>
  sendSuccess(res, await redemption.settlementPreview(req, type));
export const initiateRedemption =
  (type, customer = false) =>
  async (req, res) =>
    sendSuccess(
      res,
      await redemption.initiateRedemption(req, type, customer),
      {},
      201,
    );
export const transitionRedemption = (action) => async (req, res) =>
  sendSuccess(res, await redemption.transitionRedemption(req, action));
export const redemptions = async (req, res) =>
  sendList(res, await redemption.listRedemptions(req));
export const redemptionDetail = async (req, res) =>
  sendSuccess(res, await redemption.getRedemptionForAdmin(req));
export const redemptionReceipt = async (req, res) => {
  const row = await Redemption.findOne({
    _id: req.params.redemptionId,
    ...effectiveScope(req),
    status: "COMPLETED",
  }).lean();
  if (!row) return sendSuccess(res, null);
  return sendSuccess(res, {
    receiptNumber: `RED-${row._id}`,
    completedAt: row.completedAt,
    principalPaise: row.principalPaise,
    benefitPaise: row.benefitPaise,
    penaltyPaise: row.penaltyPaise,
    settlementPaise: row.settlementPaise,
    cashOutPaise: row.cashOutPaise,
    weightMg: row.weightMg,
    handoverRatePerGramPaise: row.handoverRatePerGramPaise,
    handoverRateEffectiveDate: row.handoverRateEffectiveDate,
    handoverValuePaise: row.handoverValuePaise,
    mode: row.mode,
  });
};
export const grievances = async (req, res) =>
  sendList(res, await grievance.listGrievances(req));
export const grievanceDetail = async (req, res) =>
  sendSuccess(res, await grievance.getGrievance(req));
export const createGrievance = async (req, res) =>
  sendSuccess(res, await grievance.createGrievance(req), {}, 201);
export const grievanceMessage = async (req, res) =>
  sendSuccess(res, await grievance.addGrievanceMessage(req), {}, 201);
export const mutateGrievance = (action) => async (req, res) =>
  sendSuccess(res, await grievance.mutateGrievance(req, action));
export const reopenGrievance = async (req, res) =>
  sendSuccess(res, await grievance.reopenGrievance(req));
export const grievanceAudit = async (req, res) => {
  const row = await Grievance.findOne({
    _id: req.params.grievanceId,
    ...effectiveScope(req),
  }).lean();
  if (!row) throw errors.notFound("Grievance");
  sendList(res, await audit.listEntityAudit(req, "GRIEVANCE", row._id));
};
export const messages = async (req, res) =>
  sendList(res, await messaging.listMessages(req));
export const resendMessage = async (req, res) =>
  sendSuccess(res, await messaging.resendMessage(req), {}, 202);
export const templates = async (_req, res) =>
  sendSuccess(res, await TemplateDefinition.find({ active: true }).lean());
export const messageSummary = async (req, res) =>
  sendSuccess(res, await messaging.getMessagingSummaryForAdmin(req));
export const messageDetail = async (req, res) =>
  sendSuccess(res, await messaging.getMessageForAdmin(req));
export const templatePreview = async (req, res) => {
  const template = await TemplateDefinition.findOne({
    messageType: req.params.messageType,
    active: true,
    $or: [{ tenantId: req.auth.tenantId }, { tenantId: null }],
  })
    .sort({ tenantId: -1 })
    .lean();
  sendSuccess(res, {
    template,
    sample:
      req.query.sample === "true"
        ? { customerName: "Anjali Nair", amountPaise: 300000 }
        : null,
  });
};
export const reminderConfig = async (req, res) =>
  sendSuccess(res, {
    paymentDueOffsets: req.tenant.settings?.paymentDueOffsets ?? [-3, 0],
    overdueOffsets: req.tenant.settings?.overdueOffsets ?? [7, 14],
    enabled: true,
  });
export const updateReminderConfig = async (req, res) =>
  sendSuccess(
    res,
    await tenant.updateTenantSettings(req, "settings", {
      paymentDueOffsets: req.body.paymentDueOffsets,
      overdueOffsets: req.body.overdueOffsets,
      expectedVersion: req.body.expectedVersion,
    }),
  );
