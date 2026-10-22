import { z } from "zod";
import {
  assertEntityField,
  assertReportKey,
  ENTITY_REGISTRY,
} from "../services/assistant/schema-registry.js";
import { AppError } from "../lib/app-error.js";

const filterOperator = z.enum(["eq", "in", "startsWith", "contains", "gte", "lte", "between", "exists"]);

const queryFilterSchema = z.object({
  field: z.string().min(1),
  op: filterOperator,
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional(),
  valueTo: z.union([z.string(), z.number()]).optional(),
});

const querySpecSchema = z.object({
  entity: z.string().min(1),
  filters: z.array(queryFilterSchema).default([]),
  period: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.string().optional(),
  aggregate: z
    .object({
      fn: z.enum(["count", "sum", "avg", "min", "max"]),
      field: z.string().optional(),
    })
    .optional(),
  timeBucket: z.enum(["day", "week", "month"]).optional(),
  topN: z.coerce.number().int().min(1).max(50).optional(),
  sort: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const reportFiltersSchema = z
  .object({
    period: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    branchId: z.string().optional(),
    planId: z.string().optional(),
  })
  .optional();

const actionReportSchema = z.object({
  kind: z.literal("report"),
  reportKey: z.string().min(1),
  filters: reportFiltersSchema,
});

const actionQuerySchema = z.object({
  kind: z.literal("query"),
  spec: querySpecSchema,
});

const actionClarifySchema = z.object({
  kind: z.literal("clarify"),
  question: z.string().min(1).max(500),
});

const actionUnsupportedSchema = z.object({
  kind: z.literal("unsupported"),
  reason: z.string().min(1).max(500),
});

const compositeReportItemSchema = z.object({
  reportKey: z.string().min(1),
  filters: reportFiltersSchema,
});

const actionCompositeSchema = z.object({
  kind: z.literal("composite"),
  reports: z.array(compositeReportItemSchema).min(2).max(3),
});

export const assistantActionSchema = z.discriminatedUnion("kind", [
  actionReportSchema,
  actionQuerySchema,
  actionCompositeSchema,
  actionClarifySchema,
  actionUnsupportedSchema,
]);

export const assistantRenameBody = z.object({
  title: z.string().trim().min(1).max(120),
});

export const assistantExportBody = z
  .object({
    action: assistantActionSchema,
    fields: z.array(z.string().min(1)).default([]),
    format: z.enum(["CSV", "XLSX"]).default("CSV"),
  })
  .strict();

export const assistantChatBody = z.object({
  message: z.string().trim().min(1).max(2000),
  conversationId: z.string().max(64).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(2000).optional(),
        action: z.any().optional(),
        summary: z.string().max(500).optional(),
      }),
    )
    .max(10)
    .optional(),
});

function validateFilterAgainstRegistry(entity, filter) {
  const fieldCheck = assertEntityField(entity, filter.field);
  if (!fieldCheck.ok) {
    throw new AppError("ASSISTANT_INVALID_FIELD", fieldCheck.reason, 422);
  }
  if (!fieldCheck.def.operators.includes(filter.op)) {
    throw new AppError(
      "ASSISTANT_INVALID_OPERATOR",
      `Operator ${filter.op} is not allowed on ${entity}.${filter.field}`,
      422,
    );
  }
}

export function validateAssistantAction(raw) {
  const parsed = assistantActionSchema.parse(raw);
  if (parsed.kind === "report") {
    const keyCheck = assertReportKey(parsed.reportKey);
    if (!keyCheck.ok) {
      throw new AppError("ASSISTANT_INVALID_REPORT", keyCheck.reason, 422);
    }
    return parsed;
  }
  if (parsed.kind === "composite") {
    for (const item of parsed.reports) {
      const keyCheck = assertReportKey(item.reportKey);
      if (!keyCheck.ok) {
        throw new AppError("ASSISTANT_INVALID_REPORT", keyCheck.reason, 422);
      }
    }
    return parsed;
  }
  if (parsed.kind === "query") {
    const { entity, spec } = { entity: parsed.spec.entity, spec: parsed.spec };
    if (!ENTITY_REGISTRY[entity]) {
      throw new AppError("ASSISTANT_INVALID_ENTITY", `Unknown entity: ${entity}`, 422);
    }
    for (const filter of spec.filters ?? []) {
      validateFilterAgainstRegistry(entity, filter);
    }
    if (spec.groupBy) {
      const gb = ENTITY_REGISTRY[entity].groupByFields ?? [];
      if (!gb.includes(spec.groupBy) && !ENTITY_REGISTRY[entity].fields[spec.groupBy]?.groupBy) {
        throw new AppError("ASSISTANT_INVALID_GROUPBY", `Cannot group ${entity} by ${spec.groupBy}`, 422);
      }
    }
    if (spec.aggregate?.field) {
      const aggField = assertEntityField(entity, spec.aggregate.field);
      if (!aggField.ok || !aggField.def.aggregate) {
        throw new AppError("ASSISTANT_INVALID_AGGREGATE", `Field ${spec.aggregate.field} cannot be aggregated`, 422);
      }
    }
    return parsed;
  }
  return parsed;
}
