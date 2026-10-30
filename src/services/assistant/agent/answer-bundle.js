/**
 * Turns the agent's final_answer + the turn's tool results into the AssistantBundle the
 * admin UI renders. Visual blocks are built ONLY from server-side results (by resultId),
 * never from figures the model typed.
 */
import { statValueType, uiNumeric } from "./format.js";

const UI_TABLE_ROW_CAP = 100;
const MAX_BLOCKS = 6;

function metricAliases(spec) {
  const metrics = spec.metrics?.length ? spec.metrics : [{ fn: "count" }];
  return metrics.map((m) =>
    m.fn === "count" ? "count" : m.fn === "countDistinct" ? `distinct_${m.field}` : `${m.fn}_${m.field}`,
  );
}

function metricColumns(data) {
  const aliases = new Set(metricAliases(data.spec));
  return data.columns.filter((c) => aliases.has(c.key));
}

function numericCell(v) {
  if (v == null) return 0;
  if (typeof v === "object") return Number(v.value ?? 0);
  return Number(v) || 0;
}

function yAxisTypeFor(col) {
  if (!col) return "count";
  if (col.type === "currency") return "currency";
  if (col.type === "weight") return "weight";
  return "count";
}

function statsFromData(data) {
  if (data.mode === "list") {
    return [{ label: data.meta.entityLabel, value: data.totalMatching, valueType: "count" }];
  }
  const prevBy = new Map((data.previous?.totals ?? []).map((t) => [t.key, t]));
  return data.totals.slice(0, 4).map((t) => ({
    label: t.label,
    value: uiNumeric(t.type, t.value),
    valueType: statValueType(t.type === "count" ? "count" : t.type),
    ...(prevBy.get(t.key)?.changePct != null ? { delta: prevBy.get(t.key).changePct } : {}),
    ...(prevBy.has(t.key) ? { previous: uiNumeric(t.type, prevBy.get(t.key).value), previousLabel: data.previous.rangeLabel } : {}),
  }));
}

function chartFromData(data, chartType, title) {
  if (data.mode !== "aggregate" || data.uiRows.length < 2) return null;
  const allMetrics = metricColumns(data);
  const metrics = allMetrics.filter((c) => ["currency", "count", "weight"].includes(c.type));
  const metric = metrics[0];
  if (!metric) return null;
  const groupKeys = data.columns.filter((c) => c.key !== "period" && !allMetrics.includes(c)).map((c) => c.key);
  const hasTime = Boolean(data.meta.timeBucket);
  const yAxisType = yAxisTypeFor(metric);
  const label = (row, key) => {
    const v = row[key];
    if (v == null) return "—";
    if (typeof v === "object") return String(v.display ?? v.value ?? "—");
    return String(v);
  };

  if (hasTime && groupKeys.length) {
    const seriesKey = groupKeys[0];
    const periods = [...new Set(data.uiRows.map((r) => r.period))];
    const names = [...new Set(data.uiRows.map((r) => label(r, seriesKey)))].slice(0, 6);
    return {
      type: chartType === "bar" ? "bar" : "line",
      title: title ?? `${metric.label} by ${data.columns.find((c) => c.key === seriesKey)?.label?.toLowerCase() ?? seriesKey}`,
      yAxisType,
      series: names.map((name) => ({
        name,
        data: periods.map((p) => {
          const row = data.uiRows.find((r) => r.period === p && label(r, seriesKey) === name);
          return { x: p, y: numericCell(row?.[metric.key]) };
        }),
      })),
    };
  }
  if (hasTime) {
    return {
      type: chartType === "bar" || (chartType !== "line" && data.uiRows.length <= 14) ? "bar" : "line",
      title: title ?? metric.label,
      yAxisType,
      series: metrics.slice(0, 1).map((m) => ({
        name: m.label,
        data: data.uiRows.map((r) => ({ x: r.period, y: numericCell(r[m.key]) })),
      })),
    };
  }
  const xKey = groupKeys[0];
  const rows = data.uiRows.slice(0, 24);
  const x = (r) => groupKeys.map((k) => label(r, k)).join(" · ") || label(r, xKey);
  const donutOk = rows.length <= 6 && metric.type !== "weight";
  return {
    type: chartType === "donut" && donutOk ? "donut" : chartType === "line" ? "line" : "bar",
    title: title ?? `${metric.label} by ${data.columns.find((c) => c.key === xKey)?.label?.toLowerCase() ?? xKey}`,
    yAxisType,
    series: [{ name: metric.label, data: rows.map((r) => ({ x: x(r), y: numericCell(r[metric.key]) })) }],
  };
}

function tableFromData(result, title) {
  const data = result.data;
  const rows = data.uiRows.slice(0, UI_TABLE_ROW_CAP).map((r) => {
    const { _periodKey, ...rest } = r;
    return rest;
  });
  return {
    type: "table",
    title: title ?? result.title,
    table: { columns: data.columns, rows },
    rowCount: data.mode === "list" ? data.totalMatching : data.uiRows.length,
    exportRecommended: Boolean(data.truncated || data.uiRows.length > UI_TABLE_ROW_CAP || (data.mode === "list" && data.totalMatching > rows.length)),
    exportable: { entity: "dataQuery", fields: data.columns.map((c) => c.key) },
    action: result.exportAction,
  };
}

function overrideChartType(chart, chartType) {
  if (!chart || !chartType) return chart;
  if (chartType === "donut" && chart.series?.length === 1 && chart.series[0].data.length <= 6) return { ...chart, type: "donut" };
  if (chartType === "bar" || chartType === "line") return { ...chart, type: chartType };
  return chart;
}

/** Render one requested block from a stored result. Returns an array (customer overview yields 2 tables). */
function renderBlock(spec, result) {
  if (!result) return [];
  const { type, chartType, title } = spec;
  switch (result.kind) {
    case "data": {
      if (type === "stats") return [{ type: "stats", title, cards: statsFromData(result.data) }];
      if (type === "chart") {
        const chart = chartFromData(result.data, chartType, title);
        return chart ? [{ type: "chart", chart }] : [];
      }
      return [tableFromData(result, title)];
    }
    case "report":
    case "collection": {
      const b = result.bundle;
      if (type === "stats") return b.statCards?.length ? [{ type: "stats", title, cards: b.statCards }] : [];
      if (type === "chart") return b.chart ? [{ type: "chart", chart: overrideChartType(title ? { ...b.chart, title } : b.chart, chartType) }] : [];
      if (!b.table?.columns?.length || !b.table?.rows?.length) return [];
      return [
        {
          type: "table",
          title: title ?? result.title,
          table: { columns: b.table.columns, rows: b.table.rows.slice(0, UI_TABLE_ROW_CAP) },
          rowCount: b.table.rows.length,
          exportRecommended: Boolean(b.exportRecommended),
          exportable: b.exportable,
          action: result.exportAction,
        },
      ];
    }
    case "customer": {
      if (type === "stats") return [{ type: "stats", title, cards: result.statCards }];
      if (type === "chart") return [];
      return result.tables
        .filter((t) => t.table.rows.length)
        .map((t) => ({ type: "table", title: t.title, table: t.table, rowCount: t.table.rows.length }));
    }
    case "table": {
      if (type !== "table" || !result.table.rows.length) return [];
      return [{ type: "table", title: title ?? result.title, table: result.table, rowCount: result.table.rows.length }];
    }
    default:
      return [];
  }
}

/** When the model asked for no visuals, pick sensible ones from the most relevant result. */
function defaultBlockSpecs(results) {
  const list = [...results.values()].filter((r) => r.kind !== "help" && r.kind !== "guide");
  const last = list[list.length - 1];
  if (!last) return [];
  const id = last.id;
  if (last.kind === "data") {
    const d = last.data;
    if (d.mode === "list") return d.uiRows.length ? [{ type: "table", resultId: id }] : [];
    const multi = d.uiRows.length >= 2;
    const specs = [{ type: "stats", resultId: id }];
    if (multi) specs.push({ type: "chart", resultId: id }, { type: "table", resultId: id });
    return specs;
  }
  if (last.kind === "report" || last.kind === "collection") {
    return [{ type: "stats", resultId: id }, { type: "chart", resultId: id }, { type: "table", resultId: id }];
  }
  if (last.kind === "customer") return [{ type: "stats", resultId: id }, { type: "table", resultId: id }];
  if (last.kind === "table") return last.table.rows.length > 1 ? [{ type: "table", resultId: id }] : [];
  return [];
}

function appliedFiltersFrom(results) {
  const first = [...results.values()].find((r) => r.kind === "data");
  if (first) {
    const m = first.data.meta;
    return {
      dateRange: m.dateRangeLabel ?? "All time",
      timezone: "Asia/Kolkata",
      subject: m.entityLabel,
      ...(m.filterSummary ? { grouping: m.filterSummary } : {}),
    };
  }
  const rep = [...results.values()].find((r) => r.kind === "report" || r.kind === "collection");
  if (rep?.bundle?.appliedFilters) return rep.bundle.appliedFilters;
  return undefined;
}

function sanitizeFollowUps(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const s = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length === 3) break;
  }
  return out;
}

/** Compact memory of this turn so follow-ups can reuse entities, filters and ids. */
export function turnMemory(calls) {
  return calls
    .filter((c) => c.name !== "final_answer")
    .slice(0, 6)
    .map((c) => {
      const { purpose: _purpose, ...args } = c.args ?? {};
      let summary;
      try {
        summary = JSON.stringify(c.forModel ?? c.error ?? {});
      } catch {
        summary = "";
      }
      return {
        tool: c.name,
        args,
        resultId: c.resultId ?? null,
        summary: summary.length > 700 ? `${summary.slice(0, 697)}…` : summary,
      };
    });
}

/**
 * @param {{ final: object|null, results: Map, steps: object[], calls: object[], usage: object, model: string, fallbackText?: string }} input
 */
export function buildAgentBundle({ final, results, steps, calls, usage, model, fallbackText }) {
  const answer = String(final?.answer ?? fallbackText ?? "").trim();
  const requested = Array.isArray(final?.blocks) ? final.blocks : [];
  const specs = (requested.length ? requested : final?.needsClarification ? [] : defaultBlockSpecs(results))
    .filter((b) => b && typeof b === "object" && results.has(String(b.resultId)))
    .map((b) => ({ ...b, resultId: String(b.resultId) }));

  const blocks = [];
  const seen = new Set();
  for (const spec of specs) {
    const key = `${spec.type}:${spec.resultId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const block of renderBlock(spec, results.get(spec.resultId))) {
      if (blocks.length < MAX_BLOCKS) blocks.push(block);
    }
  }

  const firstStats = blocks.find((b) => b.type === "stats");
  const firstChart = blocks.find((b) => b.type === "chart");
  const firstTable = blocks.find((b) => b.type === "table");
  const firstResult = [...results.values()].find((r) => r.kind !== "guide") ?? [...results.values()][0];
  const guide = [...results.values()].reverse().find((r) => r.kind === "guide")?.guide ?? final?.guide ?? null;
  const summaryText =
    String(final?.title ?? "").trim().slice(0, 80) || firstResult?.title || "Sidekick";

  return {
    engine: "agent",
    summaryText,
    narrative: answer || null,
    statCards: firstStats?.cards ?? [],
    chart: firstChart?.chart ?? null,
    table: firstTable?.table ?? null,
    vizHint: blocks.length ? "agent-blocks" : "agent-text",
    blocks,
    steps,
    followUps: sanitizeFollowUps(final?.followUps),
    needsClarification: Boolean(final?.needsClarification),
    ...(guide ? { guide } : {}),
    appliedFilters: appliedFiltersFrom(results),
    ...(firstTable?.action ? { action: firstTable.action } : {}),
    ...(firstTable?.exportable ? { exportable: firstTable.exportable } : {}),
    exportRecommended: Boolean(firstTable?.exportRecommended),
    memory: turnMemory(calls),
    usage: usage ? { ...usage, model } : undefined,
  };
}
