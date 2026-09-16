import { adminCashReport } from "../cash.service.js";
import { baseEnvelope, paginateRows } from "./report-envelope.js";

const COLUMNS = [
  { key: "label", label: "Staff / branch", type: "text", sticky: true },
  { key: "collected", label: "Collected", type: "currency", align: "right" },
  { key: "handedOver", label: "Handed over", type: "currency", align: "right" },
  { key: "inHand", label: "In hand", type: "currency", align: "right", emphasis: true },
  { key: "handoverCount", label: "Handovers", type: "count", align: "right" },
  { key: "discrepancies", label: "Discrepancies", type: "count", align: "right" },
];

export async function buildCashHandoverReport(req) {
  const envelope = baseEnvelope(req, "CASH_HANDOVER", "Cash handover");
  const raw = await adminCashReport(req);

  const tableRows = (raw.groups ?? []).map((group) => ({
    key: String(group.key),
    label: group.label,
    collected: group.cashCollected,
    handedOver: group.handedOver,
    inHand: group.inHand,
    handoverCount: group.handoverCount ?? 0,
    discrepancies: group.discrepancies ?? 0,
    drilldownPath: `/cash-handovers?staffId=${group.key}`,
  }));

  const totals = raw.totals ?? {};
  const { rows, meta } = paginateRows(tableRows, req.query);

  return {
    ...envelope,
    summary: [
      { key: "COLLECTED", label: "Cash collected", value: totals.cashCollected, valueType: "currency" },
      { key: "HANDED", label: "Handed over", value: totals.handedOver, valueType: "currency" },
      { key: "IN_HAND", label: "In hand", value: totals.currentlyInHand, valueType: "currency" },
      { key: "DISCREPANCY", label: "Discrepancy", value: totals.discrepancyTotal, valueType: "currency" },
    ],
    charts: {
      collectedVsHandedOver: {
        chartType: "bar",
        title: "Collected vs handed over",
        yAxis: { type: "currency", label: "Amount" },
        series: [
          {
            key: "COLLECTED",
            name: "Collected",
            data: tableRows.map((row) => ({
              x: row.label,
              y: row.collected.amountPaise,
              yDisplay: row.collected.amountDisplay,
            })),
          },
          {
            key: "HANDED_OVER",
            name: "Handed over",
            data: tableRows.map((row) => ({
              x: row.label,
              y: row.handedOver.amountPaise,
              yDisplay: row.handedOver.amountDisplay,
            })),
          },
        ],
      },
    },
    columns: COLUMNS,
    rows,
    meta,
  };
}
