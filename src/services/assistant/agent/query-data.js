/**
 * query_data compiler: turns a model-written query spec into a safe, tenant-scoped
 * MongoDB aggregation over the semantic layer, runs it, and returns rows for both
 * the UI (typed cells) and the model (compact display strings).
 *
 * Safety properties (do not weaken):
 *  - tenantId (and branchId for branch-scoped users) is injected here; the spec
 *    has no way to name a tenant, branch scope, collection, or raw Mongo operator.
 *  - Only fields declared in semantic-layer.js are reachable, including through $lookup,
 *    and every $lookup re-applies the tenant filter on the joined collection.
 *  - Row/group caps and maxTimeMS bound the cost of any single query.
 */
import { z } from "zod";
import { AppError } from "../../../lib/app-error.js";
import { escaped } from "../../../lib/query-filters.js";
import { ENTITIES, resolveField } from "./semantic-layer.js";
import {
  columnTypeFor,
  presentValue,
  rupeesDisplay,
  countDisplay,
  gramsFromMgDisplay,
  gramsFromUgDisplay,
  istDateDisplay,
} from "./format.js";

export const QUERY_MAX_TIME_MS = 15_000;
export const QUERY_EXPORT_MAX_TIME_MS = 120_000;
export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 200;
export const GROUP_DEFAULT_LIMIT = 50;
export const GROUP_MAX_LIMIT = 400;
export const EXPORT_ROW_CAP = 50_000;
export const MODEL_ROW_CAP = 20;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const filterSchema = z.object({
  field: z.string().min(1).max(80),
  op: z.enum([
    "eq",
    "ne",
    "in",
    "nin",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "contains",
    "startsWith",
    "exists",
  ]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional().nullable(),
  values: z.array(z.union([z.string(), z.number()])).max(50).optional(),
  valueTo: z.union([z.string(), z.number()]).optional().nullable(),
});

const metricSchema = z.object({
  fn: z.enum(["count", "sum", "avg", "min", "max", "countDistinct"]),
  field: z.string().max(80).optional(),
});

export const dataQuerySpecSchema = z.object({
  entity: z.string().min(1).max(40),
  filters: z.array(filterSchema).max(12).optional().default([]),
  dateFrom: z.string().regex(YMD).optional().nullable(),
  dateTo: z.string().regex(YMD).optional().nullable(),
  dateField: z.string().max(40).optional().nullable(),
  groupBy: z.array(z.string().max(80)).max(2).optional().default([]),
  timeBucket: z.enum(["day", "week", "month", "year"]).optional().nullable(),
  metrics: z.array(metricSchema).max(4).optional().default([]),
  select: z.array(z.string().max(80)).max(12).optional().default([]),
  sort: z
    .object({ by: z.string().max(80), dir: z.enum(["asc", "desc"]).optional().default("desc") })
    .optional()
    .nullable(),
  limit: z.coerce.number().int().min(1).max(GROUP_MAX_LIMIT).optional().nullable(),
  compareToPrevious: z.boolean().optional().nullable(),
});

/** Errors the model can fix by rewriting its call (returned to it as tool errors). */
export class QuerySpecError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "QuerySpecError";
    this.hint = hint;
  }
}

function istStart(ymd) {
  return new Date(`${ymd}T00:00:00.000+05:30`);
}
function istEnd(ymd) {
  return new Date(`${ymd}T23:59:59.999+05:30`);
}

function shiftYmd(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Previous comparable window: previous calendar month for month-to-date / full months, else same-length window. */
export function previousWindow(from, to) {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  if (fd === 1 && fy === ty && fm === tm) {
    const py = fm === 1 ? fy - 1 : fy;
    const pm = fm === 1 ? 12 : fm - 1;
    const lastPrev = lastDayOfMonth(py, pm);
    const endDay = Math.min(td, lastPrev);
    const pad = (n) => String(n).padStart(2, "0");
    const isFullMonth = td === lastDayOfMonth(ty, tm);
    return {
      from: `${py}-${pad(pm)}-01`,
      to: `${py}-${pad(pm)}-${pad(isFullMonth ? lastPrev : endDay)}`,
    };
  }
  const len = daysBetween(from, to);
  const prevTo = shiftYmd(from, -1);
  return { from: shiftYmd(prevTo, -len), to: prevTo };
}

function parseNumberLike(raw) {
  if (typeof raw === "number") return raw;
  const s = String(raw ?? "")
    .replace(/[₹,\s]/g, "")
    .replace(/rs\.?/i, "")
    .replace(/g(rams?)?$/i, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function coerceEnum(def, raw, fieldKey) {
  const s = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  const values = def.values ?? [];
  if (values.includes(s)) return s;
  const loose = values.find((v) => v.replace(/_/g, "") === s.replace(/_/g, ""));
  if (loose) return loose;
  throw new QuerySpecError(
    `"${raw}" is not a valid value for ${fieldKey}.`,
    `Allowed values: ${values.join(", ")}`,
  );
}

function coerceScalar(def, raw, fieldKey, { bound } = {}) {
  if (raw === undefined || raw === null || raw === "") {
    throw new QuerySpecError(`Missing value for ${fieldKey}.`);
  }
  switch (def.type) {
    case "enum":
      return coerceEnum(def, raw, fieldKey);
    case "money": {
      const n = parseNumberLike(raw);
      if (!Number.isFinite(n)) throw new QuerySpecError(`${fieldKey} needs a rupee amount, got "${raw}".`);
      return Math.round(n * 100);
    }
    case "weight_mg": {
      const n = parseNumberLike(raw);
      if (!Number.isFinite(n)) throw new QuerySpecError(`${fieldKey} needs grams, got "${raw}".`);
      return Math.round(n * 1000);
    }
    case "weight_ug": {
      const n = parseNumberLike(raw);
      if (!Number.isFinite(n)) throw new QuerySpecError(`${fieldKey} needs grams, got "${raw}".`);
      return Math.round(n * 1_000_000);
    }
    case "number":
    case "count": {
      const n = parseNumberLike(raw);
      if (!Number.isFinite(n)) throw new QuerySpecError(`${fieldKey} needs a number, got "${raw}".`);
      return n;
    }
    case "boolean": {
      const s = String(raw).trim().toLowerCase();
      if (["true", "yes", "1"].includes(s)) return true;
      if (["false", "no", "0"].includes(s)) return false;
      throw new QuerySpecError(`${fieldKey} needs true or false.`);
    }
    case "datetime": {
      const s = String(raw).trim();
      if (YMD.test(s)) return bound === "end" ? istEnd(s) : istStart(s);
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) throw new QuerySpecError(`${fieldKey} needs a date (YYYY-MM-DD), got "${raw}".`);
      return d;
    }
    case "ymd": {
      const s = String(raw).trim().slice(0, 10);
      if (!YMD.test(s)) throw new QuerySpecError(`${fieldKey} needs a date (YYYY-MM-DD), got "${raw}".`);
      return s;
    }
    case "id":
    case "string":
    default:
      return String(raw).trim();
  }
}

function filterValues(filter) {
  if (Array.isArray(filter.values) && filter.values.length) return filter.values;
  if (filter.value === undefined || filter.value === null || filter.value === "") return [];
  if (typeof filter.value === "string" && filter.value.includes(",") && ["in", "nin"].includes(filter.op)) {
    return filter.value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [filter.value];
}

/** Build a Mongo predicate for one filter against a resolved path. */
function compilePredicate(resolved, filter) {
  const { def } = resolved;
  const key = resolved.key;
  const op = filter.op;

  if (op === "exists") {
    const want = filter.value == null ? true : coerceScalar({ type: "boolean" }, filter.value, key);
    return want ? { $exists: true, $nin: [null, ""] } : { $in: [null, ""] };
  }
  if (op === "contains" || op === "startsWith") {
    if (!["string", "id"].includes(def.type)) {
      throw new QuerySpecError(`${op} only works on text fields; ${key} is ${def.type}.`);
    }
    const text = String(filter.value ?? filter.values?.[0] ?? "").trim();
    if (!text) throw new QuerySpecError(`Missing text for ${key} ${op}.`);
    const pattern = op === "startsWith" ? `^${escaped(text)}` : escaped(text);
    return { $regex: pattern, $options: "i" };
  }
  if (op === "in" || op === "nin") {
    const list = filterValues(filter).map((v) => coerceScalar(def, v, key));
    if (!list.length) throw new QuerySpecError(`${op} on ${key} needs values.`);
    return op === "in" ? { $in: list } : { $nin: list };
  }
  if (op === "between") {
    const lo = coerceScalar(def, filter.value ?? filter.values?.[0], key, { bound: "start" });
    const hi = coerceScalar(def, filter.valueTo ?? filter.values?.[1] ?? filter.value, key, { bound: "end" });
    return { $gte: lo, $lte: hi };
  }
  const raw = filter.value ?? filter.values?.[0];
  if (def.type === "datetime" && (op === "eq" || op === "ne") && YMD.test(String(raw ?? "").trim())) {
    const day = String(raw).trim();
    const range = { $gte: istStart(day), $lte: istEnd(day) };
    return op === "eq" ? range : { $not: range };
  }
  const bound = op === "lte" || op === "gt" ? "end" : "start";
  const value = coerceScalar(def, raw, key, { bound });
  switch (op) {
    case "eq":
      return value;
    case "ne":
      return { $ne: value };
    case "gt":
      return { $gt: value };
    case "gte":
      return { $gte: value };
    case "lt":
      return { $lt: value };
    case "lte":
      return { $lte: value };
    default:
      throw new QuerySpecError(`Unsupported operator ${op}.`);
  }
}

function requireField(entityName, ref, purpose) {
  const resolved = resolveField(entityName, ref);
  if (!resolved) {
    const entity = ENTITIES[entityName];
    const options = [
      ...Object.keys(entity.fields),
      ...Object.entries(entity.relations ?? {}).flatMap(([r, rel]) => rel.fields.map((f) => `${r}.${f}`)),
    ];
    throw new QuerySpecError(
      `Unknown field "${ref}" for ${entityName} (${purpose}).`,
      `Valid fields: ${options.join(", ")}`,
    );
  }
  return resolved;
}

/** Field path inside the working document (after computed/lookup stages). */
function docPath(resolved) {
  if (resolved.kind === "direct") {
    return resolved.def.expr ? `_c_${resolved.key}` : resolved.def.path;
  }
  return `_r_${resolved.relationName}.${resolved.def.path}`;
}

function lookupStages(entityName, relationName, scope) {
  const entity = ENTITIES[entityName];
  const relation = entity.relations[relationName];
  const target = ENTITIES[relation.entity];
  const project = {};
  for (const f of relation.fields) {
    const def = target.fields[f];
    if (def?.path) project[def.path] = 1;
  }
  return [
    {
      $lookup: {
        from: target.model.collection.name,
        localField: relation.localField,
        foreignField: "_id",
        pipeline: [{ $match: { tenantId: scope.tenantId } }, { $project: project }],
        as: `_r_${relationName}`,
      },
    },
    { $unwind: { path: `$_r_${relationName}`, preserveNullAndEmptyArrays: true } },
  ];
}

function scopeMatch(entityName, scope) {
  const entity = ENTITIES[entityName];
  const match = { tenantId: scope.tenantId, ...(entity.baseWhere ?? {}) };
  if (scope.branchId) {
    if (entity.branchScoped) {
      const field = entity.branchIdField ?? "branchId";
      match[field] = entity.allowNullBranch ? { $in: [scope.branchId, null] } : scope.branchId;
    } else if (!entity.branchFree) {
      throw new AppError(
        "ASSISTANT_SCOPE",
        `${entity.label} are only available to owner and admin roles.`,
        403,
      );
    }
  }
  return match;
}

/** $project output names cannot contain dots ("customer.name" would nest). */
export function outName(key) {
  return String(key).replace(/\./g, "__");
}

function relationLabelKey(relationName) {
  return {
    customer: "Customer",
    scheme: "Enrolment",
    branch: "Branch",
    collectedBy: "Collected by",
    staff: "Staff",
    plan: "Plan",
  }[relationName] ?? relationName;
}

function columnLabel(resolved) {
  if (resolved.kind === "related") {
    const rel = resolved.relation;
    if (rel.fields[0] === resolved.targetField) return relationLabelKey(resolved.relationName);
    if (resolved.targetField === "planName") return "Plan";
    return `${relationLabelKey(resolved.relationName)} ${resolved.def.label?.toLowerCase() ?? resolved.targetField}`;
  }
  return resolved.def.label ?? resolved.key;
}

function bucketFormat(bucket) {
  if (bucket === "day") return "%Y-%m-%d";
  if (bucket === "week") return "%G-W%V";
  if (bucket === "year") return "%Y";
  return "%Y-%m";
}

function bucketLabel(bucket, key) {
  if (key == null) return "—";
  const s = String(key);
  if (bucket === "day") return istDateDisplay(s);
  if (bucket === "month" && /^\d{4}-\d{2}$/.test(s)) {
    const d = new Date(`${s}-15T12:00:00Z`);
    return d.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
  }
  if (bucket === "week") return s.replace("-W", " · wk ");
  return s;
}

function metricAlias(metric) {
  if (metric.fn === "count") return "count";
  if (metric.fn === "countDistinct") return `distinct_${metric.field}`;
  return `${metric.fn}_${metric.field}`;
}

function metricType(metric, entityName) {
  if (metric.fn === "count" || metric.fn === "countDistinct") return "count";
  const resolved = resolveField(entityName, metric.field);
  const t = resolved?.def?.type;
  if (metric.fn === "avg" && (t === "number" || t === "count")) return "number";
  return t ?? "number";
}

function metricLabel(metric, entityName) {
  if (metric.fn === "count") return "Count";
  const resolved = resolveField(entityName, metric.field);
  const base = resolved ? columnLabel(resolved) : metric.field;
  if (metric.fn === "countDistinct") return `Unique ${base.toLowerCase()}`;
  const prefix = { sum: "Total", avg: "Average", min: "Lowest", max: "Highest" }[metric.fn];
  return `${prefix} ${base.toLowerCase()}`;
}

function displayTotal(type, value) {
  if (value == null) return "—";
  if (type === "money") return rupeesDisplay(value);
  if (type === "weight_mg") return gramsFromMgDisplay(value);
  if (type === "weight_ug") return gramsFromUgDisplay(value);
  if (type === "datetime" || type === "ymd") return presentValue(type, value).model;
  return countDisplay(value);
}

function describeFilters(entityName, spec, defaultApplied) {
  const parts = [];
  for (const f of spec.filters ?? []) {
    const vals = filterValues(f);
    const shown = f.op === "between" ? `${f.value} – ${f.valueTo}` : vals.join(", ");
    parts.push(`${f.field} ${f.op}${shown ? ` ${shown}` : ""}`);
  }
  if (defaultApplied) parts.push(ENTITIES[entityName].defaultWhere.note);
  return parts.join(" · ");
}

/**
 * Validate + compile. Returns everything needed to run (and re-run for export).
 */
export function compileDataQuery(rawSpec, scope, { exportMode = false } = {}) {
  const parsed = dataQuerySpecSchema.safeParse(rawSpec ?? {});
  if (!parsed.success) {
    throw new QuerySpecError(
      `Invalid query: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  const spec = parsed.data;
  const entityName = spec.entity;
  const entity = ENTITIES[entityName];
  if (!entity) {
    throw new QuerySpecError(`Unknown entity "${entityName}".`, `Valid entities: ${Object.keys(ENTITIES).join(", ")}`);
  }

  const base = scopeMatch(entityName, scope);
  const computed = new Map(); // key -> expr
  const preLookups = new Set();
  const postFilters = [];
  const directFilters = [];
  let defaultApplied = false;

  const noteComputed = (resolved) => {
    if (resolved.kind === "direct" && resolved.def.expr) computed.set(resolved.key, resolved.def.expr);
  };

  // Filters
  const filteredFields = new Set();
  for (const filter of spec.filters) {
    const resolved = requireField(entityName, filter.field, "filter");
    filteredFields.add(resolved.kind === "direct" ? resolved.key : resolved.key);
    const predicate = compilePredicate(resolved, filter);
    const path = docPath(resolved);
    if (resolved.kind === "related") {
      preLookups.add(resolved.relationName);
      postFilters.push({ [path]: predicate });
    } else if (resolved.def.expr) {
      noteComputed(resolved);
      postFilters.push({ [path]: predicate });
    } else {
      directFilters.push({ [path]: predicate });
    }
  }
  if (entity.defaultWhere && !filteredFields.has(entity.defaultWhere.field)) {
    directFilters.push(entity.defaultWhere.clause);
    defaultApplied = true;
  }

  // Date range
  const dateFieldKey = spec.dateField || entity.dateField;
  const dateResolved = resolveField(entityName, dateFieldKey);
  if (!dateResolved || dateResolved.kind !== "direct" || !["datetime", "ymd"].includes(dateResolved.def.type)) {
    throw new QuerySpecError(`dateField "${dateFieldKey}" is not a date field on ${entityName}.`);
  }
  const dateRange = spec.dateFrom || spec.dateTo ? { from: spec.dateFrom ?? null, to: spec.dateTo ?? null } : null;
  if (dateRange?.from && dateRange?.to && dateRange.from > dateRange.to) {
    throw new QuerySpecError("dateFrom must be on or before dateTo.");
  }
  const dateClause = (range) => {
    if (!range) return null;
    const path = docPath(dateResolved);
    if (dateResolved.def.expr) noteComputed(dateResolved);
    const cond = {};
    if (dateResolved.def.type === "datetime") {
      if (range.from) cond.$gte = istStart(range.from);
      if (range.to) cond.$lte = istEnd(range.to);
    } else {
      if (range.from) cond.$gte = range.from;
      if (range.to) cond.$lte = range.to;
    }
    return Object.keys(cond).length ? { [path]: cond } : null;
  };

  const isAggregate = Boolean(spec.groupBy.length || spec.timeBucket || spec.metrics.length);

  // Group-by / metrics
  const groupRefs = spec.groupBy.map((ref) => requireField(entityName, ref, "groupBy"));
  const groupKeys = [];
  for (const [gi, g] of groupRefs.entries()) {
    const asked = spec.groupBy[gi];
    if (g.kind === "related" && g.relation.fields[0] === g.targetField) {
      // Group by the id, attach the label afterwards (names can collide).
      const localKey = Object.keys(entity.fields).find((k) => entity.fields[k].relation === g.relationName);
      const localDef = entity.fields[localKey];
      groupKeys.push({ ref: g, outKey: asked, idPath: localDef.path, labelRelation: g.relationName, idKey: `${g.relationName}Id` });
    } else {
      if (g.kind === "related") preLookups.add(g.relationName);
      noteComputed(g);
      groupKeys.push({ ref: g, outKey: asked, idPath: docPath(g) });
    }
  }
  const metrics = spec.metrics.length ? spec.metrics : isAggregate ? [{ fn: "count" }] : [];
  for (const m of metrics) {
    if (m.fn === "count") continue;
    if (!m.field) throw new QuerySpecError(`Metric ${m.fn} needs a field.`);
    const r = requireField(entityName, m.field, "metric");
    if (r.kind === "related" && m.fn !== "countDistinct") {
      throw new QuerySpecError(`Metric ${m.fn} must use a field of ${entityName} itself, not ${m.field}.`);
    }
    if (["sum", "avg"].includes(m.fn) && !["money", "number", "count", "weight_mg", "weight_ug"].includes(r.def.type)) {
      throw new QuerySpecError(`Cannot ${m.fn} ${m.field} (${r.def.type}).`);
    }
    if (r.kind === "related") preLookups.add(r.relationName);
    noteComputed(r);
  }
  if (spec.timeBucket && dateResolved.def.expr) noteComputed(dateResolved);

  // Select (list mode)
  let selectRefs = [];
  if (!isAggregate) {
    const refs = spec.select.length ? spec.select : entity.defaultSelect;
    selectRefs = refs.map((ref) => requireField(entityName, ref, "select"));
    for (const r of selectRefs) noteComputed(r);
  }

  // Sort
  let sort = spec.sort ?? null;
  let sortResolved = null;
  if (!isAggregate) {
    const s = sort ?? entity.defaultSort;
    sortResolved = requireField(entityName, s.by, "sort");
    noteComputed(sortResolved);
    if (sortResolved.kind === "related") preLookups.add(sortResolved.relationName);
    sort = { by: s.by, dir: s.dir ?? "desc" };
  }

  const limitCap = isAggregate ? GROUP_MAX_LIMIT : LIST_MAX_LIMIT;
  const defaultLimit = isAggregate ? (spec.timeBucket ? GROUP_MAX_LIMIT : GROUP_DEFAULT_LIMIT) : LIST_DEFAULT_LIMIT;
  const limit = exportMode ? EXPORT_ROW_CAP : Math.min(spec.limit ?? defaultLimit, limitCap);

  // Shared head of the pipeline (scope → filters)
  const head = (range) => {
    const stages = [];
    for (const s of entity.preStages ?? []) stages.push(s);
    const first = { $and: [base, ...directFilters] };
    const dc = dateClause(range);
    if (dc && !dateResolved.def.expr) first.$and.push(dc);
    stages.unshift({ $match: { $and: [base] } }); // scope first so preStages ($unwind) only touch this tenant
    stages.push({ $match: first });
    if (computed.size) {
      stages.push({ $addFields: Object.fromEntries([...computed].map(([k, expr]) => [`_c_${k}`, expr])) });
    }
    if (dc && dateResolved.def.expr) stages.push({ $match: dc });
    for (const rel of preLookups) stages.push(...lookupStages(entityName, rel, scope));
    if (postFilters.length) stages.push({ $match: { $and: postFilters } });
    return stages;
  };

  return {
    spec,
    entityName,
    entity,
    isAggregate,
    groupKeys,
    metrics,
    selectRefs,
    sort,
    sortResolved,
    limit,
    preLookups,
    dateResolved,
    dateRange,
    head,
    exportMode,
    defaultApplied,
    filterSummary: describeFilters(entityName, spec, defaultApplied),
    scope,
  };
}

function groupStage(compiled) {
  const { groupKeys, metrics, spec, dateResolved } = compiled;
  const id = {};
  if (spec.timeBucket) {
    const datePath = `$${docPath(dateResolved)}`;
    const dateExpr =
      dateResolved.def.type === "ymd" ? { $dateFromString: { dateString: datePath, onError: null, onNull: null } } : datePath;
    id.period = {
      $dateToString: {
        format: bucketFormat(spec.timeBucket),
        date: dateExpr,
        ...(dateResolved.def.type === "datetime" ? { timezone: "Asia/Kolkata" } : {}),
      },
    };
  }
  groupKeys.forEach((g, i) => {
    id[`g${i}`] = `$${g.idPath}`;
  });
  const acc = {};
  for (const m of metrics) {
    const alias = metricAlias(m);
    if (m.fn === "count") acc[alias] = { $sum: 1 };
    else {
      const r = resolveField(compiled.entityName, m.field);
      const p = `$${docPath(r)}`;
      if (m.fn === "countDistinct") acc[alias] = { $addToSet: p };
      else acc[alias] = { [`$${m.fn}`]: p };
    }
  }
  return { _id: Object.keys(id).length ? id : null, ...acc };
}

function metricFinalize(metrics) {
  const out = {};
  for (const m of metrics) {
    if (m.fn === "countDistinct") out[metricAlias(m)] = { $size: { $ifNull: [`$${metricAlias(m)}`, []] } };
  }
  return Object.keys(out).length ? [{ $addFields: out }] : [];
}

function aggregateGroupStages(compiled) {
  const { groupKeys, metrics, spec, limit, scope, entityName } = compiled;
  const sortBy = spec.sort?.by;
  const sortDir = spec.sort?.dir === "asc" ? 1 : -1;
  let sortStage;
  if (sortBy === "period" || (!sortBy && spec.timeBucket)) {
    sortStage = { "_id.period": sortBy ? sortDir : 1 };
  } else {
    const alias = sortBy && metrics.some((m) => metricAlias(m) === sortBy) ? sortBy : metricAlias(metrics[0]);
    const gIdx = groupKeys.findIndex((g) => g.outKey === sortBy || g.ref.key === sortBy);
    sortStage = gIdx >= 0 ? { [`_id.g${gIdx}`]: sortDir } : { [alias]: sortBy ? sortDir : -1 };
  }
  const groups = [
    { $group: groupStage(compiled) },
    ...metricFinalize(metrics),
    { $sort: { ...sortStage, _id: 1 } },
    { $limit: limit + 1 },
  ];
  groupKeys.forEach((g, i) => {
    if (!g.labelRelation) return;
    const rel = ENTITIES[entityName].relations[g.labelRelation];
    const target = ENTITIES[rel.entity];
    const labelDef = target.fields[rel.fields[0]];
    groups.push(
      {
        $lookup: {
          from: target.model.collection.name,
          localField: `_id.g${i}`,
          foreignField: "_id",
          pipeline: [{ $match: { tenantId: scope.tenantId } }, { $project: { [labelDef.path]: 1 } }],
          as: `_l${i}`,
        },
      },
      { $addFields: { [`_l${i}`]: { $arrayElemAt: [`$_l${i}.${labelDef.path}`, 0] } } },
    );
  });
  return groups;
}

function buildAggregatePipeline(compiled, range) {
  const { metrics, spec } = compiled;
  const head = compiled.head(range);
  const totals = [
    { $group: { ...groupStage({ ...compiled, groupKeys: [], spec: { ...spec, timeBucket: null } }), _id: null } },
    ...metricFinalize(metrics),
  ];
  return [...head, { $facet: { groups: aggregateGroupStages(compiled), totals } }];
}

/**
 * Export: same query without $facet (a facet result is one 16 MB document), streamed by cursor.
 * Returns { compiled, pipeline, shapeRow } where shapeRow(doc) → { [columnKey]: exportValue }.
 */
export function compileDataQueryForExport(rawSpec, scope) {
  const compiled = compileDataQuery(rawSpec, scope, { exportMode: true });
  const range = compiled.dateRange;
  if (!compiled.isAggregate) {
    const pipeline = [...compiled.head(range), ...listRowStages(compiled)];
    const columns = compiled.selectRefs.map((r) => ({ key: r.key, label: columnLabel(r), type: r.def.type }));
    const shapeRow = (doc) => {
      const out = {};
      for (const r of compiled.selectRefs) {
        const p = presentValue(r.def.type, doc[outName(r.key)], { maskPersonal: false });
        out[r.key] = exportCell(p.ui);
      }
      return out;
    };
    return { compiled, pipeline, columns, shapeRow };
  }
  const pipeline = [...compiled.head(range), ...aggregateGroupStages(compiled)];
  const probe = shapeAggregateResult(compiled, { groups: [], totals: [] });
  const shapeRow = (doc) => {
    const shaped = shapeAggregateResult({ ...compiled, limit: 1 }, { groups: [doc], totals: [] });
    const row = shaped.uiRows[0] ?? {};
    const out = {};
    for (const c of probe.columns) out[c.key] = exportCell(row[c.key]);
    return out;
  };
  return { compiled, pipeline, columns: probe.columns, shapeRow };
}

function exportCell(v) {
  if (v == null) return "";
  if (typeof v === "object") return v.display ?? v.value ?? "";
  return v;
}

function listRowStages(compiled) {
  const { selectRefs, sort, sortResolved, limit, entityName, scope, preLookups, entity } = compiled;
  const rows = [];
  const sortPath = docPath(sortResolved);
  rows.push({ $sort: { [sortPath]: sort.dir === "asc" ? 1 : -1, _id: 1 } });
  rows.push({ $limit: limit + 1 });
  const lateRelations = new Set();
  for (const r of selectRefs) if (r.kind === "related" && !preLookups.has(r.relationName)) lateRelations.add(r.relationName);
  for (const rel of lateRelations) rows.push(...lookupStages(entityName, rel, scope));
  const project = { _id: 1 };
  for (const r of selectRefs) project[outName(r.key)] = `$${docPath(r)}`;
  // Keep relation ids so follow-up questions can reference the same customer/enrolment.
  for (const r of selectRefs) {
    if (r.kind !== "related") continue;
    const localKey = Object.keys(entity.fields).find((k) => entity.fields[k].relation === r.relationName);
    if (localKey) project[localKey] = `$${entity.fields[localKey].path}`;
  }
  rows.push({ $project: project });
  return rows;
}

function buildListPipeline(compiled, range) {
  const head = compiled.head(range);
  return [...head, { $facet: { rows: listRowStages(compiled), total: [{ $count: "n" }] } }];
}

function shapeListResult(compiled, raw) {
  const { selectRefs, limit, entity } = compiled;
  const docs = raw?.rows ?? [];
  const truncated = docs.length > limit;
  const kept = truncated ? docs.slice(0, limit) : docs;
  const columns = selectRefs.map((r) => ({ key: r.key, label: columnLabel(r), type: columnTypeFor(r.def.type) }));
  const uiRows = [];
  const modelRows = [];
  for (const doc of kept) {
    const ui = { id: doc._id };
    const model = {};
    for (const r of selectRefs) {
      const v = doc[outName(r.key)];
      const p = presentValue(r.def.type, v, { isMobile: r.def.personal === "mobile" });
      ui[r.key] = p.ui;
      model[r.key] = p.model;
    }
    for (const [k, f] of Object.entries(entity.fields)) {
      if (f.relation && doc[k] != null) model[k] = String(doc[k]);
    }
    uiRows.push(ui);
    modelRows.push(model);
  }
  const totalMatching = raw?.total?.[0]?.n ?? kept.length;
  return { columns, uiRows, modelRows, totalMatching, truncated };
}

function shapeAggregateResult(compiled, raw) {
  const { groupKeys, metrics, spec, limit, entityName } = compiled;
  const groups = raw?.groups ?? [];
  const truncated = groups.length > limit;
  const kept = truncated ? groups.slice(0, limit) : groups;
  const columns = [];
  if (spec.timeBucket) {
    columns.push({ key: "period", label: { day: "Day", week: "Week", month: "Month", year: "Year" }[spec.timeBucket], type: "text" });
  }
  groupKeys.forEach((g) => columns.push({ key: g.outKey, label: columnLabel(g.ref), type: columnTypeFor(g.ref.def.type) }));
  for (const m of metrics) {
    columns.push({ key: metricAlias(m), label: metricLabel(m, entityName), type: columnTypeFor(metricType(m, entityName)) });
  }
  const uiRows = [];
  const modelRows = [];
  for (const doc of kept) {
    const ui = {};
    const model = {};
    if (spec.timeBucket) {
      ui.period = bucketLabel(spec.timeBucket, doc._id?.period);
      ui._periodKey = doc._id?.period ?? null;
      model.period = ui.period;
    }
    groupKeys.forEach((g, i) => {
      const rawKey = doc._id?.[`g${i}`];
      if (g.labelRelation) {
        const label = doc[`_l${i}`] ?? (rawKey == null ? "Unassigned" : String(rawKey));
        ui[g.outKey] = label;
        model[g.outKey] = label;
        if (rawKey != null) model[g.idKey] = String(rawKey);
      } else {
        const p = presentValue(g.ref.def.type, rawKey);
        ui[g.outKey] = p.ui ?? "—";
        model[g.outKey] = p.model ?? "—";
      }
    });
    for (const m of metrics) {
      const alias = metricAlias(m);
      const t = metricType(m, entityName);
      const v = doc[alias];
      const p = presentValue(t === "count" ? "count" : t, v);
      ui[alias] = p.ui ?? 0;
      model[alias] = p.model ?? "0";
    }
    uiRows.push(ui);
    modelRows.push(model);
  }
  const totalsDoc = raw?.totals?.[0] ?? {};
  const totals = metrics.map((m) => {
    const alias = metricAlias(m);
    const type = metricType(m, entityName);
    return {
      key: alias,
      label: metricLabel(m, entityName),
      type,
      value: totalsDoc[alias] ?? 0,
      display: displayTotal(type, totalsDoc[alias] ?? 0),
    };
  });
  return { columns, uiRows, modelRows, totals, truncated, groupCount: kept.length };
}

async function runPipeline(compiled, pipeline) {
  const maxTimeMS = compiled.exportMode ? QUERY_EXPORT_MAX_TIME_MS : QUERY_MAX_TIME_MS;
  const out = await compiled.entity.model
    .aggregate(pipeline)
    .option({ maxTimeMS, allowDiskUse: compiled.exportMode });
  return out?.[0] ?? {};
}

function rangeLabel(range) {
  if (!range) return null;
  if (range.from && range.to) {
    return range.from === range.to ? istDateDisplay(range.from) : `${istDateDisplay(range.from)} – ${istDateDisplay(range.to)}`;
  }
  if (range.from) return `since ${istDateDisplay(range.from)}`;
  if (range.to) return `until ${istDateDisplay(range.to)}`;
  return null;
}

/**
 * Run a data query. Returns a normalized result:
 * { kind:"data", entity, mode, columns, uiRows, modelRows, totals?, totalMatching?, truncated, previous?, meta }
 */
export async function runDataQuery(rawSpec, scope, { exportMode = false } = {}) {
  const compiled = compileDataQuery(rawSpec, scope, { exportMode });
  const range = compiled.dateRange;
  const meta = {
    entity: compiled.entityName,
    entityLabel: compiled.entity.label,
    dateField: compiled.dateResolved.key,
    dateRange: range,
    dateRangeLabel: rangeLabel(range),
    filterSummary: compiled.filterSummary,
    timeBucket: compiled.spec.timeBucket ?? null,
  };

  if (!compiled.isAggregate) {
    const raw = await runPipeline(compiled, buildListPipeline(compiled, range));
    const shaped = shapeListResult(compiled, raw);
    return { kind: "data", mode: "list", spec: compiled.spec, meta, ...shaped };
  }

  const raw = await runPipeline(compiled, buildAggregatePipeline(compiled, range));
  const shaped = shapeAggregateResult(compiled, raw);
  let previous = null;
  if (compiled.spec.compareToPrevious && range?.from && range?.to) {
    const prevRange = previousWindow(range.from, range.to);
    const prevRaw = await runPipeline(compiled, buildAggregatePipeline(compiled, prevRange));
    const prevShaped = shapeAggregateResult(compiled, prevRaw);
    previous = {
      range: prevRange,
      rangeLabel: rangeLabel(prevRange),
      totals: prevShaped.totals.map((t, i) => {
        const cur = shaped.totals[i]?.value ?? 0;
        const pct = t.value ? Math.round(((cur - t.value) / Math.abs(t.value)) * 1000) / 10 : null;
        return { ...t, changePct: pct };
      }),
    };
  }
  return { kind: "data", mode: "aggregate", spec: compiled.spec, meta, ...shaped, previous };
}

/** Exposed for tests: the exact pipeline a spec compiles to. */
export function debugPipeline(rawSpec, scope) {
  const compiled = compileDataQuery(rawSpec, scope);
  return compiled.isAggregate
    ? buildAggregatePipeline(compiled, compiled.dateRange)
    : buildListPipeline(compiled, compiled.dateRange);
}

export { rangeLabel };
