import PDFDocument from "pdfkit";
import { Customer, Message, Payment, Scheme } from "../models/index.js";
import { sendList, sendSuccess } from "../lib/response.js";
import * as customers from "../services/customer.service.js";
import * as messaging from "../services/messaging.service.js";
import { mobileLookupVariants } from "../lib/mobile.js";

export const list = async (req, res) => sendList(res, await customers.listCustomers(req));
export const create = async (req, res) => sendSuccess(res, await customers.createCustomer(req), {}, 201);
export const update = async (req, res) => sendSuccess(res, await customers.updateCustomer(req));
export const setPassword = async (req, res) => sendSuccess(res, await customers.setCustomerPassword(req));
export const detail = async (req, res) => sendSuccess(res, await customers.customer360(req));
export const relations = (relation) => async (req, res) => sendList(res, await customers.listCustomerRelations(req, relation));
export const kyc = (verify = false) => async (req, res) => sendSuccess(res, await customers.updateKyc(req, verify));
export const nominee = (remove = false) => async (req, res) => sendSuccess(res, await customers.setNominee(req, remove));
export const nomineeDetail = async (req, res) => sendSuccess(res, (await customers.getCustomer(req)).nominee);
export const block = (blocked = true) => async (req, res) => sendSuccess(res, await customers.blockCustomer(req, blocked));
export const whatsappOpt = async (req, res) => sendSuccess(res, await customers.setWhatsappOpt(req));
export const note = async (req, res) => sendSuccess(res, await customers.addNote(req), {}, 201);
export const checkMobile = async (req, res) => {
  const variants = mobileLookupVariants(req.query.mobile);
  const exists = variants.length
    ? Boolean(
        await Customer.exists({
          tenantId: req.auth.tenantId,
          mobile: { $in: variants },
        }),
      )
    : false;
  sendSuccess(res, { exists, mobile: req.query.mobile });
};
export const analytics = async (req, res) => sendSuccess(res, await customers.customerAnalytics(req));
export const shareStatement = async (req, res) =>
  sendSuccess(res, await messaging.shareCustomerStatement(req), {}, 202);
export const statement = async (req, res) => { const customer = await customers.customer360(req); const payments = await Payment.find({ tenantId: req.auth.tenantId, customerId: customer._id }).sort({ paidAt: 1 }).lean(); const doc = new PDFDocument({ margin: 48 }); res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `attachment; filename="${customer.customerNumber}-statement.pdf"`); doc.pipe(res); doc.fontSize(20).text(req.tenant.name).fontSize(14).text("Customer statement").moveDown(); doc.text(`${customer.name} · ${customer.customerNumber}`).moveDown(); for (const payment of payments) doc.fontSize(10).text(`${payment.paidAt.toISOString().slice(0, 10)}   ${payment.receiptNumber}   ${(payment.amountPaise / 100).toFixed(2)}   ${payment.mode}   ${payment.status}`); doc.end(); };
export const appProfile = async (req, res) => sendSuccess(res, await Customer.findOne({ _id: req.auth.id, tenantId: req.auth.tenantId }).select("-fcmTokens").lean());
export const updateAppProfile = async (req, res) => {
  const customerApp = await import("../services/customer-app.service.js");
  sendSuccess(res, await customerApp.completeAppProfile(req.auth, req.body));
};
export const appHome = async (req, res) => { const [customer, schemes, payments, messages] = await Promise.all([Customer.findById(req.auth.id).lean(), Scheme.find({ tenantId: req.auth.tenantId, customerId: req.auth.id, status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED", "MATURED"] } }).lean(), Payment.find({ tenantId: req.auth.tenantId, customerId: req.auth.id }).sort({ paidAt: -1 }).limit(5).lean(), Message.find({ tenantId: req.auth.tenantId, customerId: req.auth.id }).sort({ createdAt: -1 }).limit(5).lean()]); sendSuccess(res, { customer, schemes, recentPayments: payments, notifications: messages }); };
