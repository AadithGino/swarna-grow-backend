import { Permission } from "../constants/permissions.js";
import { errors } from "../lib/app-error.js";
import { Customer, EcommerceOrder } from "../models/index.js";
import { listAdminPaymentExceptions } from "./ecommerce-payment-exception-refund.service.js";
import { listAdminDigitalMetalPaymentExceptions } from "./digital-metals-payment-exception.service.js";

const ECOMMERCE_NEXT = {
  EXCEPTION_REFUND: "Open order and complete or record refund",
  STUCK_RECONCILE: "Retry gateway reconcile on the order",
  INITIATION_UNCERTAIN: "Confirm whether payment started; reconcile or cancel",
  LATE_SUCCESS_REFUND_REQUIRED: "Refund late capture or resolve on order",
};

const DM_NEXT = {
  LATE_SUCCESS: "Open buy order and initiate refund",
  LATE_SUCCESS_REFUND_REQUIRED: "Open buy order and initiate refund",
  DUPLICATE_PAYMENT: "Refund duplicate capture",
  DUPLICATE_PAYMENT_REFUND_REQUIRED: "Refund duplicate capture",
  AMOUNT_MISMATCH: "Review gateway amount vs order total",
  CHARGEBACK: "Follow chargeback playbook on order",
};

function hasPermission(req, perm) {
  const permissions = req.auth?.permissions ?? [];
  if (!permissions.length || permissions.includes("*")) return true;
  return permissions.includes(perm);
}

function ecommerceHref(row) {
  const orderId = row.orderId;
  if (!orderId) return "/ecommerce/orders";
  return `/ecommerce/orders/${encodeURIComponent(orderId)}`;
}

function dmHref(orderId) {
  if (!orderId) return "/digital-metals/purchases";
  return `/digital-metals/purchases/${encodeURIComponent(orderId)}`;
}

async function enrichEcommerceItems(req, items) {
  const orderIds = [...new Set(items.map((i) => i.orderId).filter(Boolean))];
  const orders = orderIds.length
    ? await EcommerceOrder.find({ tenantId: req.auth.tenantId, _id: { $in: orderIds } })
        .select("_id orderNumber customerId totalPaise")
        .lean()
    : [];
  const orderMap = new Map(orders.map((o) => [o._id, o]));
  const customerIds = [...new Set(orders.map((o) => o.customerId).filter(Boolean))];
  const customers = customerIds.length
    ? await Customer.find({ tenantId: req.auth.tenantId, _id: { $in: customerIds } })
        .select("_id name mobile customerNumber")
        .lean()
    : [];
  const customerMap = new Map(customers.map((c) => [c._id, c]));

  return items.map((row) => {
    const order = orderMap.get(row.orderId);
    const customer = order?.customerId ? customerMap.get(order.customerId) : null;
    const kind = String(row.kind ?? "OTHER");
    return {
      id: `ecom:${kind}:${row.refundCaseId ?? row.paymentAttemptId ?? row.orderId}`,
      domain: "ECOMMERCE",
      kind,
      reasonLabel: kind.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()),
      nextActionLabel: ECOMMERCE_NEXT[kind] ?? "Review on order detail",
      amountPaise: Number(row.amountPaise ?? order?.totalPaise ?? 0),
      currency: row.currency ?? "INR",
      status: String(row.status ?? row.paymentExceptionStatus ?? row.operationalStatus ?? "OPEN"),
      customer: customer
        ? { id: customer._id, name: customer.name, mobile: customer.mobile, customerNumber: customer.customerNumber }
        : null,
      transactionLabel: order?.orderNumber ? `Order ${order.orderNumber}` : row.orderId ? `Order ${String(row.orderId).slice(-8)}` : "Store order",
      transactionHref: ecommerceHref(row),
      refundObligation: row.refundCaseId
        ? {
            domain: "ECOMMERCE",
            refundCaseId: row.refundCaseId,
            status: row.status ?? null,
            amountPaise: Number(row.amountPaise ?? 0),
          }
        : null,
      updatedAt: row.updatedAt ?? null,
    };
  });
}

async function enrichDigitalMetalItems(req, raw) {
  const items = raw.items ?? [];
  const customerIds = [...new Set(items.map((i) => i.order?.customerId).filter(Boolean))];
  const customers = customerIds.length
    ? await Customer.find({ tenantId: req.auth.tenantId, _id: { $in: customerIds } })
        .select("_id name mobile customerNumber")
        .lean()
    : [];
  const customerMap = new Map(customers.map((c) => [c._id, c]));

  return items.map((row) => {
    const order = row.order ?? {};
    const refund = row.refund ?? null;
    const customerId = order.customerId;
    const customerFromOrder = order.customer;
    const customer =
      customerFromOrder?.id || customerFromOrder?.name
        ? customerFromOrder
        : customerId
          ? customerMap.get(customerId)
          : null;
    const exceptionType =
      order.paymentExceptionStatus ?? refund?.exceptionType ?? "PAYMENT_EXCEPTION";
    const kind = String(exceptionType);
    return {
      id: `dm:${kind}:${refund?._id ?? order.id ?? order._id}`,
      domain: "DIGITAL_METALS",
      kind,
      reasonLabel: kind.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()),
      nextActionLabel: DM_NEXT[kind] ?? "Review buy order payment",
      amountPaise: Number(refund?.amountPaise ?? order.totalPayablePaise ?? 0),
      currency: "INR",
      status: String(refund?.status ?? order.status ?? "OPEN"),
      customer: customer
        ? {
            id: customer.id ?? customer._id ?? customerId,
            name: customer.name,
            mobile: customer.mobile,
            customerNumber: customer.customerNumber,
          }
        : null,
      transactionLabel: order.id ? `Buy ${String(order.id).slice(-10)}` : "Digital metals buy",
      transactionHref: dmHref(order.id ?? order._id),
      refundObligation: refund
        ? {
            domain: "DIGITAL_METALS",
            refundCaseId: refund._id,
            status: refund.status,
            amountPaise: Number(refund.amountPaise ?? 0),
          }
        : null,
      updatedAt: order.updatedAt ?? refund?.updatedAt ?? null,
    };
  });
}

export async function countPaymentsNeedingAttention(req) {
  const result = await listPaymentsNeedingAttention(req);
  return result.items.length;
}

export async function listPaymentsNeedingAttention(req) {
  const canEcom = hasPermission(req, Permission.ECOMMERCE_READ);
  const canDm = hasPermission(req, Permission.DIGITAL_METALS_READ);
  if (!canEcom && !canDm) throw errors.forbidden("Ecommerce or digital metals read access required.");

  const limit = Math.min(Number(req.query.limit) || 80, 100);
  const merged = [];

  if (canEcom) {
    const ecom = await listAdminPaymentExceptions({ ...req, query: { ...req.query, limit } });
    merged.push(...(await enrichEcommerceItems(req, ecom.items ?? [])));
  }
  if (canDm) {
    const dm = await listAdminDigitalMetalPaymentExceptions({ ...req, query: { ...req.query, limit } });
    merged.push(...(await enrichDigitalMetalItems(req, dm)));
  }

  merged.sort((a, b) => {
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });

  return {
    computedAt: new Date().toISOString(),
    items: merged.slice(0, limit),
    domainsIncluded: { ecommerce: canEcom, digitalMetals: canDm },
  };
}
