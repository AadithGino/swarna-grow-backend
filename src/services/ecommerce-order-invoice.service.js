import { errors } from "../lib/app-error.js";
import { isEcommerceOrderInvoiceAvailable } from "../lib/ecommerce-order-invoice-eligibility.js";
import { streamEcommerceOrderInvoicePdf } from "../lib/ecommerce-order-invoice-pdf.js";
import {
  Customer,
  EcommerceFulfilmentSettings,
  EcommerceOrder,
  Tenant,
} from "../models/index.js";

export async function loadEcommerceOrderInvoiceContext({
  tenantId,
  orderId,
  customerId,
}) {
  const filter = { _id: orderId, tenantId };
  if (customerId) filter.customerId = customerId;
  const order = await EcommerceOrder.findOne(filter).lean();
  if (!order) throw errors.notFound("Order");
  if (!isEcommerceOrderInvoiceAvailable(order)) {
    throw errors.business(
      "ORDER_INVOICE_NOT_AVAILABLE",
      "Invoice is available after the order is confirmed (payment received or COD accepted).",
      { status: order.status },
    );
  }
  const [tenant, customer, fulfilment] = await Promise.all([
    Tenant.findById(tenantId).lean(),
    Customer.findById(order.customerId).lean(),
    EcommerceFulfilmentSettings.findOne({ tenantId }).lean(),
  ]);
  if (!tenant) throw errors.notFound("Tenant");
  if (!customer) throw errors.notFound("Customer");
  return {
    order,
    tenant,
    customer,
    seller: fulfilment?.checkoutTaxConfig ?? {},
  };
}

export async function streamCustomerOrderInvoice(req, res) {
  const ctx = await loadEcommerceOrderInvoiceContext({
    tenantId: req.auth.tenantId,
    orderId: req.params.orderId,
    customerId: req.auth.id,
  });
  streamEcommerceOrderInvoicePdf(res, ctx);
}

export async function streamAdminOrderInvoice(req, res) {
  const ctx = await loadEcommerceOrderInvoiceContext({
    tenantId: req.auth.tenantId,
    orderId: req.params.orderId,
  });
  streamEcommerceOrderInvoicePdf(res, ctx);
}
