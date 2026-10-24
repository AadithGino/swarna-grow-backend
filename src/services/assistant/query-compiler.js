import { Branch, Customer, Payment, Redemption, Scheme, User } from "../../models/index.js";
import { PaymentStatus, UserType } from "../../constants/enums.js";
import { escaped, resolveQueryDateRange } from "../../lib/query-filters.js";
import { AppError } from "../../lib/app-error.js";
import {
  ASSISTANT_EXPORT_MAX_TIME_MS,
  ASSISTANT_EXPORT_ROW_CAP,
  ASSISTANT_MAX_TIME_MS,
  ASSISTANT_ROW_CAP,
  assertEntityField,
  ENTITY_REGISTRY,
} from "./schema-registry.js";

const MODEL_BY_ENTITY = {
  customers: Customer,
  collections: Payment,
  schemes: Scheme,
  redemptions: Redemption,
  branches: Branch,
  staff: User,
};

const LABEL_LOOKUPS = {
  customerId: { from: "customers", labelField: "name" },
  schemeId: { from: "schemes", labelField: "planSnapshot.name", fallbackField: "enrollmentNumber" },
  branchId: { from: "branches", labelField: "name" },
  planId: { from: "schemeplans", labelField: "name" },
};

function authScopeMatch(scope, entity) {
  const match = { tenantId: scope.tenantId };
  if (scope.branchId) {
    if (entity === "branches") {
      match._id = scope.branchId;
    } else {
      match.branchId = scope.branchId;
    }
  }
  return match;
}

function branchSelectorValues(filter) {
  if (filter.field !== "branchId") return null;
  if (filter.op === "eq") return [filter.value];
  if (filter.op === "in") {
    return Array.isArray(filter.value) ? filter.value : [filter.value];
  }
  return null;
}

function assertAuthorizedBranchFilter(scope, filter) {
  if (!scope.branchId) return;
  const values = branchSelectorValues(filter);
  if (!values?.length) return;
  const allowed = String(scope.branchId);
  for (const value of values) {
    if (String(value) !== allowed) {
      throw new AppError(
        "ASSISTANT_SCOPE",
        "Branch filter exceeds authorized scope.",
        403,
      );
    }
  }
}

function composeMatch(authMatch, filterClauses, periodMatch) {
  const parts = [authMatch, ...filterClauses];
  if (periodMatch && Object.keys(periodMatch).length) {
    parts.push(periodMatch);
  }
  return parts.length === 1 ? parts[0] : { $and: parts };
}

export function toIstBoundary(value, end = false) {
  const s = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T${end ? "23:59:59.999" : "00:00:00.000"}+05:30`);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function compileFilterClause(entity, filter) {
  const check = assertEntityField(entity, filter.field);
  if (!check.ok) {
    throw new AppError("ASSISTANT_INVALID_FIELD", check.reason, 422);
  }
  const { field, op, value, valueTo } = filter;
  const isDate = check.def?.type === "date";
  if (op === "exists") {
    return { [field]: { $exists: Boolean(value ?? true) } };
  }
  if (op === "eq") return { [field]: value };
  if (op === "in") return { [field]: { $in: Array.isArray(value) ? value : [value] } };
  if (op === "startsWith") {
    return { [field]: { $regex: `^${escaped(String(value ?? ""))}`, $options: "i" } };
  }
  if (op === "contains") {
    return { [field]: { $regex: escaped(String(value ?? "")), $options: "i" } };
  }
  if (op === "gte") {
    return { [field]: { $gte: isDate ? toIstBoundary(value) : value } };
  }
  if (op === "lte") {
    return { [field]: { $lte: isDate ? toIstBoundary(value, true) : value } };
  }
  if (op === "between") {
    return isDate
      ? { [field]: { $gte: toIstBoundary(value), $lte: toIstBoundary(valueTo ?? value, true) } }
      : { [field]: { $gte: value, $lte: valueTo ?? value } };
  }
  throw new AppError("ASSISTANT_INVALID_OPERATOR", `Unsupported operator ${op}`, 422);
}

function timeBucketExpression(field, bucket) {
  if (bucket === "day") {
    return { $dateToString: { format: "%Y-%m-%d", date: `$${field}`, timezone: "Asia/Kolkata" } };
  }
  if (bucket === "month") {
    return { $dateToString: { format: "%Y-%m", date: `$${field}`, timezone: "Asia/Kolkata" } };
  }
  return { $dateToString: { format: "%Y-%U", date: `$${field}`, timezone: "Asia/Kolkata" } };
}

function applyQueryPeriodMatch(match, entity, spec, entityDef) {
  if (!spec.period && !spec.from && !spec.to) return;
  const dateField = entity === "collections" ? "paidAt" : (entityDef.defaultSort ?? "createdAt");
  const { from, to } = resolveQueryDateRange({ period: spec.period, from: spec.from, to: spec.to });
  const range = {
    ...(from ? { $gte: new Date(`${from}T00:00:00.000+05:30`) } : {}),
    ...(to ? { $lte: new Date(`${to}T23:59:59.999+05:30`) } : {}),
  };
  if (!Object.keys(range).length) return;
  const existing = match[dateField];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    match[dateField] = { ...existing, ...range };
  } else {
    match[dateField] = range;
  }
}

function labelLookupStages(groupBy) {
  const lk = groupBy ? LABEL_LOOKUPS[groupBy] : null;
  if (!lk) return [];
  const labelExpr =
    lk.labelField === "planSnapshot.name"
      ? {
          $ifNull: [
            { $arrayElemAt: ["$_ref.planSnapshot.name", 0] },
            { $arrayElemAt: [`$_ref.${lk.fallbackField ?? "name"}`, 0] },
            "$_id.key",
          ],
        }
      : {
          $ifNull: [{ $arrayElemAt: [`$_ref.${lk.labelField}`, 0] }, "$_id.key"],
        };
  return [
    { $lookup: { from: lk.from, localField: "_id.key", foreignField: "_id", as: "_ref" } },
    { $addFields: { label: labelExpr } },
    { $project: { _ref: 0 } },
  ];
}

/**
 * @param {{ entity: string, filters: object[], period?: string, from?: string, to?: string, groupBy?: string, aggregate?: object, timeBucket?: string, topN?: number, sort?: string, limit?: number }} spec
 * @param {{ tenantId: string, branchId?: string }} scope
 */
export function compileQuerySpec(spec, scope, options = {}) {
  const exportMode = Boolean(options.export);
  const rowCap = exportMode ? ASSISTANT_EXPORT_ROW_CAP : ASSISTANT_ROW_CAP;
  const entity = spec.entity;
  const entityDef = ENTITY_REGISTRY[entity];
  if (!entityDef) {
    throw new AppError("ASSISTANT_INVALID_ENTITY", `Unknown entity: ${entity}`, 422);
  }
  const Model = MODEL_BY_ENTITY[entity];
  if (!Model) {
    throw new AppError("ASSISTANT_INVALID_ENTITY", `Entity ${entity} is not executable`, 422);
  }

  const pipeline = [];
  const authMatch = authScopeMatch(scope, entity);
  if (entity === "staff") {
    authMatch.type = UserType.TENANT_USER;
  }
  const filterClauses = [];
  for (const filter of spec.filters ?? []) {
    if (entity !== "branches") {
      assertAuthorizedBranchFilter(scope, filter);
    }
    filterClauses.push(compileFilterClause(entity, filter));
  }
  const periodMatch = {};
  applyQueryPeriodMatch(periodMatch, entity, spec, entityDef);
  pipeline.push({ $match: composeMatch(authMatch, filterClauses, periodMatch) });

  const limit = Math.min(
    spec.limit ?? spec.topN ?? rowCap,
    rowCap,
  );
  const sortDir = spec.sort === "asc" ? 1 : -1;

  if (spec.groupBy || spec.timeBucket || spec.aggregate) {
    const dateField = entity === "collections" ? "paidAt" : (entityDef.defaultSort ?? "createdAt");
    const groupId = {};
    if (spec.timeBucket) {
      groupId.bucket = timeBucketExpression(dateField, spec.timeBucket);
    }
    if (spec.groupBy) {
      groupId.key = `$${spec.groupBy}`;
    }
    if (!Object.keys(groupId).length) {
      groupId.key = null;
    }
    const groupStage = { _id: groupId, count: { $sum: 1 } };
    const aggFn = spec.aggregate?.fn ?? "count";
    const aggField = spec.aggregate?.field ?? "amountPaise";
    if (aggFn === "sum") groupStage.total = { $sum: `$${aggField}` };
    if (aggFn === "avg") groupStage.total = { $avg: `$${aggField}` };
    if (aggFn === "min") groupStage.total = { $min: `$${aggField}` };
    if (aggFn === "max") groupStage.total = { $max: `$${aggField}` };
    pipeline.push({ $group: groupStage });
    const isTimeSeries = Boolean(spec.timeBucket);
    if (isTimeSeries) {
      pipeline.push({ $sort: { "_id.bucket": 1 } });
      pipeline.push({ $limit: rowCap + 1 });
    } else {
      const measureSort = spec.aggregate ? { total: sortDir, count: sortDir } : { count: sortDir };
      pipeline.push({ $sort: measureSort });
      if (spec.topN) pipeline.push({ $limit: spec.topN });
      else pipeline.push({ $limit: limit + 1 });
    }
    pipeline.push(...labelLookupStages(spec.groupBy));
    return { Model, pipeline, mode: "aggregate", limit, exportMode, timeSeries: isTimeSeries };
  }

  const sortField = entityDef.defaultSort ?? "createdAt";
  pipeline.push({ $sort: { [sortField]: sortDir } });
  pipeline.push({ $limit: limit + 1 });

  if (entity === "collections") {
    pipeline.push(
      { $lookup: { from: "customers", localField: "customerId", foreignField: "_id", as: "_cust" } },
      { $lookup: { from: "schemes", localField: "schemeId", foreignField: "_id", as: "_sch" } },
      { $lookup: { from: "users", localField: "collectedBy", foreignField: "_id", as: "_staff" } },
      { $lookup: { from: "branches", localField: "branchId", foreignField: "_id", as: "_branch" } },
      {
        $addFields: {
          customerName: { $arrayElemAt: ["$_cust.name", 0] },
          customerMobile: { $arrayElemAt: ["$_cust.mobile", 0] },
          schemeLabel: {
            $ifNull: [
              { $arrayElemAt: ["$_sch.planSnapshot.name", 0] },
              { $arrayElemAt: ["$_sch.enrollmentNumber", 0] },
            ],
          },
          enrollmentNumber: { $arrayElemAt: ["$_sch.enrollmentNumber", 0] },
          collectedByName: { $arrayElemAt: ["$_staff.name", 0] },
          branchName: { $arrayElemAt: ["$_branch.name", 0] },
        },
      },
      {
        $project: {
          _id: 1,
          receiptNumber: 1,
          paidAt: 1,
          amountPaise: 1,
          mode: 1,
          status: 1,
          customerId: 1,
          schemeId: 1,
          branchId: 1,
          collectedBy: 1,
          targetCycle: 1,
          customerName: 1,
          customerMobile: 1,
          schemeLabel: 1,
          enrollmentNumber: 1,
          collectedByName: 1,
          branchName: 1,
        },
      },
    );
    return { Model, pipeline, mode: "aggregate", limit, exportMode, enrichPaymentSequence: limit === 1 };
  }

  pipeline.push({
    $project: {
      _id: 1,
      name: 1,
      mobile: 1,
      customerNumber: 1,
      status: 1,
      branchId: 1,
      amountPaise: 1,
      paidAt: 1,
      mode: 1,
      role: 1,
      code: 1,
      createdAt: 1,
    },
  });
  return { Model, pipeline, mode: "aggregate", limit, exportMode };
}

async function attachPaymentSequence(rows, scope) {
  const row = rows[0];
  if (!row?.schemeId || !row?.paidAt) return rows;
  const count = await Payment.countDocuments({
    tenantId: scope.tenantId,
    schemeId: row.schemeId,
    status: PaymentStatus.SUCCESS,
    paidAt: { $lte: row.paidAt },
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
  }).maxTimeMS(ASSISTANT_MAX_TIME_MS);
  row.paymentSequence = count;
  return rows;
}

export async function runCompiledQuery(compiled, scope = null, options = {}) {
  const exportMode = Boolean(options.export ?? compiled.exportMode);
  const maxTimeMS = exportMode ? ASSISTANT_EXPORT_MAX_TIME_MS : ASSISTANT_MAX_TIME_MS;
  const cursor = compiled.Model.aggregate(compiled.pipeline).option({
    maxTimeMS,
    allowDiskUse: exportMode,
  });
  let rows = await cursor;
  const exportRecommended = rows.length > compiled.limit;
  let trimmed = exportRecommended ? rows.slice(0, compiled.limit) : rows;
  if (compiled.enrichPaymentSequence && trimmed.length === 1 && scope?.tenantId) {
    trimmed = await attachPaymentSequence(trimmed, scope);
  }
  return { rows: trimmed, exportRecommended, totalReturned: trimmed.length };
}

/** @param {object} scope from req.scope */
export function assistantDataScope(req) {
  const tenantId = req.scope?.tenantId ?? req.auth?.tenantId;
  if (!tenantId) {
    throw new AppError("ASSISTANT_SCOPE", "Tenant scope is required", 403);
  }
  const scope = { tenantId };
  if (req.scope?.branchId) scope.branchId = req.scope.branchId;
  return scope;
}
