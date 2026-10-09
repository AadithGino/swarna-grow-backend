export const Permission = Object.freeze({
  CUSTOMER_READ: "customer.read", CUSTOMER_WRITE: "customer.write", CUSTOMER_KYC: "customer.kyc", CUSTOMER_BLOCK: "customer.block",
  CUSTOMER_PASSWORD_WRITE: "customer.password.write",
  PLAN_READ: "plan.read", PLAN_WRITE: "plan.write", SCHEME_READ: "scheme.read", SCHEME_WRITE: "scheme.write",
  PAYMENT_READ: "payment.read", PAYMENT_RECORD: "payment.record", PAYMENT_REVERSE: "payment.reverse",
  CASH_READ: "cash.read", CASH_HANDOVER: "cash.handover", CASH_HANDOVER_ACCEPT: "cash.handover.accept",
  REDEMPTION_READ: "redemption.read", REDEMPTION_WRITE: "redemption.write", REDEMPTION_APPROVE: "redemption.approve",
  MESSAGE_READ: "message.read", MESSAGE_SEND: "message.send", REPORT_READ: "report.read", REPORT_EXPORT: "report.export",
  STAFF_READ: "staff.read", STAFF_WRITE: "staff.write", BRANCH_READ: "branch.read", BRANCH_WRITE: "branch.write",
  GOLD_RATE_READ: "gold-rate.read", GOLD_RATE_WRITE: "gold-rate.write",
  ECOMMERCE_READ: "ecommerce.read",
  ECOMMERCE_WRITE: "ecommerce.write",
  ECOMMERCE_PAYMENT_OPERATE: "ecommerce.payment.operate",
  ECOMMERCE_REFUND_OPERATE: "ecommerce.refund.operate",
  ECOMMERCE_FULFILMENT_OPERATE: "ecommerce.fulfilment.operate",
  SETTINGS_READ: "settings.read", SETTINGS_WRITE: "settings.write",
  GRIEVANCE_READ: "grievance.read", GRIEVANCE_REPLY: "grievance.reply", GRIEVANCE_ASSIGN: "grievance.assign", GRIEVANCE_RESOLVE: "grievance.resolve",
  AUDIT_READ: "audit.read",
});

const allPermissions = Object.values(Permission);

export const ROLE_SCOPE = Object.freeze({
  TENANT_OWNER: "TENANT",
  TENANT_ADMIN: "TENANT",
  BRANCH_MANAGER: "BRANCH",
  BRANCH_STAFF: "BRANCH",
  COLLECTION_AGENT: "BRANCH",
});

export const ROLE_PERMISSIONS = Object.freeze({
  TENANT_OWNER: ["*"],
  TENANT_ADMIN: allPermissions,
  BRANCH_MANAGER: allPermissions.filter((permission) => ![Permission.SETTINGS_WRITE, Permission.BRANCH_WRITE, Permission.CUSTOMER_BLOCK, Permission.ECOMMERCE_WRITE].includes(permission)),
  BRANCH_STAFF: [Permission.CUSTOMER_READ, Permission.CUSTOMER_WRITE, Permission.CUSTOMER_PASSWORD_WRITE, Permission.PLAN_READ, Permission.SCHEME_READ, Permission.SCHEME_WRITE, Permission.PAYMENT_READ, Permission.PAYMENT_RECORD, Permission.CASH_READ, Permission.CASH_HANDOVER, Permission.GRIEVANCE_READ, Permission.GRIEVANCE_REPLY],
  /** Field collector: search customers, view schemes, record cash, hand over cash — no enrol/KYC/grievances/plan admin. */
  COLLECTION_AGENT: [Permission.CUSTOMER_READ, Permission.SCHEME_READ, Permission.PAYMENT_READ, Permission.PAYMENT_RECORD, Permission.CASH_READ, Permission.CASH_HANDOVER, Permission.GOLD_RATE_READ],
});

/** Extra permissions a jeweller can switch on for collection agents (tenant.operations flags). Only honoured on /staff routes. */
export const AGENT_CAPABILITY_GRANTS = Object.freeze({
  agentCanRegisterCustomers: [Permission.CUSTOMER_WRITE],
  agentCanEnrolSchemes: [Permission.PLAN_READ, Permission.SCHEME_WRITE],
});

export function agentCapabilities(tenant) {
  const operations = tenant?.operations ?? {};
  return {
    registerCustomers: operations.agentCanRegisterCustomers === true,
    enrolSchemes: operations.agentCanEnrolSchemes === true,
  };
}

export function collectionAgentPermissions(tenant, { includeCapabilities = true } = {}) {
  const permissions = new Set(ROLE_PERMISSIONS.COLLECTION_AGENT);
  if (includeCapabilities) {
    const operations = tenant?.operations ?? {};
    for (const [flag, grants] of Object.entries(AGENT_CAPABILITY_GRANTS)) {
      if (operations[flag] === true) grants.forEach((permission) => permissions.add(permission));
    }
  }
  return [...permissions];
}
