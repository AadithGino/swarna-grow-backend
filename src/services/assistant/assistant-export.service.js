import ExcelJS from "exceljs";
import { AppError } from "../../lib/app-error.js";
import { moneyRef } from "../../lib/money.js";
import { exportReportKey } from "../../lib/report-export.js";
import { ExportType, isEnumValue } from "../../constants/enums.js";
import { createExport } from "../reporting.service.js";
import {
  ASSISTANT_EXPORT_MAX_TIME_MS,
  ASSISTANT_EXPORT_ROW_CAP,
  ENTITY_REGISTRY,
} from "./schema-registry.js";
import { assistantDataScope, compileQuerySpec } from "./query-compiler.js";

const AGGREGATE_EXPORT_FIELDS = ["label", "count", "total", "key"];

const COLLECTIONS_LIST_EXTRA = [
  "receiptNumber",
  "customerName",
  "customerMobile",
  "schemeLabel",
  "enrollmentNumber",
  "collectedByName",
  "branchName",
  "targetCycle",
];

export function isAggregateQuerySpec(spec = {}) {
  return Boolean(spec.groupBy || spec.timeBucket || spec.aggregate);
}

export function exportableFieldsForQuery(entity, spec = {}) {
  if (!ENTITY_REGISTRY[entity]) return [];
  if (isAggregateQuerySpec(spec)) return [...AGGREGATE_EXPORT_FIELDS];
  const base = Object.keys(ENTITY_REGISTRY[entity].fields);
  if (entity === "collections") {
    return [...new Set([...base, ...COLLECTIONS_LIST_EXTRA])];
  }
  return base;
}

function assertExportFields(entity, spec, fields) {
  const allowed = new Set(exportableFieldsForQuery(entity, spec));
  for (const field of fields) {
    if (!allowed.has(field)) {
      throw new AppError("ASSISTANT_EXPORT_FIELD", `Unknown export field: ${field}`, 422, {
        field,
        allowed: [...allowed],
      });
    }
  }
}

function csvEscape(val) {
  const s = val == null ? "" : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatExportCell(field, value, entityDef) {
  const fieldDef = entityDef?.fields?.[field];
  if (value == null || value === "") return "";
  if (field === "total" || field === "amountPaise" || field.includes("Paise")) {
    const n = Number(value);
    if (Number.isFinite(n)) return moneyRef(n).amountDisplay;
  }
  if (fieldDef?.type === "date" || field === "paidAt" || field === "createdAt") {
    const d = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    }
  }
  if (typeof value === "object" && value?._id) return String(value._id);
  return String(value);
}

function resolveRowValue(row, field, spec) {
  if (isAggregateQuerySpec(spec)) {
    if (field === "label") {
      return row.label ?? row._id?.bucket ?? row._id?.key ?? "";
    }
    if (field === "key") {
      const k = row._id?.key ?? row._id?.bucket;
      return k != null ? String(k) : "";
    }
    if (field === "count") return row.count ?? "";
    if (field === "total") return row.total ?? "";
  }
  if (field === "customerId") return row.customerName ?? row.customerId ?? "";
  if (field === "schemeId") return row.schemeLabel ?? row.enrollmentNumber ?? row.schemeId ?? "";
  if (field === "branchId") return row.branchName ?? row.branchId ?? "";
  if (field === "collectedBy") return row.collectedByName ?? row.collectedBy ?? "";
  return row[field];
}

function exportSpecForFullList(spec) {
  return {
    ...spec,
    topN: undefined,
    limit: undefined,
  };
}

function reportKeyToExportType(reportKey) {
  for (const type of Object.values(ExportType)) {
    if (exportReportKey(type) === reportKey) return type;
  }
  if (reportKey === "ENROLMENT" && isEnumValue(ExportType, "SCHEME")) return ExportType.SCHEME;
  return null;
}

function exportFilename(entity, format) {
  const ext = format === "XLSX" ? "xlsx" : "csv";
  return `sidekick-${entity}-${Date.now()}.${ext}`;
}

async function writeCsvExport(res, cursor, fields, spec, entityDef) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.write(`${fields.map(csvEscape).join(",")}\n`);
  let rows = 0;
  for await (const doc of cursor) {
    if (rows >= ASSISTANT_EXPORT_ROW_CAP) break;
    const line = fields
      .map((f) =>
        csvEscape(formatExportCell(f, resolveRowValue(doc, f, spec), entityDef)),
      )
      .join(",");
    res.write(`${line}\n`);
    rows += 1;
  }
  res.end();
}

async function writeXlsxExport(res, cursor, fields, spec, entityDef) {
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
  const sheet = workbook.addWorksheet("Export");
  sheet.addRow(fields).commit();
  let rows = 0;
  for await (const doc of cursor) {
    if (rows >= ASSISTANT_EXPORT_ROW_CAP) break;
    sheet
      .addRow(
        fields.map((f) => formatExportCell(f, resolveRowValue(doc, f, spec), entityDef)),
      )
      .commit();
    rows += 1;
  }
  await workbook.commit();
}

export async function exportQuery(req, spec, { fields, format = "CSV" }) {
  const entity = spec.entity;
  const entityDef = ENTITY_REGISTRY[entity];
  if (!entityDef) {
    throw new AppError("ASSISTANT_INVALID_ENTITY", `Unknown entity: ${entity}`, 422);
  }
  if (!fields?.length) {
    throw new AppError("ASSISTANT_EXPORT_FIELDS", "Select at least one field to export.", 422);
  }
  assertExportFields(entity, spec, fields);

  const scope = assistantDataScope(req);
  const compiled = compileQuerySpec(exportSpecForFullList(spec), scope, { export: true });
  const cursor = compiled.Model.aggregate(compiled.pipeline)
    .option({ maxTimeMS: ASSISTANT_EXPORT_MAX_TIME_MS, allowDiskUse: true })
    .cursor({ batchSize: 500 });

  return {
    entity,
    format,
    fields,
    cursor,
    entityDef,
    spec,
    filename: exportFilename(entity, format),
  };
}

export async function streamQueryExportToResponse(req, res, spec, { fields, format = "CSV" }) {
  const prepared = await exportQuery(req, spec, { fields, format });
  res.setHeader("Content-Disposition", `attachment; filename="${prepared.filename}"`);
  if (format === "XLSX") {
    await writeXlsxExport(res, prepared.cursor, fields, spec, prepared.entityDef);
    return;
  }
  await writeCsvExport(res, prepared.cursor, fields, spec, prepared.entityDef);
}

export async function exportReportAction(req, action, format = "CSV") {
  const exportType = reportKeyToExportType(action.reportKey);
  if (!exportType) {
    throw new AppError(
      "ASSISTANT_EXPORT_UNSUPPORTED",
      `Report ${action.reportKey} must be exported from Reports.`,
      422,
    );
  }
  const reportFormat = format === "XLSX" ? "CSV" : format;
  const exportReq = {
    ...req,
    body: {
      type: exportType,
      format: reportFormat,
      filters: {
        ...(action.filters ?? {}),
        format: reportFormat,
      },
    },
  };
  return createExport(exportReq);
}
