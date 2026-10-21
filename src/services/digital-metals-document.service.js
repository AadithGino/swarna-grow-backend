import { serveLegacyPdfRoute } from "./digital-metals-document-artifact.service.js";

export async function streamRedemptionChargeReceipt(req, res) {
  return serveLegacyPdfRoute(req, res, {
    docType: "REDEMPTION_CHARGE_RECEIPT",
    subjectKey: req.params.orderId,
    customerId: req.auth.id,
  });
}

export async function streamAdminRedemptionChargeReceipt(req, res) {
  return serveLegacyPdfRoute(req, res, {
    docType: "REDEMPTION_CHARGE_RECEIPT",
    subjectKey: req.params.orderId,
  });
}

export async function streamAdminPhysicalHandoverReceipt(req, res) {
  return serveLegacyPdfRoute(req, res, {
    docType: "HANDOVER_RECEIPT",
    subjectKey: req.params.orderId,
  });
}

export async function streamPhysicalHandoverReceipt(req, res) {
  return serveLegacyPdfRoute(req, res, {
    docType: "HANDOVER_RECEIPT",
    subjectKey: req.params.orderId,
    customerId: req.auth.id,
  });
}

export async function streamSellAcknowledgement(req, res) {
  return serveLegacyPdfRoute(req, res, {
    docType: "SELL_ACKNOWLEDGEMENT",
    subjectKey: req.params.orderId,
    customerId: req.auth.id,
  });
}

export async function streamPayoutReceipt(req, res) {
  return serveLegacyPdfRoute(req, res, {
    docType: "PAYOUT_RECEIPT",
    subjectKey: req.params.payoutId,
  });
}

export async function streamMetalStatementPdf(req, res, { fromBusinessDate, toBusinessDate, customerId }) {
  const from = String(fromBusinessDate ?? "").trim();
  const to = String(toBusinessDate ?? "").trim();
  return serveLegacyPdfRoute(req, res, {
    docType: "METAL_STATEMENT",
    subjectKey: `statement:${from}:${to}`,
    customerId,
    statementPeriod: { fromBusinessDate: from, toBusinessDate: to },
  });
}
