import { buildCollectionReport } from "./collection.report.js";
import { buildOutstandingReport } from "./outstanding.report.js";
import { buildEnrolmentReport } from "./enrolment.report.js";
import { buildStaffPerformanceReport } from "./staff-performance.report.js";
import { buildSchemeRegisterReport } from "./scheme-register.report.js";
import { buildDefaulterReport } from "./defaulter.report.js";
import { buildMaturityRedemptionReport } from "./maturity-redemption.report.js";
import { buildGoldAccrualReport } from "./gold-accrual.report.js";
import { buildCustomerLedgerReport } from "./customer-ledger.report.js";
import { buildCashHandoverReport } from "./cash-handover.report.js";
import { buildReminderDeliveryReport } from "./reminder-delivery.report.js";
import { buildWhatsappUsageReport } from "./whatsapp-usage.report.js";
import { buildBranchPerformanceReport } from "./branch-performance.report.js";
import { buildSchemePerformanceReport } from "./scheme-performance.report.js";
import { buildCustomerPerformanceReport } from "./customer-performance.report.js";

const REPORT_BUILDERS = {
  COLLECTION: buildCollectionReport,
  OUTSTANDING: buildOutstandingReport,
  ENROLMENT: buildEnrolmentReport,
  STAFF_PERFORMANCE: buildStaffPerformanceReport,
  SCHEME_REGISTER: buildSchemeRegisterReport,
  DEFAULTER: buildDefaulterReport,
  MATURITY_REDEMPTION: buildMaturityRedemptionReport,
  GOLD_ACCRUAL: buildGoldAccrualReport,
  CUSTOMER_LEDGER: buildCustomerLedgerReport,
  CASH_HANDOVER: buildCashHandoverReport,
  REMINDER_DELIVERY: buildReminderDeliveryReport,
  WHATSAPP_USAGE: buildWhatsappUsageReport,
  BRANCH_PERFORMANCE: buildBranchPerformanceReport,
  SCHEME_PERFORMANCE: buildSchemePerformanceReport,
  CUSTOMER_PERFORMANCE: buildCustomerPerformanceReport,
};

export async function buildAdminReport(req, reportKey) {
  const builder = REPORT_BUILDERS[reportKey];
  if (!builder) return null;
  return builder(req);
}
