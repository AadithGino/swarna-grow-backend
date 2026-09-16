import PDFDocument from "pdfkit";
import sharp from "sharp";
import { Payment, PaymentIntent, PaymentLink } from "../models/index.js";
import { errors } from "../lib/app-error.js";
import { sendList, sendSuccess } from "../lib/response.js";
import * as payments from "../services/payment.service.js";
import * as messaging from "../services/messaging.service.js";

export const record = async (req, res) => sendSuccess(res, await payments.recordPayment(req), {}, 201);
export const list = async (req, res) => sendList(res, await payments.listPayments(req));
export const detail = async (req, res) => { const row = await Payment.findOne({ _id: req.params.paymentId, ...req.scope }).lean(); if (!row) throw errors.notFound("Payment"); sendSuccess(res, row); };
export const reverse = async (req, res) => sendSuccess(res, await payments.reversePayment(req));
export const createLink = async (req, res) => sendSuccess(res, await payments.createPaymentLink(req), {}, 201);
export const publicLink = async (req, res) => {
  const { publicPayStatus } = await import("../services/customer-app.service.js");
  sendSuccess(res, await publicPayStatus(req.params.linkToken ?? req.params.token));
};
export const publicStatus = async (req, res) => {
  const { publicPayStatus } = await import("../services/customer-app.service.js");
  const payload = await publicPayStatus(req.params.linkToken ?? req.params.token);
  sendSuccess(res, payload.poll ?? payload);
};
export const initiatePublic = async (req, res) => {
  const result = await payments.initiatePublicPayment(req);
  sendSuccess(res, {
    gatewayUrl: result.redirectUrl ?? result.paymentUrl,
    transactionId: result.providerOrderId ?? result.paymentId,
    paymentId: result.paymentId,
    expiresAt: result.expiresAt ?? null,
    ...result,
  });
};
export const createIntent = async (req, res) => sendSuccess(res, await payments.createPaymentIntent(req), {}, 201);
export const getIntent = async (req, res) => {
  const row = await PaymentIntent.findOne({ _id: req.params.intentId, tenantId: req.auth.tenantId, customerId: req.auth.id }).lean();
  if (!row) throw errors.notFound("Payment intent");
  const { paymentIntentAppDto } = await import("../lib/customer-app-dto.js");
  sendSuccess(res, paymentIntentAppDto(row));
};
export const cancelIntent = async (req, res) => {
  const result = await payments.cancelPaymentIntent(req);
  const { paymentIntentCancelDto } = await import("../lib/customer-app-dto.js");
  const { Payment, Scheme } = await import("../models/index.js");
  const payment = result.paymentId
    ? await Payment.findById(result.paymentId).lean()
    : null;
  const scheme = await Scheme.findById(result.schemeId).lean();
  sendSuccess(res, paymentIntentCancelDto(result, payment, scheme));
};
export const receipt = async (req, res) => { const payment = await Payment.findOne({ _id: req.params.paymentId, ...req.scope }).lean(); if (!payment) throw errors.notFound("Payment"); const doc = new PDFDocument({ size: "A5", margin: 36 }); res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `attachment; filename="${payment.receiptNumber}.pdf"`); doc.pipe(res); doc.fontSize(18).text(req.tenant.name).fontSize(13).text("Payment receipt").moveDown(); doc.fontSize(11).text(`Receipt: ${payment.receiptNumber}`).text(`Date: ${payment.paidAt.toISOString()}`).text(`Amount: INR ${(payment.amountPaise / 100).toFixed(2)}`).text(`Mode: ${payment.mode}`).text(`Status: ${payment.status}`); doc.end(); };
export const passbookImage = async (req, res) => { const payment = await Payment.findOne({ _id: req.params.paymentId, ...req.scope }).lean(); if (!payment) throw errors.notFound("Payment"); const text = [`Receipt ${payment.receiptNumber}`, `INR ${(payment.amountPaise / 100).toFixed(2)}`, `${payment.mode} · ${payment.status}`].map((line, i) => `<text x="48" y="${80 + i * 48}" font-size="${i === 1 ? 34 : 22}" fill="#3a1019">${line}</text>`).join(""); const png = await sharp(Buffer.from(`<svg width="760" height="320" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" rx="24" fill="#fcf6ee"/><text x="48" y="40" font-size="18" fill="#730321">${req.tenant.name}</text>${text}</svg>`)).png().toBuffer(); res.type("png").send(png); };
export const share = async (req, res) => sendSuccess(res, await messaging.sharePayment(req), {}, 202);
export const listLinks = async (req, res) => sendSuccess(res, await PaymentLink.find(req.scope).sort({ createdAt: -1 }).limit(200).lean());
export const cancelLink = async (req, res) => sendSuccess(res, await payments.cancelPaymentLink(req));
export const resendLink = async (req, res) =>
  sendSuccess(res, await payments.resendPaymentLink(req), {}, 202);
