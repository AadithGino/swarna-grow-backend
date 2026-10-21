import PDFDocument from "pdfkit";

function formatInr(paise) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format((paise ?? 0) / 100);
}

export function streamDigitalMetalBuyInvoicePdf(res, { order, tenant, customer }) {
  const doc = new PDFDocument({ margin: 48 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="digital-metal-${order._id}.pdf"`,
  );
  doc.pipe(res);
  doc.fontSize(18).text(tenant.name ?? "Jeweller", { align: "left" });
  doc.fontSize(12).text("Digital metal purchase invoice", { underline: true });
  doc.moveDown();
  doc.text(`Order: ${order._id}`);
  doc.text(`Customer: ${customer.name ?? customer._id}`);
  doc.text(`Date: ${new Date(order.creditedAt ?? order.createdAt).toLocaleDateString("en-IN")}`);
  doc.moveDown();
  doc.text(`Metal: ${order.metal} (${order.finenessPpm / 1000}‰)`);
  doc.text(`Quantity: ${(Number(order.quantityUg) / 1_000_000).toFixed(4)} g`);
  doc.text(`Total paid: ${formatInr(order.totalPayablePaise)}`);
  const snap = order.snapshot ?? {};
  if (Array.isArray(snap.taxLines) && snap.taxLines.length) {
    doc.moveDown().text("Tax (snapshot):");
    for (const line of snap.taxLines) {
      doc.text(`  ${line.code ?? "TAX"}: ${formatInr(line.amountPaise ?? 0)}`);
    }
  }
  doc.moveDown().fontSize(10).text("This invoice reflects the immutable purchase snapshot at acceptance.");
  doc.end();
}

export async function renderDigitalMetalBuyInvoicePdfBuffer({ order, tenant, customer }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(18).text(tenant.name ?? "Jeweller");
    doc.fontSize(12).text("Digital metal purchase invoice");
    doc.moveDown();
    doc.text(`Order: ${order._id}`);
    doc.text(`Customer: ${customer.name ?? customer._id}`);
    doc.text(`Metal: ${order.metal}`);
    doc.text(`Quantity: ${(Number(order.quantityUg) / 1_000_000).toFixed(4)} g`);
    doc.text(`Total: ${formatInr(order.totalPayablePaise)}`);
    doc.end();
  });
}
