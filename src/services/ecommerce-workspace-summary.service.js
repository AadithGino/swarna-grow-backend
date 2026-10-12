import { assertReportRange, generatedAtIst } from "./report-builders/report-envelope.js";
import { aggregateWorkspaceSummary } from "../lib/ecommerce-workspace-metrics.js";
import { moneyRef } from "../lib/money.js";

function moneyMetric(paise) {
  return moneyRef(paise);
}

export async function getEcommerceWorkspaceSummary(req) {
  const { from, to } = assertReportRange(req.query ?? {});
  const tenantId = req.auth.tenantId;
  const metrics = await aggregateWorkspaceSummary(tenantId, from, to);
  return {
    period: { from, to, timezone: "Asia/Kolkata" },
    generatedAt: generatedAtIst(),
    placement: metrics.placement,
    pipeline: metrics.pipeline,
    collections: {
      onlineCollected: moneyMetric(metrics.collections.onlineCollectedPaise),
      codCollected: moneyMetric(metrics.collections.codCollectedPaise),
      grossCollected: moneyMetric(metrics.collections.grossCollectedPaise),
      providerRefundOutflow: moneyMetric(metrics.collections.providerRefundOutflowPaise),
      manualRefundOutflow: moneyMetric(metrics.collections.manualRefundOutflowPaise),
      refundOutflow: moneyMetric(metrics.collections.refundOutflowPaise),
      netCollected: moneyMetric(metrics.collections.netCollectedPaise),
      collectedOrderCount: metrics.collections.collectedOrderCount,
      averageCollectedOrderValue: moneyMetric(metrics.collections.averageCollectedOrderValuePaise),
    },
  };
}
