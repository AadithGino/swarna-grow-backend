import { Message } from "../../models/index.js";
import { dateMatch } from "../../lib/query-filters.js";
import { baseEnvelope, paginateRows, reportDataScope } from "./report-envelope.js";

const TYPE_ROWS = [
  { key: "PAYMENT_DUE", messageType: "Due reminder" },
  { key: "PAYMENT_OVERDUE", messageType: "Overdue reminder" },
  { key: "SCHEME_MATURED", messageType: "Maturity alert" },
  { key: "PAYMENT_SUCCESS", messageType: "Receipt" },
];

const COLUMNS = [
  { key: "messageType", label: "Type", type: "text", sticky: true },
  { key: "sent", label: "Sent", type: "count", align: "right" },
  { key: "delivered", label: "Delivered", type: "count", align: "right" },
  { key: "failed", label: "Failed", type: "count", align: "right" },
  { key: "deliveryRate", label: "Rate", type: "percent", align: "right" },
];

function deliveryRate(delivered, sent) {
  if (!sent) return 0;
  return Math.round((delivered / sent) * 1000) / 10;
}

export async function buildReminderDeliveryReport(req) {
  const envelope = baseEnvelope(req, "REMINDER_DELIVERY", "Reminder delivery");
  const { from, to } = envelope.period;
  const match = { ...reportDataScope(req), ...dateMatch("createdAt", { from, to }) };

  const [byType, volumeByDay] = await Promise.all([
    Message.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$type",
          sent: { $sum: 1 },
          delivered: {
            $sum: {
              $cond: [{ $in: ["$status", ["DELIVERED", "READ"]] }, 1, 0],
            },
          },
          failed: {
            $sum: { $cond: [{ $eq: ["$status", "FAILED"] }, 1, 0] },
          },
        },
      },
    ]),
    Message.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const typeMap = new Map(byType.map((row) => [row._id, row]));

  let totalSent = 0;
  let totalDelivered = 0;
  let totalFailed = 0;

  const tableRows = TYPE_ROWS.map((def) => {
    const stats = typeMap.get(def.key) ?? { sent: 0, delivered: 0, failed: 0 };
    totalSent += stats.sent;
    totalDelivered += stats.delivered;
    totalFailed += stats.failed;
    return {
      key: def.key,
      messageType: def.messageType,
      sent: stats.sent,
      delivered: stats.delivered,
      failed: stats.failed,
      deliveryRate: deliveryRate(stats.delivered, stats.sent),
    };
  });

  for (const row of byType) {
    if (TYPE_ROWS.some((def) => def.key === row._id)) continue;
    totalSent += row.sent;
    totalDelivered += row.delivered;
    totalFailed += row.failed;
    tableRows.push({
      key: row._id,
      messageType: row._id.replace(/_/g, " ").toLowerCase(),
      sent: row.sent,
      delivered: row.delivered,
      failed: row.failed,
      deliveryRate: deliveryRate(row.delivered, row.sent),
    });
  }

  const { rows, meta } = paginateRows(tableRows, req.query);

  return {
    ...envelope,
    summary: [
      { key: "SENT", label: "Messages sent", value: totalSent, valueType: "count" },
      { key: "DELIVERED", label: "Delivered", value: totalDelivered, valueType: "count" },
      { key: "FAILED", label: "Failed", value: totalFailed, valueType: "count" },
      {
        key: "DELIVERY_RATE",
        label: "Delivery rate",
        value: deliveryRate(totalDelivered, totalSent),
        valueType: "percent",
      },
    ],
    charts: {
      volumeTrend: {
        chartType: "line",
        title: "Message volume",
        yAxis: { type: "count", label: "Messages" },
        series: [
          {
            key: "SENT",
            name: "Sent",
            data: volumeByDay.map((row) => ({ x: row._id, y: row.count })),
          },
        ],
      },
    },
    columns: COLUMNS,
    rows,
    meta,
  };
}
