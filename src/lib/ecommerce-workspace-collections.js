/**
 * Shared ecommerce money rules for workspace summary and admin reports.
 * Refund outflow uses recorded/completion timestamps (not in-flight updates).
 * Refunds may relate to orders placed outside the report period.
 */
import { env } from "../config/env.js";
import {
  EcommerceCodCollectionStatus,
  EcommercePaymentExceptionRefundStatus,
  EcommercePaymentMethod,
} from "../constants/enums.js";
import { dateMatch } from "./query-filters.js";
import {
  EcommerceOrder,
  EcommerceOrderCancellationRequest,
  EcommerceOrderReturnRequest,
  EcommercePaymentExceptionRefund,
} from "../models/index.js";
import { istDateRangeMatch, REFUND_OUTFLOW_STATUSES, sumPaise } from "./ecommerce-workspace-metrics.js";

const TZ = env.APP_TIMEZONE ?? "Asia/Kolkata";

function dayGroup(field) {
  return {
    $dateToString: { format: "%Y-%m-%d", date: `$${field}`, timezone: TZ },
  };
}

export async function aggregateProviderRefundOutflowPaise(tenantId, from, to) {
  const rows = await EcommercePaymentExceptionRefund.find({
    tenantId,
    status: EcommercePaymentExceptionRefundStatus.SUCCEEDED,
    ...istDateRangeMatch("updatedAt", from, to),
  })
    .select("amountPaise")
    .lean();
  return sumPaise(rows, (r) => r.amountPaise);
}

export async function aggregateExceptionManualRefundOutflowPaise(tenantId, from, to) {
  const rows = await EcommercePaymentExceptionRefund.find({
    tenantId,
    status: EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED,
    ...istDateRangeMatch("updatedAt", from, to),
  })
    .select("amountPaise")
    .lean();
  return sumPaise(rows, (r) => r.amountPaise);
}

export async function aggregateCodCancellationManualRefundPaise(tenantId, from, to) {
  const rows = await EcommerceOrderCancellationRequest.find({
    tenantId,
    "codManualRefund.recordedAt": { $ne: null },
    ...istDateRangeMatch("codManualRefund.recordedAt", from, to),
  })
    .select("codManualRefund.amountPaise")
    .lean();
  return sumPaise(rows, (r) => r.codManualRefund?.amountPaise);
}

export async function aggregateReturnManualRefundPaise(tenantId, from, to) {
  const rows = await EcommerceOrderReturnRequest.find({
    tenantId,
    manualRefundRecordedAt: { $ne: null },
    ...istDateRangeMatch("manualRefundRecordedAt", from, to),
  })
    .select("manualRefundProof.amountPaise")
    .lean();
  return sumPaise(rows, (r) => r.manualRefundProof?.amountPaise);
}

export async function computeEcommerceCollections(tenantId, from, to) {
  const tenantScope = { tenantId };
  const paidAtRange = istDateRangeMatch("paidAt", from, to);
  const codCollectedRange = istDateRangeMatch("codCollection.collectedAt", from, to);

  const [
    onlineAgg,
    codAgg,
    taxAgg,
    fulfilmentAgg,
    providerRefundPaise,
    exceptionManualPaise,
    codCancelManualPaise,
    returnManualPaise,
  ] = await Promise.all([
    EcommerceOrder.aggregate([
      {
        $match: {
          ...tenantScope,
          paymentMethod: EcommercePaymentMethod.ONLINE,
          paidAt: { $ne: null },
          ...dateMatch("paidAt", { from, to }),
        },
      },
      {
        $group: {
          _id: null,
          amountPaise: { $sum: "$totalPaise" },
          taxPaise: { $sum: "$taxPaise" },
          fulfilmentPaise: { $sum: "$fulfilmentChargePaise" },
          count: { $sum: 1 },
        },
      },
    ]),
    EcommerceOrder.aggregate([
      {
        $match: {
          ...tenantScope,
          paymentMethod: EcommercePaymentMethod.COD,
          "codCollection.status": EcommerceCodCollectionStatus.COLLECTED,
          ...dateMatch("codCollection.collectedAt", { from, to }),
        },
      },
      {
        $group: {
          _id: null,
          amountPaise: {
            $sum: {
              $ifNull: ["$codCollection.amountPaise", "$totalPaise"],
            },
          },
          taxPaise: { $sum: "$taxPaise" },
          fulfilmentPaise: { $sum: "$fulfilmentChargePaise" },
          count: { $sum: 1 },
        },
      },
    ]),
    EcommerceOrder.aggregate([
      {
        $match: {
          ...tenantScope,
          $or: [
            {
              paymentMethod: EcommercePaymentMethod.ONLINE,
              paidAt: { $ne: null },
              ...paidAtRange,
            },
            {
              paymentMethod: EcommercePaymentMethod.COD,
              "codCollection.status": EcommerceCodCollectionStatus.COLLECTED,
              ...codCollectedRange,
            },
          ],
        },
      },
      { $group: { _id: null, taxPaise: { $sum: "$taxPaise" } } },
    ]),
    EcommerceOrder.aggregate([
      {
        $match: {
          ...tenantScope,
          $or: [
            {
              paymentMethod: EcommercePaymentMethod.ONLINE,
              paidAt: { $ne: null },
              ...paidAtRange,
            },
            {
              paymentMethod: EcommercePaymentMethod.COD,
              "codCollection.status": EcommerceCodCollectionStatus.COLLECTED,
              ...codCollectedRange,
            },
          ],
        },
      },
      { $group: { _id: null, fulfilmentPaise: { $sum: "$fulfilmentChargePaise" } } },
    ]),
    aggregateProviderRefundOutflowPaise(tenantId, from, to),
    aggregateExceptionManualRefundOutflowPaise(tenantId, from, to),
    aggregateCodCancellationManualRefundPaise(tenantId, from, to),
    aggregateReturnManualRefundPaise(tenantId, from, to),
  ]);

  const onlineCollectedPaise = onlineAgg[0]?.amountPaise ?? 0;
  const codCollectedPaise = codAgg[0]?.amountPaise ?? 0;
  const taxPaise = taxAgg[0]?.taxPaise ?? 0;
  const fulfilmentChargePaise = fulfilmentAgg[0]?.fulfilmentPaise ?? 0;
  const manualRefundPaise =
    exceptionManualPaise + codCancelManualPaise + returnManualPaise;
  const refundOutflowPaise = providerRefundPaise + manualRefundPaise;
  const grossCollectedPaise = onlineCollectedPaise + codCollectedPaise;
  const netCollectedPaise = grossCollectedPaise - refundOutflowPaise;
  const onlineCollectedCount = onlineAgg[0]?.count ?? 0;
  const codCollectedCount = codAgg[0]?.count ?? 0;
  const collectedOrderCount = onlineCollectedCount + codCollectedCount;
  const averageCollectedOrderValuePaise =
    collectedOrderCount > 0 ? Math.round(grossCollectedPaise / collectedOrderCount) : 0;

  return {
    onlineCollectedPaise,
    codCollectedPaise,
    grossCollectedPaise,
    taxPaise,
    fulfilmentChargePaise,
    providerRefundOutflowPaise: providerRefundPaise,
    manualRefundOutflowPaise: manualRefundPaise,
    refundOutflowPaise,
    netCollectedPaise,
    collectedOrderCount,
    onlineCollectedCount,
    codCollectedCount,
    averageCollectedOrderValuePaise,
  };
}

export async function computeEcommerceCollectionsDaily(tenantId, from, to) {
  const range = { from, to };
  const [onlineRows, codRows, providerRefundRows, exceptionManualRows, codCancelRows, returnManualRows] =
    await Promise.all([
      EcommerceOrder.aggregate([
        {
          $match: {
            tenantId,
            paymentMethod: EcommercePaymentMethod.ONLINE,
            paidAt: { $ne: null },
            ...dateMatch("paidAt", range),
          },
        },
        { $group: { _id: dayGroup("paidAt"), amountPaise: { $sum: "$totalPaise" } } },
      ]),
      EcommerceOrder.aggregate([
        {
          $match: {
            tenantId,
            paymentMethod: EcommercePaymentMethod.COD,
            "codCollection.status": EcommerceCodCollectionStatus.COLLECTED,
            ...dateMatch("codCollection.collectedAt", range),
          },
        },
        {
          $group: {
            _id: dayGroup("codCollection.collectedAt"),
            amountPaise: {
              $sum: { $ifNull: ["$codCollection.amountPaise", "$totalPaise"] },
            },
          },
        },
      ]),
      EcommercePaymentExceptionRefund.aggregate([
        {
          $match: {
            tenantId,
            status: EcommercePaymentExceptionRefundStatus.SUCCEEDED,
            ...dateMatch("updatedAt", range),
          },
        },
        { $group: { _id: dayGroup("updatedAt"), amountPaise: { $sum: "$amountPaise" } } },
      ]),
      EcommercePaymentExceptionRefund.aggregate([
        {
          $match: {
            tenantId,
            status: EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED,
            ...dateMatch("updatedAt", range),
          },
        },
        { $group: { _id: dayGroup("updatedAt"), amountPaise: { $sum: "$amountPaise" } } },
      ]),
      EcommerceOrderCancellationRequest.aggregate([
        {
          $match: {
            tenantId,
            "codManualRefund.recordedAt": { $ne: null },
            ...dateMatch("codManualRefund.recordedAt", range),
          },
        },
        {
          $group: {
            _id: dayGroup("codManualRefund.recordedAt"),
            amountPaise: { $sum: "$codManualRefund.amountPaise" },
          },
        },
      ]),
      EcommerceOrderReturnRequest.aggregate([
        {
          $match: {
            tenantId,
            manualRefundRecordedAt: { $ne: null },
            ...dateMatch("manualRefundRecordedAt", range),
          },
        },
        {
          $group: {
            _id: dayGroup("manualRefundRecordedAt"),
            amountPaise: { $sum: "$manualRefundProof.amountPaise" },
          },
        },
      ]),
    ]);

  const refundByDay = new Map();
  for (const rows of [providerRefundRows, exceptionManualRows, codCancelRows, returnManualRows]) {
    for (const row of rows) {
      const day = String(row._id);
      refundByDay.set(day, (refundByDay.get(day) ?? 0) + Number(row.amountPaise ?? 0));
    }
  }

  return {
    onlineByDay: onlineRows.map((r) => ({ day: String(r._id), amountPaise: r.amountPaise })),
    codByDay: codRows.map((r) => ({ day: String(r._id), amountPaise: r.amountPaise })),
    refundByDay: [...refundByDay.entries()].map(([day, amountPaise]) => ({ day, amountPaise })),
  };
}

export async function aggregateOrdersPlacedDaily(tenantId, from, to) {
  return EcommerceOrder.aggregate([
    {
      $match: {
        tenantId,
        ...dateMatch("createdAt", { from, to }),
      },
    },
    { $group: { _id: dayGroup("createdAt"), count: { $sum: 1 } } },
  ]);
}

export async function aggregateProductLineTotals(tenantId, from, to) {
  const range = { from, to };
  const paidAtRange = dateMatch("paidAt", range);
  const codRange = dateMatch("codCollection.collectedAt", range);
  return EcommerceOrder.aggregate([
    {
      $match: {
        tenantId,
        $or: [
          {
            paymentMethod: EcommercePaymentMethod.ONLINE,
            paidAt: { $ne: null },
            ...paidAtRange,
          },
          {
            paymentMethod: EcommercePaymentMethod.COD,
            "codCollection.status": EcommerceCodCollectionStatus.COLLECTED,
            ...codRange,
          },
        ],
      },
    },
    { $unwind: "$lines" },
    {
      $group: {
        _id: {
          productId: { $ifNull: ["$lines.productId", "$lines.sku"] },
          name: "$lines.name",
          sku: "$lines.sku",
        },
        unitsOrdered: { $sum: { $ifNull: ["$lines.quantity", 1] } },
        lineTotalPaise: { $sum: { $ifNull: ["$lines.lineTotalPaise", 0] } },
      },
    },
    { $sort: { lineTotalPaise: -1 } },
  ]);
}

/** @deprecated use computeEcommerceCollections; kept for tests comparing legacy paths */
export { REFUND_OUTFLOW_STATUSES };
