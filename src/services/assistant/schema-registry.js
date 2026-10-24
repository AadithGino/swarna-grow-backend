/** @typedef {"eq"|"in"|"startsWith"|"contains"|"gte"|"lte"|"between"|"exists"} FilterOperator */

export const ASSISTANT_ROW_CAP = 500;
export const ASSISTANT_EXPORT_ROW_CAP = 50_000;
export const ASSISTANT_MAX_TIME_MS = 15_000;
export const ASSISTANT_EXPORT_MAX_TIME_MS = 120_000;

export const REPORT_KEYS = Object.freeze(Object.keys({
  COLLECTION: true,
  OUTSTANDING: true,
  ENROLMENT: true,
  STAFF_PERFORMANCE: true,
  SCHEME_REGISTER: true,
  DEFAULTER: true,
  MATURITY_REDEMPTION: true,
  GOLD_ACCRUAL: true,
  CUSTOMER_LEDGER: true,
  CASH_HANDOVER: true,
  REMINDER_DELIVERY: true,
  WHATSAPP_USAGE: true,
  BRANCH_PERFORMANCE: true,
  SCHEME_PERFORMANCE: true,
  CUSTOMER_PERFORMANCE: true,
  ECOMMERCE_SALES: true,
  ECOMMERCE_ORDERS_FULFILMENT: true,
  ECOMMERCE_PRODUCTS: true,
}));

/** @type {Record<string, { collection: string, fields: Record<string, { type: string, operators: FilterOperator[], indexHint?: string, groupBy?: boolean, aggregate?: boolean }>, groupByFields?: string[], defaultSort?: string }>} */
export const ENTITY_REGISTRY = Object.freeze({
  customers: {
    collection: "customers",
    fields: {
      name: { type: "string", operators: ["eq", "startsWith", "contains"], indexHint: "tenantId_1_name_text_mobile_text_customerNumber_text", groupBy: false },
      mobile: { type: "string", operators: ["eq", "startsWith"], indexHint: "tenantId_1_mobile_1", groupBy: false },
      customerNumber: { type: "string", operators: ["eq", "startsWith"], indexHint: "tenantId_1_customerNumber_1", groupBy: false },
      status: { type: "enum", operators: ["eq", "in"], indexHint: "tenantId_1_branchId_1_status_1_createdAt_-1", groupBy: true },
      branchId: { type: "id", operators: ["eq", "in"], indexHint: "tenantId_1_branchId_1_status_1_createdAt_-1", groupBy: true },
      createdAt: { type: "date", operators: ["gte", "lte", "between"], indexHint: "tenantId_1_branchId_1_status_1_createdAt_-1", groupBy: true, aggregate: false },
      "kyc.status": { type: "enum", operators: ["eq", "in", "exists"], groupBy: true },
    },
    groupByFields: ["branchId", "status", "kyc.status"],
    defaultSort: "createdAt",
  },
  collections: {
    collection: "payments",
    fields: {
      branchId: { type: "id", operators: ["eq", "in"], indexHint: "tenantId_1_branchId_1_paidAt_-1", groupBy: true },
      customerId: { type: "id", operators: ["eq", "in"], groupBy: true },
      schemeId: { type: "id", operators: ["eq", "in"], indexHint: "tenantId_1_schemeId_1", groupBy: true },
      mode: { type: "enum", operators: ["eq", "in"], groupBy: true },
      status: { type: "enum", operators: ["eq", "in"], groupBy: true },
      paidAt: { type: "date", operators: ["gte", "lte", "between"], indexHint: "tenantId_1_branchId_1_paidAt_-1", groupBy: true },
      amountPaise: { type: "number", operators: ["gte", "lte", "between"], aggregate: true },
    },
    groupByFields: ["branchId", "mode", "status"],
    defaultSort: "paidAt",
  },
  schemes: {
    collection: "schemes",
    fields: {
      branchId: { type: "id", operators: ["eq", "in"], groupBy: true },
      customerId: { type: "id", operators: ["eq", "in"], groupBy: true },
      planId: { type: "id", operators: ["eq", "in"], groupBy: true },
      status: { type: "enum", operators: ["eq", "in"], indexHint: "tenantId_1_status_1", groupBy: true },
      paymentPattern: { type: "enum", operators: ["eq", "in"], groupBy: true },
      createdAt: { type: "date", operators: ["gte", "lte", "between"], groupBy: true },
    },
    groupByFields: ["branchId", "status", "planId"],
    defaultSort: "createdAt",
  },
  redemptions: {
    collection: "redemptions",
    fields: {
      branchId: { type: "id", operators: ["eq", "in"], groupBy: true },
      status: { type: "enum", operators: ["eq", "in"], groupBy: true },
      mode: { type: "enum", operators: ["eq", "in"], groupBy: true },
      createdAt: { type: "date", operators: ["gte", "lte", "between"], groupBy: true },
    },
    groupByFields: ["branchId", "status", "mode"],
    defaultSort: "createdAt",
  },
  branches: {
    collection: "branches",
    fields: {
      code: { type: "string", operators: ["eq", "startsWith"], groupBy: false },
      name: { type: "string", operators: ["eq", "contains", "startsWith"], groupBy: false },
      active: { type: "boolean", operators: ["eq", "exists"], groupBy: true },
    },
    groupByFields: ["active"],
    defaultSort: "name",
  },
  staff: {
    collection: "users",
    fields: {
      branchId: { type: "id", operators: ["eq", "in"], groupBy: true },
      role: { type: "enum", operators: ["eq", "in"], groupBy: true },
      status: { type: "enum", operators: ["eq", "in"], groupBy: true },
      name: { type: "string", operators: ["eq", "startsWith", "contains"], groupBy: false },
    },
    groupByFields: ["branchId", "role", "status"],
    defaultSort: "name",
  },
});

export function toolCatalogForPrompt() {
  return {
    reportKeys: [...REPORT_KEYS],
    collectionAnalytics: {
      domain: "scheme_collections",
      metrics: [
        { key: "net_collected", unit: "INR", definition: "Gross receipts minus gateway refunds and manual corrections" },
        { key: "gross_receipts", unit: "INR", definition: "Successful payment amounts by paidAt" },
      ],
      dimensions: ["day", "mode", "branch"],
      paymentModes: ["CASH", "UPI", "CARD", "BANK_TRANSFER", "ONLINE_GATEWAY"],
      notes: [
        "UPI means recorded Payment.mode=UPI (manual UPI), not ONLINE_GATEWAY.",
        "Use kind collectionDaily with analytics.compareModes for Cash vs UPI comparisons.",
        "timeBucket day + groupBy mode may be normalized server-side to collectionDaily.",
      ],
      operations: ["summary", "trend", "comparison"],
    },
    entities: Object.fromEntries(
      Object.entries(ENTITY_REGISTRY).map(([entity, def]) => [
        entity,
        {
          fields: Object.keys(def.fields),
          groupBy: def.groupByFields ?? [],
        },
      ]),
    ),
  };
}

export function assertEntityField(entity, field) {
  const def = ENTITY_REGISTRY[entity];
  if (!def) return { ok: false, reason: `Unknown entity: ${entity}` };
  if (!def.fields[field]) return { ok: false, reason: `Field ${field} is not queryable on ${entity}` };
  return { ok: true, def: def.fields[field] };
}

export function assertReportKey(reportKey) {
  if (!REPORT_KEYS.includes(reportKey)) {
    return { ok: false, reason: `Unknown report: ${reportKey}` };
  }
  return { ok: true };
}

/** Stat card / chart axis unit for aggregate results (paise fields stay currency for sum/avg/min/max). */
export function aggregateValueType(entity, field, fn) {
  const def = ENTITY_REGISTRY[entity]?.fields?.[field];
  const isMoney = field === "amountPaise" || field.includes("Paise") || def?.type === "number" && field.includes("amount");
  if (fn === "count" || field === "count") return "count";
  if (isMoney && (fn === "sum" || fn === "avg" || fn === "min" || fn === "max")) return "currency";
  if (def?.type === "date") return "date";
  return "number";
}
