import {
  EcommerceCodCollectionStatus,
  EcommercePaymentExceptionRefundStatus,
} from "../constants/enums.js";
import { Customer, EcommerceOrder, EcommercePaymentExceptionRefund } from "../models/index.js";
import { errors } from "../lib/app-error.js";
import { paginate } from "../lib/pagination.js";
import {
  mapAdminCustomerOrderListRow,
} from "../lib/ecommerce-admin-customer-order-row.js";
import { customerHasEcommerceOrderHistory } from "../lib/ecommerce-tenant-history.js";

async function aggregateCustomerEcommerceSummary(tenantId, customerId) {
  const match = { tenantId, customerId };
  const [orderCount, collectedAgg, refundAgg] = await Promise.all([
    EcommerceOrder.countDocuments(match),
    EcommerceOrder.aggregate([
      { $match: match },
      {
        $project: {
          totalPaise: 1,
          collected: {
            $cond: [
              {
                $or: [
                  { $ifNull: ["$paidAt", false] },
                  {
                    $eq: [
                      "$codCollection.status",
                      EcommerceCodCollectionStatus.COLLECTED,
                    ],
                  },
                ],
              },
              { $ifNull: ["$totalPaise", 0] },
              0,
            ],
          },
        },
      },
      { $group: { _id: null, grossCollectedPaise: { $sum: "$collected" } } },
    ]),
    EcommercePaymentExceptionRefund.aggregate([
      {
        $lookup: {
          from: EcommerceOrder.collection.name,
          localField: "orderId",
          foreignField: "_id",
          as: "order",
        },
      },
      { $unwind: "$order" },
      {
        $match: {
          tenantId,
          "order.customerId": customerId,
          status: {
            $in: [
              EcommercePaymentExceptionRefundStatus.SUCCEEDED,
              EcommercePaymentExceptionRefundStatus.MANUAL_RECORDED,
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          refundOutflowPaise: {
            $sum: { $ifNull: ["$amountPaise", "$order.totalPaise"] },
          },
        },
      },
    ]),
  ]);
  const grossCollectedPaise = collectedAgg[0]?.grossCollectedPaise ?? 0;
  const refundOutflowPaise = refundAgg[0]?.refundOutflowPaise ?? 0;
  return {
    orderCount,
    grossCollectedPaise,
    refundOutflowPaise,
    netCollectedPaise: grossCollectedPaise - refundOutflowPaise,
    label: "Ecommerce order totals (not scheme savings or gold holdings)",
  };
}

async function assertCustomerInScope(req) {
  const customer = await Customer.findOne({
    _id: req.params.customerId,
    tenantId: req.auth.tenantId,
    ...req.scope,
  })
    .select("_id")
    .lean();
  if (!customer) throw errors.notFound("Customer");
  return customer._id;
}

async function refundMapForOrders(tenantId, orderIds) {
  if (!orderIds.length) return new Map();
  const refunds = await EcommercePaymentExceptionRefund.find({
    tenantId,
    orderId: { $in: orderIds },
  }).lean();
  return new Map(refunds.map((r) => [r.orderId, r]));
}

export async function getAdminCustomerEcommerceOrdersMeta(req) {
  const customerId = await assertCustomerInScope(req);
  const hasHistory = await customerHasEcommerceOrderHistory(req.auth.tenantId, customerId);
  return { customerId, hasOrderHistory: hasHistory };
}

export async function listAdminCustomerEcommerceOrders(req) {
  const customerId = await assertCustomerInScope(req);
  const scope = {
    tenantId: req.auth.tenantId,
    customerId,
  };
  const sort = "createdAt:desc";
  const page = await paginate(EcommerceOrder, {
    scope,
    filters: {},
    cursor: req.query?.cursor,
    limit: req.query?.limit,
    sort,
  });
  const refundMap = await refundMapForOrders(
    req.auth.tenantId,
    page.data.map((r) => r._id),
  );
  const items = page.data.map((row) =>
    mapAdminCustomerOrderListRow(row, refundMap.get(row._id)),
  );

  const ecommerceSummary = await aggregateCustomerEcommerceSummary(req.auth.tenantId, customerId);

  return {
    items,
    meta: {
      ...page.meta,
      sort,
      ecommerceSummary,
      hasOrderHistory: ecommerceSummary.orderCount > 0,
    },
  };
}
