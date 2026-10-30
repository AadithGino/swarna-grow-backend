import {
  EcommerceCourierCodCollectionStatus,
  EcommerceCourierCodRemittanceStatus,
  EcommercePaymentExceptionRefundStatus,
  EcommercePaymentMethod,
} from "../constants/enums.js";
import { Customer, EcommerceOrder, EcommercePaymentExceptionRefund } from "../models/index.js";
import { errors } from "../lib/app-error.js";
import { paginate } from "../lib/pagination.js";
import { mapAdminCustomerOrderListRow } from "../lib/ecommerce-admin-customer-order-row.js";
import { customerHasEcommerceOrderHistory } from "../lib/ecommerce-tenant-history.js";

async function aggregateCustomerEcommerceSummary(tenantId, customerId) {
  const match = { tenantId, customerId };
  const [orderCount, onlineAgg, codConfirmedAgg, codBankAgg, refundAgg] = await Promise.all([
    EcommerceOrder.countDocuments(match),
    EcommerceOrder.aggregate([
      {
        $match: {
          ...match,
          paymentMethod: EcommercePaymentMethod.ONLINE,
          paidAt: { $ne: null },
        },
      },
      { $group: { _id: null, amountPaise: { $sum: "$totalPaise" } } },
    ]),
    EcommerceOrder.aggregate([
      {
        $match: {
          ...match,
          paymentMethod: EcommercePaymentMethod.COD,
          "courierCod.collectionStatus": EcommerceCourierCodCollectionStatus.CONFIRMED,
        },
      },
      {
        $group: {
          _id: null,
          amountPaise: {
            $sum: { $ifNull: ["$courierCod.expectedAmountPaise", "$totalPaise"] },
          },
        },
      },
    ]),
    EcommerceOrder.aggregate([
      {
        $match: {
          ...match,
          paymentMethod: EcommercePaymentMethod.COD,
          "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.BANK_RECONCILED,
        },
      },
      {
        $group: {
          _id: null,
          amountPaise: { $sum: { $ifNull: ["$courierCod.remittanceNetPaise", "$totalPaise"] } },
        },
      },
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
  const onlineCollectedPaise = onlineAgg[0]?.amountPaise ?? 0;
  const codCourierConfirmedPaise = codConfirmedAgg[0]?.amountPaise ?? 0;
  const codBankRemittanceReconciledPaise = codBankAgg[0]?.amountPaise ?? 0;
  const refundOutflowPaise = refundAgg[0]?.refundOutflowPaise ?? 0;
  const grossCollectedPaise = onlineCollectedPaise + codBankRemittanceReconciledPaise;
  return {
    orderCount,
    onlineCollectedPaise,
    codCourierConfirmedPaise,
    codBankRemittanceReconciledPaise,
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

const OPEN_ORDER_STATUSES = [
  "COD_PENDING_ACCEPTANCE",
  "PAID",
  "PROCESSING",
  "READY_FOR_PICKUP",
  "SHIPPED",
];

/** Store totals for the customer detail overview cards (counter orders included). */
export async function getAdminCustomerEcommerceSummary(req) {
  const customerId = await assertCustomerInScope(req);
  const tenantId = req.auth.tenantId;
  const [totals, openOrders, counterAgg, lastOrder, itemsAgg] = await Promise.all([
    aggregateCustomerEcommerceSummary(tenantId, customerId),
    EcommerceOrder.countDocuments({ tenantId, customerId, status: { $in: OPEN_ORDER_STATUSES } }),
    EcommerceOrder.aggregate([
      { $match: { tenantId, customerId, "assisted.byUserId": { $type: "string" }, paidAt: { $ne: null } } },
      { $group: { _id: null, count: { $sum: 1 }, amountPaise: { $sum: "$totalPaise" } } },
    ]),
    EcommerceOrder.findOne({ tenantId, customerId })
      .sort({ createdAt: -1 })
      .select("_id orderNumber status totalPaise createdAt")
      .lean(),
    EcommerceOrder.aggregate([
      { $match: { tenantId, customerId, paidAt: { $ne: null } } },
      { $unwind: "$lines" },
      { $group: { _id: null, units: { $sum: "$lines.quantity" } } },
    ]),
  ]);
  return {
    customerId,
    ...totals,
    openOrders,
    itemsBought: itemsAgg[0]?.units ?? 0,
    counterOrders: { count: counterAgg[0]?.count ?? 0, amountPaise: counterAgg[0]?.amountPaise ?? 0 },
    lastOrder: lastOrder
      ? {
          id: lastOrder._id,
          orderNumber: lastOrder.orderNumber,
          status: lastOrder.status,
          totalPaise: lastOrder.totalPaise ?? 0,
          createdAt: lastOrder.createdAt ?? null,
        }
      : null,
  };
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
