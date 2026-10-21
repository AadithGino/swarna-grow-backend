import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { storageProvider } from "../integrations/storage.provider.js";
import {
  renderDigitalMetalBuyInvoicePdfBuffer,
  streamDigitalMetalBuyInvoicePdf,
} from "../lib/digital-metals-buy-invoice-pdf.js";
import { Customer, DigitalMetalBuyOrder, Tenant, Upload } from "../models/index.js";
import { UploadPurpose, UploadStatus } from "../constants/enums.js";

export function isDigitalMetalBuyInvoiceReady(order) {
  return order.status === "CREDITED" && order.invoiceStatus === "READY" && order.invoiceUploadId;
}

export async function loadDigitalMetalBuyInvoiceContext({ tenantId, orderId, customerId }) {
  const filter = { _id: orderId, tenantId };
  if (customerId) filter.customerId = customerId;
  const order = await DigitalMetalBuyOrder.findOne(filter).lean();
  if (!order) throw errors.notFound("Order");
  if (order.status !== "CREDITED") {
    throw errors.business(
      "INVOICE_NOT_AVAILABLE",
      "Invoice is available after metal is credited.",
      { status: order.status, invoiceStatus: order.invoiceStatus },
    );
  }
  const [tenant, customer] = await Promise.all([
    Tenant.findById(tenantId).lean(),
    Customer.findOne({ _id: order.customerId, tenantId }).lean(),
  ]);
  if (!tenant) throw errors.notFound("Tenant");
  if (!customer) throw errors.notFound("Customer");
  return { order, tenant, customer };
}

export async function streamCustomerDigitalMetalBuyInvoice(req, res) {
  const ctx = await loadDigitalMetalBuyInvoiceContext({
    tenantId: req.auth.tenantId,
    orderId: req.params.orderId,
    customerId: req.auth.id,
  });
  if (ctx.order.invoiceUploadId && ctx.order.invoiceStatus === "READY") {
    const upload = await Upload.findOne({
      _id: ctx.order.invoiceUploadId,
      tenantId: req.auth.tenantId,
    }).lean();
    if (upload?.objectKey) {
      const body = await storageProvider.readObjectBody(upload.objectKey);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="digital-metal-${ctx.order._id}.pdf"`,
      );
      res.send(body);
      return;
    }
  }
  streamDigitalMetalBuyInvoicePdf(res, ctx);
}

export async function streamAdminDigitalMetalBuyInvoice(req, res) {
  const ctx = await loadDigitalMetalBuyInvoiceContext({
    tenantId: req.auth.tenantId,
    orderId: req.params.orderId,
  });
  if (ctx.order.invoiceUploadId && ctx.order.invoiceStatus === "READY") {
    const upload = await Upload.findOne({
      _id: ctx.order.invoiceUploadId,
      tenantId: req.auth.tenantId,
    }).lean();
    if (upload?.objectKey) {
      const body = await storageProvider.readObjectBody(upload.objectKey);
      res.setHeader("Content-Type", "application/pdf");
      res.send(body);
      return;
    }
  }
  streamDigitalMetalBuyInvoicePdf(res, ctx);
}

/** Idempotent invoice artifact generation from immutable order snapshot. */
export async function processDigitalMetalPurchaseInvoiceRequest({ tenantId, orderId }) {
  const order = await DigitalMetalBuyOrder.findOne({ _id: orderId, tenantId }).lean();
  if (!order) return { outcome: "ORDER_NOT_FOUND" };
  if (order.status !== "CREDITED") return { outcome: "NOT_CREDITED" };
  if (order.invoiceStatus === "READY" && order.invoiceUploadId) {
    return { outcome: "ALREADY_READY", uploadId: order.invoiceUploadId };
  }

  const [tenant, customer] = await Promise.all([
    Tenant.findById(tenantId).lean(),
    Customer.findOne({ _id: order.customerId, tenantId }).lean(),
  ]);
  if (!tenant || !customer) return { outcome: "CONTEXT_MISSING" };

  try {
    const pdf = await renderDigitalMetalBuyInvoicePdfBuffer({ order, tenant, customer });
    const uploadId = createId("upload");
    const objectKey = `${tenantId}/digital_metal_invoice/${uploadId}/invoice.pdf`;
    await storageProvider.uploadFile({
      objectKey,
      body: pdf,
      contentType: "application/pdf",
    });
    await Upload.create({
      _id: uploadId,
      tenantId,
      ownerId: order.customerId,
      purpose: UploadPurpose.DIGITAL_METAL_PURCHASE_INVOICE,
      fileName: `digital-metal-${orderId}.pdf`,
      contentType: "application/pdf",
      sizeBytes: pdf.length,
      objectKey,
      status: UploadStatus.UPLOADED,
      expiresAt: null,
    });
    const updated = await DigitalMetalBuyOrder.findOneAndUpdate(
      {
        _id: orderId,
        tenantId,
        invoiceStatus: { $in: ["PENDING", "FAILED"] },
      },
      {
        $set: {
          invoiceStatus: "READY",
          invoiceUploadId: uploadId,
          invoiceReadyAt: new Date(),
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated && order.invoiceUploadId) {
      return { outcome: "ALREADY_READY", uploadId: order.invoiceUploadId };
    }
    return { outcome: "READY", uploadId };
  } catch (err) {
    await DigitalMetalBuyOrder.updateOne(
      { _id: orderId, tenantId, status: "CREDITED" },
      { $set: { invoiceStatus: "FAILED" }, $inc: { version: 1 } },
    );
    return { outcome: "FAILED", message: err?.message };
  }
}
