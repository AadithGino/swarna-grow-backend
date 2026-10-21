import PDFDocument from "pdfkit";
import { formatInrFromPaise, ugToGramsDisplay, sellAcknowledgementPdfRows } from "./digital-metals-document-pdf-fields.js";

async function renderSimpleDoc(title, rows, documentNumber) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(14).text(title, { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    if (documentNumber) doc.text(`Document no.: ${documentNumber}`);
    for (const [k, v] of rows) {
      doc.text(`${k}: ${v}`, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      });
    }
    doc.fontSize(8).fillColor("#666666").text(
      "Confidential customer record. Do not share bank account numbers or pickup codes via this document.",
      doc.page.margins.left,
      doc.page.height - doc.page.margins.bottom + 8,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: "center" },
    );
    doc.end();
  });
}

export function renderRedemptionChargeReceiptPdf(ctx) {
  const o = ctx.order;
  return renderSimpleDoc(
    "Redemption charge receipt",
    [
      ["Order", o._id],
      ["Charge total", formatInrFromPaise(o.chargeTotalPaise)],
      ["Metal quantity", ugToGramsDisplay(o.quantityUg)],
      ["Note", "Minting/delivery charge only; metal was purchased separately."],
    ],
    ctx.documentNumber,
  );
}

export function renderPhysicalHandoverReceiptPdf(ctx) {
  return renderSimpleDoc(
    "Physical handover receipt",
    [
      ["Event", ctx.event._id],
      ["Redemption order", ctx.event.redemptionOrderId],
      ["Quantity (ug)", String(ctx.event.quantityUg)],
      ["Business date (IST)", ctx.event.businessDate],
      ["Mode", ctx.event.fulfilmentMode],
    ],
    ctx.documentNumber,
  );
}

export function renderSellAcknowledgementPdf(ctx) {
  const o = ctx.order;
  return renderSimpleDoc(
    "Digital metal sale acknowledgement",
    sellAcknowledgementPdfRows(o),
    ctx.documentNumber,
  );
}

export function renderPayoutReceiptPdf(ctx) {
  const p = ctx.payout;
  return renderSimpleDoc(
    "Payout settlement record (staff attested)",
    [
      ["Payout", p._id],
      ["Amount", formatInrFromPaise(p.amountPaise)],
      ["Status", p.status],
      ["Reference", p.settlementReference ?? "Manual evidence on file"],
      ["Note", "Bank details are not reproduced on this document."],
    ],
    ctx.documentNumber,
  );
}
