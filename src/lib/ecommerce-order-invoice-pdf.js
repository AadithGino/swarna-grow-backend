import PDFDocument from "pdfkit";
import { computeComponentTaxPaise } from "./ecommerce-checkout-tax.js";
import { orderUsesCod } from "./ecommerce-cod.js";

function safeFilename(orderNumber) {
  const base = String(orderNumber ?? "order-invoice").replace(/[^\w.-]+/g, "_");
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

function addressLines(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const a = snapshot;
  return [
    a.recipientName,
    a.line1,
    a.line2,
    [a.city, a.state, a.pincode].filter(Boolean).join(", "),
    a.mobile ? `Phone: ${a.mobile}` : null,
  ].filter((line) => line && String(line).trim());
}

function paymentStatusLabel(order) {
  if (orderUsesCod(order)) {
    if (order.courierCod?.collectionStatus === "CONFIRMED") {
      if (order.courierCod?.remittanceStatus === "BANK_RECONCILED") {
        return "COD — bank remittance reconciled";
      }
      return "COD collected by courier — bank remittance pending";
    }
    return "Cash on delivery — payment pending";
  }
  if (order.paidAt) return "Paid online";
  return String(order.status ?? "Confirmed");
}

export function streamEcommerceOrderInvoicePdf(res, ctx) {
  const { order, tenant, customer, seller } = ctx;
  const snap = order.financialSnapshot ?? {};
  const orderNumber = order.orderNumber ?? order._id;
  const invoiceDate = order.paidAt ?? order.createdAt;
  const sellerName =
    String(seller?.sellerLegalName ?? "").trim()
    || tenant?.branding?.displayName
    || tenant?.displayName
    || tenant?.name
    || "Seller";
  const sellerGstin = String(seller?.sellerGstin ?? tenant?.gstin ?? "").trim();
  const placeOfSupply =
    snap.placeOfSupplyState ?? snap.destinationState ?? seller?.defaultPlaceOfSupplyState ?? "—";

  const taxBreakdown = computeComponentTaxPaise(
    order.subtotalPaise ?? 0,
    snap.taxComponentLines ?? [],
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeFilename(orderNumber)}"`,
  );

  const doc = new PDFDocument({ size: "A4", margin: 48 });
  doc.pipe(res);

  const pageWidth = doc.page.width - 96;
  let y = 48;

  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor("#333333")
    .text("TAX INVOICE", 48, y, { width: pageWidth, align: "right" });
  y = doc.y + 10;

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#000000").text(sellerName, 48, y);
  doc.font("Helvetica").fontSize(10);
  if (sellerGstin) doc.text(`GSTIN: ${sellerGstin}`);
  if (seller?.registeredState) doc.text(`Registered state: ${seller.registeredState}`);
  if (tenant?.mobile) doc.text(`Contact: ${tenant.mobile}`);
  doc.moveDown(1);

  doc.font("Helvetica-Bold").fontSize(11).text("Bill to");
  doc.font("Helvetica").fontSize(10);
  doc.text(customer?.name ?? "Customer");
  if (customer?.customerNumber) doc.text(`Customer no. ${customer.customerNumber}`);
  if (customer?.mobile) doc.text(customer.mobile);
  for (const line of addressLines(order.addressSnapshot)) doc.text(String(line));
  doc.moveDown(1);

  doc.font("Helvetica").fontSize(10);
  doc.text(`Invoice / order no.: ${orderNumber}`);
  doc.text(`Invoice date: ${formatDate(invoiceDate)}`);
  doc.text(`Place of supply: ${placeOfSupply}`);
  if (snap.supplyCase) doc.text(`Supply: ${snap.supplyCase}`);
  doc.text(`Payment: ${paymentStatusLabel(order)}`);
  if (order.fulfilmentMode) doc.text(`Fulfilment: ${order.fulfilmentMode}`);
  doc.moveDown(1.2);

  const tableTop = doc.y;
  doc.font("Helvetica-Bold").fontSize(9);
  doc.text("Item", 48, tableTop, { width: 220 });
  doc.text("Qty", 272, tableTop, { width: 36, align: "right" });
  doc.text("Unit", 312, tableTop, { width: 72, align: "right" });
  doc.text("Amount", 48 + pageWidth - 72, tableTop, { width: 72, align: "right" });
  doc
    .moveTo(48, tableTop + 14)
    .lineTo(48 + pageWidth, tableTop + 14)
    .strokeColor("#cccccc")
    .stroke();

  let rowY = tableTop + 22;
  doc.font("Helvetica").fontSize(9);
  for (const line of order.lines ?? []) {
    const name = String(line.name ?? "Item");
    const sku = line.sku ? ` (${line.sku})` : "";
    doc.text(`${name}${sku}`, 48, rowY, { width: 220 });
    doc.text(String(line.quantity ?? 1), 272, rowY, { width: 36, align: "right" });
    doc.text(formatInr(line.unitPricePaise ?? 0), 312, rowY, { width: 72, align: "right" });
    doc.text(formatInr(line.lineTotalPaise ?? 0), 48 + pageWidth - 72, rowY, {
      width: 72,
      align: "right",
    });
    rowY = doc.y + 6;
    if (rowY > doc.page.height - 160) {
      doc.addPage();
      rowY = 48;
    }
  }

  doc.moveDown(1);
  const totalsY = Math.max(doc.y + 8, rowY + 8);
  doc.font("Helvetica").fontSize(10);
  doc.text(`Taxable value: ${formatInr(order.subtotalPaise ?? 0)}`, 48, totalsY, {
    width: pageWidth,
    align: "right",
  });
  for (const taxLine of taxBreakdown.lines) {
    const rate = (taxLine.rateBps / 100).toFixed(2);
    doc.text(
      `${taxLine.label} (${rate}%): ${formatInr(taxLine.taxPaise)}`,
      { width: pageWidth, align: "right" },
    );
  }
  if (!taxBreakdown.lines.length && (order.taxPaise ?? 0) > 0) {
    doc.text(`Tax: ${formatInr(order.taxPaise)}`, { width: pageWidth, align: "right" });
  }
  if ((order.fulfilmentChargePaise ?? 0) > 0) {
    doc.text(`Fulfilment / delivery: ${formatInr(order.fulfilmentChargePaise)}`, {
      width: pageWidth,
      align: "right",
    });
  }
  doc.font("Helvetica-Bold").fontSize(12);
  doc.text(`Grand total: ${formatInr(order.totalPaise ?? 0)}`, {
    width: pageWidth,
    align: "right",
  });

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#666666")
    .text(
      "Computer-generated tax invoice for an ecommerce order. Tax component lines reflect accountant-approved checkout configuration at the time of order.",
      48,
      doc.page.height - 64,
      { width: pageWidth, align: "center" },
    );

  doc.end();
}
