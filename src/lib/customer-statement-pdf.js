import PDFDocument from "pdfkit";
import {
  isPositiveNetContributionPayment,
  netAmountPaiseFromDoc,
  paymentNetFieldsFromDoc,
} from "./payment-net-aggregation.js";

function formatInr(paise) {
  return (paise / 100).toFixed(2);
}

function formatDate(payment) {
  const value = payment.paidAt ?? payment.createdAt;
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

export function streamCustomerStatementPdf(res, { tenantName, customer, payments }) {
  const doc = new PDFDocument({ margin: 48 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${customer.customerNumber}-statement.pdf"`,
  );
  doc.pipe(res);
  doc.fontSize(20).text(tenantName).fontSize(14).text("Customer statement").moveDown();
  doc.text(`${customer.name} · ${customer.customerNumber}`).moveDown();
  doc.fontSize(9).text(
    "Date        Receipt           Gross     Refunded    Net retained   Mode        Status",
  );
  doc.moveDown(0.5);
  let netTotal = 0;
  for (const payment of payments) {
    if (!isPositiveNetContributionPayment(payment)) continue;
    const net = paymentNetFieldsFromDoc(payment);
    netTotal += net.netAmountPaise;
    doc.fontSize(9).text(
      `${formatDate(payment).padEnd(12)} ${String(payment.receiptNumber ?? "—").slice(0, 16).padEnd(17)} `
      + `${formatInr(net.grossAmountPaise).padStart(8)} ${formatInr(net.refundedAmountPaise).padStart(10)} `
      + `${formatInr(net.netAmountPaise).padStart(13)} ${String(payment.mode ?? "—").padEnd(11)} ${payment.status ?? ""}`,
    );
  }
  doc.moveDown();
  doc.fontSize(10).text(`Net retained total: ₹${formatInr(netTotal)}`);
  doc.end();
}

export function statementNetTotalPaise(payments) {
  return payments
    .filter(isPositiveNetContributionPayment)
    .reduce((sum, row) => sum + netAmountPaiseFromDoc(row), 0);
}
