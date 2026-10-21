import PDFDocument from "pdfkit";

function drawStatementFooter(doc, { documentNumber, pageIndex }) {
  const y = doc.page.height - doc.page.margins.bottom + 12;
  doc.fontSize(8).fillColor("#666666");
  doc.text(
    `Digital metal statement${documentNumber ? ` · ${documentNumber}` : ""} · Page ${pageIndex}`,
    doc.page.margins.left,
    y,
    { align: "center", width: doc.page.width - doc.page.margins.left - doc.page.margins.right },
  );
  doc.fillColor("#000000");
}

function ensureSpace(doc, state, needed = 48) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed <= bottom) return;
  drawStatementFooter(doc, state);
  doc.addPage();
  state.pageIndex += 1;
  doc.y = doc.page.margins.top;
}

export async function renderDigitalMetalStatementPdfBuffer({
  tenant,
  customer,
  documentNumber,
  fromBusinessDate,
  toBusinessDate,
  lines,
  openingByAsset,
  closingByAsset,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "A4" });
    const chunks = [];
    const state = { pageIndex: 1, documentNumber: documentNumber ?? "" };
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(14).text("Digital metal statement", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    if (documentNumber) doc.text(`Document no.: ${documentNumber}`);
    doc.text(`Seller: ${tenant.name ?? tenant._id}`);
    doc.text(`Customer: ${customer.name ?? customer._id}`);
    doc.text(`Period (IST): ${fromBusinessDate} to ${toBusinessDate}`);
    doc.moveDown();

    doc.text("Opening balances (micrograms held / reserved at period start):");
    for (const row of openingByAsset) {
      ensureSpace(doc, state, 14);
      doc.text(
        `  ${row.metal} ${row.finenessPpm}: held ${row.heldUg} ug, reserved ${row.reservedUg} ug`,
      );
    }
    doc.moveDown();
    doc.text("Activity:");
    for (const row of lines) {
      ensureSpace(doc, state, 14);
      const when = row.createdAt ? new Date(row.createdAt).toISOString() : "";
      doc.text(
        `  ${when} | ${row.entryType} | qty ${row.quantityUgDelta} ug | reserved ${row.reservedUgDelta} ug`,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right },
      );
    }
    doc.moveDown();
    ensureSpace(doc, state, 40);
    doc.text("Closing balances (micrograms at period end):");
    for (const row of closingByAsset) {
      ensureSpace(doc, state, 14);
      doc.text(
        `  ${row.metal} ${row.finenessPpm}: held ${row.heldUg} ug, reserved ${row.reservedUg} ug`,
      );
    }
    doc.moveDown();
    ensureSpace(doc, state, 36);
    doc.fontSize(9).text(
      "Indicative only. Sale value is not a guaranteed redemption price. Reservations reduce available quantity. "
        + "Balances reflect journal evidence through the stated IST period end only.",
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right },
    );
    drawStatementFooter(doc, state);
    doc.end();
  });
}
