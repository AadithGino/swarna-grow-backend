import { Customer, Scheme } from "../models/index.js";
import { sendList, sendSuccess } from "../lib/response.js";
import * as reporting from "../services/reporting.service.js";
import { paginate } from "../lib/pagination.js";

export const dashboard = async (req, res) => sendSuccess(res, await reporting.dashboard(req));
export const chart = async (req, res) => sendSuccess(res, await reporting.chart(req, req.params.chartKey));
export const activity = async (req, res) => sendList(res, await reporting.auditEvents(req));
export const report = async (req, res) => sendSuccess(res, await reporting.report(req, req.params.reportKey));
export const collectionSummary = async (req, res) => sendSuccess(res, await reporting.collectionSummary(req));
export const createExport = async (req, res) => sendSuccess(res, await reporting.createExport(req), {}, 202);
export const getExport = async (req, res) => sendSuccess(res, await reporting.getExport(req));
export const auditEvents = async (req, res) => sendList(res, await reporting.auditEvents(req));
export const dueList = (kind) => async (req, res) => { const filter = kind === "maturities" ? { status: "MATURED" } : kind === "defaulters" ? { status: "DEFAULTED", paymentPattern: "FIXED" } : kind === "overdues" ? { paymentPattern: "FIXED", "installments.status": "OVERDUE" } : { paymentPattern: "FIXED", "installments.status": { $in: ["DUE", "PARTIALLY_PAID"] } }; sendList(res, await paginate(Scheme, { scope: req.scope, filters: filter, cursor: req.query.cursor, limit: req.query.limit, sort: kind === "maturities" ? "maturityDate:asc" : "createdAt:desc" })); };
export const maturityCalendar = async (req, res) => { const month = req.query.month; sendSuccess(res, await Scheme.find({ ...req.scope, maturityDate: { $gte: `${month}-01`, $lte: `${month}-31` } }).select("_id customerId enrollmentNumber maturityDate status").lean()); };
export const staffHome = async (req, res) => { const summary = await reporting.collectionSummary(req); const customers = await Customer.countDocuments(req.scope); const schemes = await Scheme.countDocuments({ ...req.scope, status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] } }); sendSuccess(res, { today: summary, customers, activeSchemes: schemes }); };
