import Decimal from "decimal.js";
import PDFDocument from "pdfkit";
import { Invoice, Tenant } from "../models/index.js";
import { errors } from "../lib/app-error.js";
import { MONEY_PAISE_ROUNDING } from "../lib/money.js";

const PLATFORM = Object.freeze({
  name: process.env.PLATFORM_BILLING_NAME ?? "Swarna Grow Technologies",
  gstin: process.env.PLATFORM_GSTIN ?? null,
  address:
    process.env.PLATFORM_BILLING_ADDRESS ??
    "Platform billing · India",
});

function safeFilename(reference) {
  const base = String(reference ?? "invoice").replace(/[^\w.-]+/g, "_");
  return base.endsWith(".pdf") ? base : `${base}.pdf`;
}

function formatInr(paise) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format((paise ?? 0) / 100);
}

function formatDate(value) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function tenantAddressLines(tenant) {
  const addr = tenant.address ?? {};
  const parts = [
    addr.line1,
    addr.line2,
    [addr.city, addr.state].filter(Boolean).join(", "),
    addr.pincode,
  ].filter((p) => p && String(p).trim());
  return parts.length ? parts : [tenant.supportNumber ? `Support: ${tenant.supportNumber}` : null].filter(Boolean);
}

export async function loadSubscriptionInvoiceForTenant(tenantId, invoiceId) {
  const invoice = await Invoice.findOne({ _id: invoiceId, tenantId }).lean();
  if (!invoice) throw errors.notFound("Invoice");
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) throw errors.notFound("Tenant");
  return { invoice, tenant };
}

/** Prefer persisted subtotal/tax; legacy inclusive totals split with Decimal HALF_UP. */
export function subscriptionInvoiceTaxBreakdown(invoice) {
  const totalPaise = invoice.amountPaise ?? 0;
  if (
    Number.isInteger(invoice.subtotalPaise)
    && Number.isInteger(invoice.taxPaise)
  ) {
    return {
      taxable: invoice.subtotalPaise,
      gst: invoice.taxPaise,
      total: totalPaise || invoice.subtotalPaise + invoice.taxPaise,
    };
  }
  const taxPercent = typeof invoice.taxPercent === "number" ? invoice.taxPercent : 18;
  if (taxPercent <= 0 || totalPaise <= 0) {
    return { taxable: totalPaise, gst: 0, total: totalPaise };
  }
  const gst = new Decimal(totalPaise)
    .mul(taxPercent)
    .div(100 + taxPercent)
    .toDecimalPlaces(0, MONEY_PAISE_ROUNDING)
    .toNumber();
  return { taxable: totalPaise - gst, gst, total: totalPaise };
}

export function displayInvoiceNumber(invoice) {
  const allocated = invoice.invoiceNumber?.trim();
  if (allocated) return allocated;
  if (invoice.reference?.trim()) return invoice.reference.trim();
  return String(invoice._id);
}

export function streamSubscriptionInvoicePdf(res, { invoice, tenant }) {
  const number = displayInvoiceNumber(invoice);
  const taxPercentLabel =
    typeof invoice.taxPercent === "number" ? invoice.taxPercent : 18;
  const period = invoice.dueDate ?? "—";
  const { taxable, gst, total: amountPaise } = subscriptionInvoiceTaxBreakdown(invoice);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeFilename(number)}"`,
  );

  const doc = new PDFDocument({ size: "A4", margin: 48 });
  doc.pipe(res);

  const pageWidth = doc.page.width - 96;
  let y = 48;

  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor("#730321")
    .text("TAX INVOICE", 48, y, { width: pageWidth, align: "right" });
  y = doc.y + 8;

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#000000").text(PLATFORM.name, 48, y);
  doc.font("Helvetica").fontSize(10);
  doc.text(PLATFORM.address);
  if (PLATFORM.gstin) doc.text(`GSTIN: ${PLATFORM.gstin}`);
  doc.moveDown(1.2);

  doc.font("Helvetica-Bold").fontSize(11).text("Bill to");
  doc.font("Helvetica").fontSize(10);
  doc.text(tenant.displayName ?? tenant.name ?? "Tenant");
  for (const line of tenantAddressLines(tenant)) doc.text(String(line));
  if (tenant.gstin) doc.text(`GSTIN: ${tenant.gstin}`);

  doc.moveDown(1.2);
  const metaY = doc.y;
  doc.font("Helvetica").fontSize(10);
  doc.text(`Invoice number: ${number}`, 48, metaY);
  doc.text(`Billing period: ${period}`);
  doc.text(`Invoice date: ${formatDate(invoice.createdAt ?? invoice.paidAt)}`);
  doc.text(`Status: ${invoice.status ?? "ISSUED"}`);
  if (invoice.paidAt) doc.text(`Paid on: ${formatDate(invoice.paidAt)}`);
  if (invoice.reference) doc.text(`Reference: ${invoice.reference}`);

  doc.moveDown(1.5);
  const tableTop = doc.y;
  doc.font("Helvetica-Bold").fontSize(10);
  doc.text("Description", 48, tableTop, { width: 280 });
  doc.text("Amount", 48 + pageWidth - 80, tableTop, { width: 80, align: "right" });
  doc
    .moveTo(48, tableTop + 16)
    .lineTo(48 + pageWidth, tableTop + 16)
    .strokeColor("#cccccc")
    .stroke();

  const rowY = tableTop + 24;
  doc.font("Helvetica").fontSize(10);
  doc.text(`Swarna Grow platform subscription — ${period}`, 48, rowY, { width: 280 });
  doc.text(formatInr(amountPaise), 48 + pageWidth - 80, rowY, {
    width: 80,
    align: "right",
  });

  doc.moveDown(2);
  const totalsY = doc.y + 8;
  doc.font("Helvetica").fontSize(10);
  if (PLATFORM.gstin && gst > 0) {
    doc.text(`Taxable value: ${formatInr(taxable)}`, 48, totalsY, {
      width: pageWidth,
      align: "right",
    });
    doc.text(`GST (${taxPercentLabel}%): ${formatInr(gst)}`, { width: pageWidth, align: "right" });
  }
  doc.font("Helvetica-Bold").fontSize(12);
  doc.text(`Total: ${formatInr(amountPaise)}`, { width: pageWidth, align: "right" });

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#666666")
    .text(
      "Computer-generated tax invoice for Swarna Grow platform subscription billing. For billing queries, contact your account manager.",
      48,
      doc.page.height - 64,
      { width: pageWidth, align: "center" },
    );

  doc.end();
}
