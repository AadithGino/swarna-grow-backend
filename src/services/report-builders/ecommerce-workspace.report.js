import {
  EcommerceOrderStatus,
} from "../../constants/enums.js";
import { moneyRef } from "../../lib/money.js";
import {
  aggregateOrdersPlacedDaily,
  aggregateProductLineTotals,
  computeEcommerceCollections,
  computeEcommerceCollectionsDaily,
} from "../../lib/ecommerce-workspace-collections.js";
import {
  aggregateWorkspaceSummary,
  istDateRangeMatch,
} from "../../lib/ecommerce-workspace-metrics.js";
import { EcommerceOrder } from "../../models/index.js";
import {
  baseEnvelope,
  buildCountTrendPoints,
  buildCurrencyTrendPoints,
  paginateRows,
  reportTrendGroupBy,
} from "./report-envelope.js";

function rowMoney(paise) {
  return moneyRef(paise);
}

function summaryMoney(key, label, paise, note) {
  return {
    key,
    label,
    value: rowMoney(paise),
    valueType: "currency",
    ...(note ? { note } : {}),
  };
}

function summaryCount(key, label, value, note) {
  return {
    key,
    label,
    value,
    valueType: "count",
    ...(note ? { note } : {}),
  };
}

function mergeDailyRefund(refundByDay) {
  const map = new Map();
  for (const row of refundByDay) {
    map.set(row.day, (map.get(row.day) ?? 0) + Number(row.amountPaise ?? 0));
  }
  return [...map.entries()].map(([day, amountPaise]) => ({ _id: day, amountPaise }));
}

function buildNetTrend(onlineRows, codRows, refundRows, from, to, groupBy) {
  const daySet = new Set([
    ...onlineRows.map((r) => String(r._id ?? r.day)),
    ...codRows.map((r) => String(r._id ?? r.day)),
    ...refundRows.map((r) => String(r._id ?? r.day)),
  ]);
  const merged = [...daySet].map((day) => {
    const online = onlineRows.find((r) => String(r._id ?? r.day) === day)?.amountPaise ?? 0;
    const cod = codRows.find((r) => String(r._id ?? r.day) === day)?.amountPaise ?? 0;
    const refund = refundRows.find((r) => String(r._id ?? r.day) === day)?.amountPaise ?? 0;
    return { _id: day, amountPaise: online + cod - refund };
  });
  return buildCurrencyTrendPoints(merged, from, to, groupBy);
}

export async function buildEcommerceSalesReport(req) {
  const envelope = baseEnvelope(req, "ECOMMERCE_SALES", "Ecommerce sales & collections");
  const { from, to } = envelope.period;
  const tenantId = req.auth.tenantId;
  const collections = await computeEcommerceCollections(tenantId, from, to);
  const trendGroupBy = reportTrendGroupBy(from, to, req.query);
  const daily = await computeEcommerceCollectionsDaily(tenantId, from, to);
  const onlineDaily = daily.onlineByDay.map((r) => ({ _id: r.day, amountPaise: r.amountPaise }));
  const codDaily = daily.codByDay.map((r) => ({ _id: r.day, amountPaise: r.amountPaise }));
  const refundDaily = mergeDailyRefund(daily.refundByDay);

  const tableRows = [
    {
      key: "online_collected",
      label: "Online collected (paidAt in period)",
      gross: rowMoney(collections.onlineCollectedPaise),
      count: collections.onlineCollectedCount,
    },
    {
      key: "cod_collected",
      label: "COD collected (collection recorded in period)",
      gross: rowMoney(collections.codCollectedPaise),
      count: collections.codCollectedCount,
    },
    {
      key: "tax",
      label: "Tax component on collected orders (included in order totals)",
      gross: rowMoney(collections.taxPaise),
      count: collections.collectedOrderCount,
    },
    {
      key: "fulfilment_charges",
      label: "Delivery/pickup charges on collected orders (included in totals)",
      gross: rowMoney(collections.fulfilmentChargePaise),
      count: collections.collectedOrderCount,
    },
    {
      key: "refund_outflow",
      label: "Refund outflow when recorded in period",
      gross: rowMoney(collections.refundOutflowPaise),
      count: 0,
    },
    {
      key: "net_collected",
      label: "Net collections (gross − refunds)",
      gross: rowMoney(collections.netCollectedPaise),
      count: collections.collectedOrderCount,
    },
  ];

  const { rows, meta } = paginateRows(tableRows, req.query);
  return {
    ...envelope,
    summary: [
      summaryMoney(
        "ONLINE_COLLECTED",
        "Online collected",
        collections.onlineCollectedPaise,
        "Confirmed online payment (paidAt) in this period.",
      ),
      summaryMoney(
        "COD_COLLECTED",
        "COD collected",
        collections.codCollectedPaise,
        "Cash recorded (codCollection.collectedAt) in this period.",
      ),
      summaryMoney(
        "GROSS_COLLECTED",
        "Gross collected",
        collections.grossCollectedPaise,
      ),
      summaryMoney(
        "REFUND_OUTFLOW",
        "Refund outflow",
        collections.refundOutflowPaise,
        "Provider succeeded + manual refunds recorded in period; may relate to older orders.",
      ),
      summaryMoney("NET_COLLECTED", "Net collected", collections.netCollectedPaise),
      summaryMoney(
        "TAX_COMPONENT",
        "Tax (component)",
        collections.taxPaise,
        "Part of collected order totals — not added again to gross.",
      ),
      summaryMoney(
        "FULFILMENT_COMPONENT",
        "Delivery charges (component)",
        collections.fulfilmentChargePaise,
        "Part of collected order totals — not added again to gross.",
      ),
    ],
    charts: {
      collectionsTrend: {
        chartType: "line",
        title: "Collections & refunds",
        subtitle: `IST ${from} → ${to} · grouped by ${trendGroupBy.toLowerCase()}`,
        yAxis: { type: "currency", label: "Amount" },
        series: [
          {
            key: "ONLINE",
            name: "Online collected",
            data: buildCurrencyTrendPoints(onlineDaily, from, to, trendGroupBy),
          },
          {
            key: "COD",
            name: "COD collected",
            data: buildCurrencyTrendPoints(codDaily, from, to, trendGroupBy),
          },
          {
            key: "REFUNDS",
            name: "Refund outflow",
            data: buildCurrencyTrendPoints(refundDaily, from, to, trendGroupBy),
          },
          {
            key: "NET",
            name: "Net collected",
            data: buildNetTrend(onlineDaily, codDaily, refundDaily, from, to, trendGroupBy),
          },
        ],
      },
    },
    columns: [
      { key: "label", label: "Metric", type: "text" },
      { key: "gross", label: "Amount", type: "currency" },
      { key: "count", label: "Count", type: "count" },
    ],
    rows,
    meta,
    totals: {
      grossCollected: rowMoney(collections.grossCollectedPaise),
      refundOutflow: rowMoney(collections.refundOutflowPaise),
      netCollected: rowMoney(collections.netCollectedPaise),
    },
  };
}

export async function buildEcommerceOrdersFulfilmentReport(req) {
  const envelope = baseEnvelope(req, "ECOMMERCE_ORDERS_FULFILMENT", "Ecommerce orders & fulfilment");
  const { from, to } = envelope.period;
  const tenantId = req.auth.tenantId;
  const placedRange = istDateRangeMatch("createdAt", from, to);
  const workspace = await aggregateWorkspaceSummary(tenantId, from, to);
  const trendGroupBy = reportTrendGroupBy(from, to, req.query);
  const placedDaily = await aggregateOrdersPlacedDaily(tenantId, from, to);

  const statuses = Object.values(EcommerceOrderStatus);
  const counts = await Promise.all(
    statuses.map(async (status) => ({
      status,
      count: await EcommerceOrder.countDocuments({ tenantId, status, ...placedRange }),
    })),
  );

  const tableRows = counts
    .filter((row) => row.count > 0)
    .map((row) => ({
      key: row.status,
      label: row.status.replaceAll("_", " ").toLowerCase(),
      status: row.status,
      count: row.count,
    }));

  const statusChartData = tableRows.map((row) => ({
    x: row.label,
    y: row.count,
    yDisplay: String(row.count),
    statusKey: row.status,
  }));

  const { rows, meta } = paginateRows(tableRows, req.query);
  const pipe = workspace.pipeline;
  return {
    ...envelope,
    summary: [
      summaryCount(
        "ORDERS_PLACED",
        "Orders placed in period",
        workspace.placement.ordersPlaced,
        "createdAt in selected range.",
      ),
      summaryCount(
        "AWAITING_FULFILMENT",
        "Awaiting fulfilment (live)",
        pipe.awaitingFulfilment,
        "Current snapshot — not limited to period.",
      ),
      summaryCount("SHIPPED_LIVE", "Shipped (live)", pipe.shipped, "Current snapshot."),
      summaryCount("DELIVERED_LIVE", "Delivered (live)", pipe.delivered, "Current snapshot."),
      summaryCount(
        "OPEN_CANCELLATIONS",
        "Open cancellation requests",
        pipe.openCancellationRequests,
        "Live pipeline.",
      ),
      summaryCount(
        "OPEN_RETURNS",
        "Open return requests",
        pipe.openReturnRequests,
        "Live pipeline.",
      ),
    ],
    charts: {
      placedTrend: {
        chartType: "line",
        title: "Orders placed",
        subtitle: `Placed in period · ${from} → ${to}`,
        yAxis: { type: "count", label: "Orders" },
        series: [
          {
            key: "PLACED",
            name: "Orders placed",
            data: buildCountTrendPoints(placedDaily, from, to, trendGroupBy),
          },
        ],
      },
      statusDistribution: {
        chartType: "donut",
        title: "Status at placement time (orders placed in period)",
        subtitle: "Counts by current status for orders created in range",
        series: [{ key: "STATUS", name: "Orders", data: statusChartData }],
      },
    },
    columns: [
      { key: "label", label: "Status", type: "text" },
      { key: "count", label: "Orders placed", type: "count" },
    ],
    rows,
    meta,
  };
}

export async function buildEcommerceProductsReport(req) {
  const envelope = baseEnvelope(req, "ECOMMERCE_PRODUCTS", "Ecommerce product performance");
  const { from, to } = envelope.period;
  const tenantId = req.auth.tenantId;
  const aggRows = await aggregateProductLineTotals(tenantId, from, to);

  let totalUnits = 0;
  let totalLinePaise = 0;
  const tableRows = aggRows.map((row, index) => {
    const units = Number(row.unitsOrdered ?? 0);
    const lineTotalPaise = Number(row.lineTotalPaise ?? 0);
    totalUnits += units;
    totalLinePaise += lineTotalPaise;
    const name = row._id?.name ?? "Product";
    return {
      key: String(row._id?.productId ?? row._id?.sku ?? index),
      productId: row._id?.productId ?? null,
      name,
      sku: row._id?.sku ?? null,
      unitsOrdered: units,
      lineTotalPaise,
      collectedSales: rowMoney(lineTotalPaise),
    };
  });

  const top = tableRows.slice(0, 10);
  const topChart = top.map((row) => ({
    x: String(row.name),
    y: row.lineTotalPaise,
    yDisplay: row.collectedSales.amountDisplay,
  }));

  const { rows, meta } = paginateRows(tableRows, req.query);
  return {
    ...envelope,
    summary: [
      summaryCount(
        "UNITS",
        "Units on collected orders",
        totalUnits,
        "From checkout line snapshots when payment/collection occurred in period.",
      ),
      summaryMoney(
        "COLLECTED_LINE_VALUE",
        "Collected line value",
        totalLinePaise,
        "Not net of returns — return/refund attribution is order-level.",
      ),
      summaryCount("DISTINCT_PRODUCTS", "Distinct products", tableRows.length),
      summaryCount(
        "TOP_PRODUCT_UNITS",
        "Top product (units)",
        top[0]?.unitsOrdered ?? 0,
        top[0]?.name ? String(top[0].name) : undefined,
      ),
    ],
    charts: {
      topProducts: {
        chartType: "bar",
        title: "Top products by collected line value",
        subtitle: `Collected orders in period · top ${Math.min(10, top.length)}`,
        yAxis: { type: "currency", label: "Line value" },
        series: [{ key: "PRODUCTS", name: "Collected line value", data: topChart }],
      },
    },
    columns: [
      { key: "name", label: "Product", type: "text" },
      { key: "sku", label: "SKU", type: "text" },
      { key: "unitsOrdered", label: "Units", type: "count" },
      { key: "collectedSales", label: "Collected line sales", type: "currency" },
    ],
    rows,
    meta,
  };
}
