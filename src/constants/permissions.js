export const Permission = Object.freeze({
  CUSTOMER_READ: "customer.read", CUSTOMER_WRITE: "customer.write", CUSTOMER_KYC: "customer.kyc",
  PLAN_READ: "plan.read", PLAN_WRITE: "plan.write", SCHEME_READ: "scheme.read", SCHEME_WRITE: "scheme.write",
  PAYMENT_READ: "payment.read", PAYMENT_RECORD: "payment.record", PAYMENT_REVERSE: "payment.reverse",
  CASH_READ: "cash.read", CASH_HANDOVER: "cash.handover", CASH_HANDOVER_ACCEPT: "cash.handover.accept",
  REDEMPTION_READ: "redemption.read", REDEMPTION_WRITE: "redemption.write", REDEMPTION_APPROVE: "redemption.approve",
  MESSAGE_READ: "message.read", MESSAGE_SEND: "message.send", REPORT_READ: "report.read", REPORT_EXPORT: "report.export",
  STAFF_READ: "staff.read", STAFF_WRITE: "staff.write", BRANCH_READ: "branch.read", BRANCH_WRITE: "branch.write",
  GOLD_RATE_READ: "gold-rate.read", GOLD_RATE_WRITE: "gold-rate.write", SETTINGS_READ: "settings.read", SETTINGS_WRITE: "settings.write",
  GRIEVANCE_READ: "grievance.read", GRIEVANCE_REPLY: "grievance.reply", GRIEVANCE_ASSIGN: "grievance.assign", GRIEVANCE_RESOLVE: "grievance.resolve",
  AUDIT_READ: "audit.read",
});

export const ROLE_PERMISSIONS = Object.freeze({
  TENANT_OWNER: ["*"],
  TENANT_ADMIN: ["*"],
  BRANCH_MANAGER: Object.values(Permission).filter((permission) => ![Permission.SETTINGS_WRITE, Permission.BRANCH_WRITE].includes(permission)),
  BRANCH_STAFF: [Permission.CUSTOMER_READ, Permission.CUSTOMER_WRITE, Permission.PLAN_READ, Permission.SCHEME_READ, Permission.SCHEME_WRITE, Permission.PAYMENT_READ, Permission.PAYMENT_RECORD, Permission.CASH_READ, Permission.CASH_HANDOVER, Permission.GRIEVANCE_READ, Permission.GRIEVANCE_REPLY],
});
