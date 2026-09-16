import { Message, Tenant } from "../../models/index.js";
import { dateMatch } from "../../lib/query-filters.js";
import { moneyRef } from "../../lib/money.js";
import { baseEnvelope, paginateRows, periodBlock, reportDataScope } from "./report-envelope.js";

const COLUMNS = [
  { key: "label", label: "Period", type: "text", sticky: true },
  { key: "utility", label: "Utility", type: "count", align: "right" },
  { key: "marketing", label: "Marketing", type: "count", align: "right" },
  { key: "authentication", label: "Authentication", type: "count", align: "right" },
  { key: "total", label: "Total", type: "count", align: "right", emphasis: true },
];

function whatsappCategory(type) {
  if (type === "OTP") return "authentication";
  if (type === "SCHEME_JOINED") return "marketing";
  return "utility";
}

function weekRanges(from, to) {
  if (!from || !to) return [{ key: "all", label: "All messages", from: null, to: null }];
  const start = new Date(`${from}T00:00:00+05:30`);
  const end = new Date(`${to}T23:59:59.999+05:30`);
  const ranges = [];
  let cursor = new Date(start);
  let index = 1;
  while (cursor <= end) {
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);
    if (weekEnd > end) weekEnd.setTime(end.getTime());
    const fromYmd = cursor.toISOString().slice(0, 10);
    const toYmd = weekEnd.toISOString().slice(0, 10);
    ranges.push({
      key: `w${index}`,
      label: periodBlock(fromYmd, toYmd).label,
      from: fromYmd,
      to: toYmd,
    });
    cursor.setDate(cursor.getDate() + 7);
    index += 1;
  }
  return ranges;
}

export async function buildWhatsappUsageReport(req) {
  const envelope = baseEnvelope(req, "WHATSAPP_USAGE", "WhatsApp usage");
  const { from, to } = envelope.period;

  const [tenant, messages] = await Promise.all([
    Tenant.findById(req.auth.tenantId).select("subscription").lean(),
    Message.find({
      ...reportDataScope(req),
      channel: "WHATSAPP",
      ...dateMatch("createdAt", { from, to }),
    })
      .select("type createdAt")
      .lean(),
  ]);

  const quotaLimit = tenant?.subscription?.limits?.whatsappMessages ?? 0;
  const totalMessages = messages.length;
  const quotaPercent = quotaLimit ? Math.min(100, Math.round((totalMessages / quotaLimit) * 1000) / 10) : 0;
  const estimatedCostPaise = totalMessages * 490;

  const categoryTotals = { utility: 0, marketing: 0, authentication: 0 };
  for (const msg of messages) {
    categoryTotals[whatsappCategory(msg.type)] += 1;
  }

  const ranges = weekRanges(from, to);
  const tableRows = ranges.map((range) => {
    const bucket = { utility: 0, marketing: 0, authentication: 0 };
    for (const msg of messages) {
      if (range.from && range.to) {
        const day = msg.createdAt ? new Date(msg.createdAt).toISOString().slice(0, 10) : null;
        if (!day || day < range.from || day > range.to) continue;
      }
      bucket[whatsappCategory(msg.type)] += 1;
    }
    const total = bucket.utility + bucket.marketing + bucket.authentication;
    return { key: range.key, label: range.label, ...bucket, total };
  });

  const { rows, meta } = paginateRows(tableRows, req.query);

  return {
    ...envelope,
    summary: [
      { key: "QUOTA", label: "Quota used", value: quotaPercent, valueType: "percent" },
      { key: "CONVERSATIONS", label: "Conversations", value: totalMessages, valueType: "count" },
      { key: "COST", label: "Estimated cost", value: moneyRef(estimatedCostPaise), valueType: "currency" },
    ],
    charts: {
      byType: {
        chartType: "donut",
        title: "By message type",
        yAxis: { type: "count", label: "Messages" },
        series: [
          {
            key: "type",
            name: "Messages",
            data: [
              { x: "Utility", y: categoryTotals.utility },
              { x: "Marketing", y: categoryTotals.marketing },
              { x: "Authentication", y: categoryTotals.authentication },
            ],
          },
        ],
      },
    },
    columns: COLUMNS,
    rows,
    meta,
  };
}
