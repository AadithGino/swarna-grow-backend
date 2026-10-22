import { moneyRef } from "../../lib/money.js";
import { exportableFieldsForQuery } from "./assistant-export.service.js";

function scalarValue(item) {
  if (item == null) return 0;
  if (typeof item === "number") return item;
  if (typeof item === "object" && item.amountPaise != null) return item.amountPaise;
  if (typeof item === "object" && item.weightMg != null) return item.weightMg;
  return item;
}

function valueTypeFromSummary(item) {
  return item?.valueType ?? "number";
}

export function bundleFromReport(report, action) {
  const summaryText =
    report?.period?.label != null
      ? `${report.title ?? "Report"} · ${report.period.label}`
      : (report?.title ?? "Report results");

  const statCards = (report?.summary ?? []).slice(0, 4).map((item) => ({
    label: item.label,
    value: scalarValue(item.value),
    valueType: valueTypeFromSummary(item),
    delta: item.change?.percent != null ? item.change.percent : undefined,
  }));

  let chart = null;
  let vizHint = "table";
  const charts = report?.charts ?? {};
  if (charts.byBranch?.series?.length) {
    const block = charts.byBranch;
    chart = {
      type: block.chartType === "line" ? "line" : "bar",
      title: block.title,
      yAxisType: block.yAxis?.type ?? "currency",
      series: block.series.map((s) => ({
        name: s.name,
        data: (s.data ?? []).map((pt) => ({ x: pt.x ?? pt.xDisplay ?? "", y: pt.y ?? 0 })),
      })),
    };
    vizHint = "branch-bar";
  } else if (charts.trend?.series?.length) {
    const block = charts.trend;
    chart = {
      type: "line",
      title: block.title,
      yAxisType: block.yAxis?.type ?? "currency",
      series: block.series.map((s) => ({
        name: s.name,
        data: (s.data ?? []).map((pt) => ({ x: pt.x ?? pt.xDisplay ?? "", y: pt.y ?? 0 })),
      })),
    };
    vizHint = "time-line";
  } else if (charts.byMode?.series?.length) {
    const block = charts.byMode;
    chart = {
      type: "donut",
      title: block.title,
      yAxisType: block.yAxis?.type ?? "currency",
      series: block.series.map((s) => ({
        name: s.name,
        data: (s.data ?? []).map((pt) => ({ x: pt.x ?? pt.label ?? "", y: pt.y ?? 0 })),
      })),
    };
    vizHint = "mode-donut";
  }

  const columns = (report?.columns ?? []).map((col) => ({
    key: col.key,
    label: col.label,
    type: col.type,
  }));
  const rows = (report?.rows ?? []).slice(0, 50).map((row) => flattenReportRow(row, columns));
  if (rows.length) vizHint = chart ? vizHint : "table";

  return {
    summaryText,
    narrative: null,
    statCards,
    chart,
    table: columns.length ? { columns, rows } : null,
    vizHint,
    action,
    exportRecommended: Boolean(report?.page?.hasMore),
    exportable: {
      reportKey: report?.reportKey ?? action?.reportKey,
      columns: columns.map((c) => c.key),
    },
  };
}

function flattenReportRow(row, columns = []) {
  const typeByKey = new Map(columns.map((col) => [col.key, col.type]));
  const out = { key: row.key ?? row.id };
  for (const [key, val] of Object.entries(row)) {
    if (key === "drilldownPath" || key === "key") continue;
    out[key] = formatReportCell(val, typeByKey.get(key));
  }
  return out;
}

function formatReportCell(val, columnType) {
  if (val == null) return null;
  if (columnType === "customer" && typeof val === "object") {
    return {
      cell: "customer",
      name: String(val.name ?? "—"),
      mobile: val.mobile ? String(val.mobile) : undefined,
    };
  }
  if (columnType === "staff" && typeof val === "object") {
    return {
      cell: "staff",
      name: String(val.name ?? val.label ?? "—"),
    };
  }
  if (typeof val === "object" && val.amountPaise != null) {
    const display = val.amountDisplay ?? moneyRef(val.amountPaise).amountDisplay;
    return { cell: "currency", display, paise: val.amountPaise };
  }
  if (typeof val === "object" && val.weightMg != null) {
    return {
      cell: "weight",
      display: val.weightDisplay ?? `${(val.weightMg / 1000).toFixed(3)} g`,
      weightMg: val.weightMg,
    };
  }
  if (typeof val === "object" && val.label != null && val.status == null) {
    return String(val.label);
  }
  if (typeof val === "object" && val.status != null) {
    return String(val.status);
  }
  if (typeof val === "object" && val.name != null) {
    return {
      cell: "customer",
      name: String(val.name),
      mobile: val.mobile ? String(val.mobile) : undefined,
    };
  }
  if (typeof val === "boolean") return val ? "Yes" : "No";
  return val;
}

function formatMonthBucketLabel(raw) {
  const s = String(raw ?? "").trim();
  const ym = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (ym) {
    return new Date(`${ym[1]}-${ym[2]}-01T12:00:00`).toLocaleDateString("en-IN", {
      month: "short",
      year: "numeric",
    });
  }
  return s || "—";
}

export function bundleFromQuery({ rows, exportRecommended }, spec, action) {
  const entity = spec.entity;
  const isMonthlyCollectionCompare =
    entity === "collections" &&
    spec.timeBucket === "month" &&
    spec.aggregate?.fn === "sum" &&
    !spec.groupBy;

  const isPaymentDetail =
    entity === "collections" &&
    !spec.groupBy &&
    !spec.timeBucket &&
    spec.limit === 1 &&
    rows.length === 1 &&
    rows[0].receiptNumber;

  let summaryText = isPaymentDetail
    ? `Latest payment · ${rows[0].receiptNumber ?? "receipt"}`
    : isMonthlyCollectionCompare
      ? "Monthly collection comparison"
      : `Query · ${entity}`;
  if (!isPaymentDetail && !isMonthlyCollectionCompare && spec.groupBy) {
    summaryText += ` grouped by ${spec.groupBy}`;
  }
  if (!isPaymentDetail && !isMonthlyCollectionCompare && spec.timeBucket) {
    summaryText += ` · ${spec.timeBucket} trend`;
  }
  if (isMonthlyCollectionCompare && spec.from && spec.to) {
    summaryText += ` · ${spec.from} – ${spec.to}`;
  }

  const statCards = [];
  if (isPaymentDetail) {
    const row = rows[0];
    if (row.amountPaise != null) {
      statCards.push({ label: "Amount", value: row.amountPaise, valueType: "currency" });
    }
    if (row.paymentSequence != null) {
      statCards.push({
        label: "Payment # on scheme",
        value: row.paymentSequence,
        valueType: "count",
      });
    }
  } else if (!spec.groupBy && !spec.timeBucket && rows.length === 1 && rows[0].count != null) {
    statCards.push({ label: "Count", value: rows[0].count, valueType: "count" });
  } else if (rows.length) {
    const totalCount = rows.reduce((sum, r) => sum + (r.count ?? 0), 0);
    statCards.push({ label: "Rows", value: rows.length, valueType: "count" });
    if (totalCount) statCards.push({ label: "Total count", value: totalCount, valueType: "count" });
  }

  let chart = null;
  let vizHint = "table";
  const groupLabel = (row) =>
    row.label ?? row._id?.bucket ?? row._id?.key ?? (typeof row._id === "string" ? row._id : "—");

  if (!isPaymentDetail && (spec.timeBucket || spec.groupBy)) {
    const points = rows.map((row) => {
      const raw = groupLabel(row);
      const x =
        spec.timeBucket === "month" ? formatMonthBucketLabel(raw) : String(raw);
      const y = row.total ?? row.count ?? 0;
      return { x, y: Number(y) };
    });
    chart = {
      type: spec.timeBucket ? "line" : "bar",
      title: spec.timeBucket ? "Trend" : "Breakdown",
      yAxisType: spec.aggregate?.fn === "sum" ? "currency" : "count",
      series: [{ name: spec.aggregate?.fn ?? "count", data: points }],
    };
    vizHint = spec.timeBucket ? "time-line" : "branch-bar";
  }

  let table = null;
  if (isPaymentDetail) {
    const row = rows[0];
    table = {
      columns: [
        { key: "customer", label: "Customer", type: "text" },
        { key: "scheme", label: "Scheme / plan", type: "text" },
        { key: "receipt", label: "Receipt", type: "text" },
        { key: "paidAt", label: "Paid at", type: "text" },
        { key: "collectedBy", label: "Collected by", type: "text" },
        { key: "branch", label: "Showroom", type: "text" },
        { key: "cycle", label: "Cycle", type: "text" },
      ],
      rows: [
        {
          customer: row.customerName ?? row.customerId ?? "—",
          scheme: row.schemeLabel ?? row.enrollmentNumber ?? row.schemeId ?? "—",
          receipt: row.receiptNumber ?? "—",
          paidAt: row.paidAt ? new Date(row.paidAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—",
          collectedBy: row.collectedByName ?? row.collectedBy ?? "—",
          branch: row.branchName ?? row.branchId ?? "—",
          cycle: row.targetCycle ?? (row.paymentSequence != null ? `#${row.paymentSequence}` : "—"),
        },
      ],
    };
    vizHint = "payment-detail";
  } else if (!spec.groupBy && !spec.timeBucket) {
    const columns = inferListColumns(rows);
    table = {
      columns,
      rows: rows.map((row) => {
        const flat = { id: String(row._id ?? "") };
        for (const col of columns) {
          flat[col.key] = row[col.key] ?? flat[col.key];
        }
        return flat;
      }),
    };
    vizHint = "table";
  } else if (chart) {
    const sumCurrency = spec.aggregate?.fn === "sum";
    table = {
      columns: [
        { key: "label", label: spec.timeBucket === "month" ? "Month" : "Group", type: "text" },
        {
          key: "value",
          label: sumCurrency ? "Collected" : "Count",
          type: sumCurrency ? "currency" : "number",
        },
        ...(sumCurrency ? [{ key: "payments", label: "Payments", type: "number" }] : []),
      ],
      rows: rows.map((row) => {
        const labelRaw = groupLabel(row);
        return {
          label:
            spec.timeBucket === "month" ? formatMonthBucketLabel(labelRaw) : String(labelRaw),
          value: row.total ?? row.count ?? 0,
          ...(sumCurrency ? { payments: row.count ?? 0 } : {}),
        };
      }),
    };
  }

  return {
    summaryText,
    narrative: null,
    statCards,
    chart,
    table,
    vizHint,
    action,
    exportRecommended,
    exportable: table
      ? {
          entity,
          fields: exportableFieldsForQuery(entity, spec),
        }
      : undefined,
  };
}

function inferListColumns(rows) {
  if (!rows.length) {
    return [
      { key: "name", label: "Name", type: "text" },
      { key: "status", label: "Status", type: "text" },
    ];
  }
  const sample = rows[0];
  const keys = ["name", "mobile", "customerNumber", "status", "amountPaise", "paidAt", "branchId"];
  return keys
    .filter((k) => sample[k] != null)
    .map((key) => ({
      key,
      label: key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()),
      type: key.includes("amount") || key.includes("Paise") ? "currency" : key.includes("At") ? "date" : "text",
    }));
}

function displayStatValue(card) {
  if (card.valueType === "currency") return moneyDisplay(card.value).amountDisplay;
  if (card.valueType === "percent") return `${card.value}%`;
  if (card.valueType === "weight") return `${(card.value / 1000).toFixed(3)} g`;
  return String(card.value);
}

function displaySampleRow(row) {
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    if (key === "drilldownPath" || key === "key") continue;
    if (val && typeof val === "object" && val.cell === "customer") {
      out[key] = val.mobile ? `${val.name} (${val.mobile})` : val.name;
    } else if (val && typeof val === "object" && val.cell === "currency") {
      out[key] = val.display;
    } else if (val && typeof val === "object" && val.cell === "weight") {
      out[key] = val.display;
    } else if (typeof val === "number" && (key.includes("Paise") || key.includes("amount"))) {
      out[key] = moneyDisplay(val).amountDisplay;
    } else {
      out[key] = val;
    }
  }
  return out;
}

export function factsFromBundle(bundle) {
  const yAxisType = bundle.chart?.yAxisType;
  const chartPoints = (bundle.chart?.series?.[0]?.data ?? []).slice(0, 12).map((pt) => ({
    x: pt.x,
    y:
      yAxisType === "currency" && typeof pt.y === "number"
        ? moneyDisplay(pt.y).amountDisplay
        : pt.y,
  }));
  return {
    period: bundle.summaryText,
    statCards: (bundle.statCards ?? []).map((c) => ({
      label: c.label,
      display: displayStatValue(c),
    })),
    chart: bundle.chart
      ? { type: bundle.chart.type, title: bundle.chart.title, points: chartPoints }
      : null,
    rowCount: bundle.table?.rows?.length ?? 0,
    sampleRows: (bundle.table?.rows ?? []).slice(0, 5).map(displaySampleRow),
  };
}

export function bundleFromClarify(action) {
  return {
    summaryText: action.question,
    narrative: null,
    statCards: [],
    chart: null,
    table: null,
    vizHint: "clarify",
    action,
    exportRecommended: false,
  };
}

export function bundleFromUnsupported(action) {
  return {
    summaryText: action.reason,
    narrative: null,
    statCards: [],
    chart: null,
    table: null,
    vizHint: "unsupported",
    action,
    exportRecommended: false,
  };
}

/** Text-only merged answer for multi-topic questions (no stat cards / charts in chat). */
export function bundleFromComposite(partBundles, action) {
  const titles = partBundles
    .map((p) => String(p.summaryText ?? "").split("·")[0]?.trim())
    .filter(Boolean);
  return {
    summaryText:
      titles.length > 1
        ? `Overview · ${titles.slice(0, 3).join(" · ")}`
        : (titles[0] ?? "Combined overview"),
    narrative: null,
    statCards: [],
    chart: null,
    table: null,
    vizHint: "composite-text",
    action,
    exportRecommended: partBundles.some((p) => p.exportRecommended),
  };
}

export function factsFromComposite(partBundles) {
  return {
    composite: true,
    sections: partBundles.map((bundle) => ({
      title: bundle.summaryText,
      statCards: factsFromBundle(bundle).statCards,
      sampleRows: factsFromBundle(bundle).sampleRows,
    })),
  };
}

export function moneyDisplay(paise) {
  return moneyRef(paise);
}
