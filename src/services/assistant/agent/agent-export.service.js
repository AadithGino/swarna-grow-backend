/**
 * Excel/CSV export for agent query_data answers: re-runs the same (re-validated) spec
 * under the caller's scope without the chat row cap and streams it.
 */
import ExcelJS from "exceljs";
import { AppError } from "../../../lib/app-error.js";
import { csvEscape } from "../assistant-export.service.js";
import { assistantDataScope } from "../query-compiler.js";
import {
  EXPORT_ROW_CAP,
  QUERY_EXPORT_MAX_TIME_MS,
  QuerySpecError,
  compileDataQueryForExport,
} from "./query-data.js";

export async function streamDataQueryExportToResponse(req, res, spec, { fields = [], format = "CSV" } = {}) {
  const scope = assistantDataScope(req);
  let prepared;
  try {
    prepared = compileDataQueryForExport(spec, scope);
  } catch (err) {
    if (err instanceof QuerySpecError) {
      throw new AppError("ASSISTANT_EXPORT_INVALID", err.message, 422);
    }
    throw err;
  }
  const { compiled, pipeline, columns, shapeRow } = prepared;
  const allowed = new Map(columns.map((c) => [c.key, c]));
  const selected = (fields?.length ? fields : columns.map((c) => c.key)).filter((f) => allowed.has(f));
  if (!selected.length) {
    throw new AppError("ASSISTANT_EXPORT_FIELDS", "Select at least one field to export.", 422, {
      allowed: [...allowed.keys()],
    });
  }
  const headers = selected.map((k) => allowed.get(k).label ?? k);
  const cursor = compiled.entity.model
    .aggregate(pipeline)
    .option({ maxTimeMS: QUERY_EXPORT_MAX_TIME_MS, allowDiskUse: true })
    .cursor({ batchSize: 500 });

  const ext = format === "XLSX" ? "xlsx" : "csv";
  res.setHeader("Content-Disposition", `attachment; filename="sidekick-${compiled.entityName}-${Date.now()}.${ext}"`);

  if (format === "XLSX") {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const sheet = workbook.addWorksheet("Sidekick export");
    sheet.addRow(headers).commit();
    let n = 0;
    for await (const doc of cursor) {
      if (n >= EXPORT_ROW_CAP) break;
      const row = shapeRow(doc);
      sheet.addRow(selected.map((k) => row[k] ?? "")).commit();
      n += 1;
    }
    await workbook.commit();
    return;
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.write(`${headers.map(csvEscape).join(",")}\n`);
  let n = 0;
  for await (const doc of cursor) {
    if (n >= EXPORT_ROW_CAP) break;
    const row = shapeRow(doc);
    res.write(`${selected.map((k) => csvEscape(row[k])).join(",")}\n`);
    n += 1;
  }
  res.end();
}
