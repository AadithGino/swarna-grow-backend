import { AuditEvent, CashHandover, Customer, ExportJob, LedgerEntry, Payment, Scheme } from "../models/index.js";
import { PAYMENT_MODE_LABELS, PAYMENT_MODE_ORDER } from "../constants/enums.js";
import { createId } from "../lib/ids.js";
import { getQueue } from "../queues/index.js";
import { paginate } from "../lib/pagination.js";
import { AppError } from "../lib/app-error.js";

const dateMatch = (field, query) => ({ ...(query.from ? { [field]: { $gte: new Date(`${query.from}T00:00:00+05:30`) } } : {}), ...(query.to ? { [field]: { ...(query.from ? { $gte: new Date(`${query.from}T00:00:00+05:30`) } : {}), $lte: new Date(`${query.to}T23:59:59.999+05:30`) } } : {}) });
const fillModes = (rows) => PAYMENT_MODE_ORDER.filter((mode) => mode !== "LEGACY_ONLINE" || rows.some((row) => row._id === mode)).map((mode) => { const row = rows.find((item) => item._id === mode); return { mode, label: PAYMENT_MODE_LABELS[mode], amountPaise: row?.amountPaise ?? 0, count: row?.count ?? 0 }; });
export async function collectionSummary(req) {
  const match = { ...req.scope, status: "SUCCESS", ...dateMatch("paidAt", req.query) };
  const [totals, modes] = await Promise.all([Payment.aggregate([{ $match: match }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } }]), Payment.aggregate([{ $match: match }, { $group: { _id: "$mode", amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } }])]);
  return { amountPaise: totals[0]?.amountPaise ?? 0, count: totals[0]?.count ?? 0, byMode: fillModes(modes) };
}
export async function dashboard(req) {
  const start = new Date(); start.setHours(0, 0, 0, 0); const scope = req.scope;
  const [todayPayments, activeCustomers, activeSchemes, overdue, maturities, handovers, grievances] = await Promise.all([
    Payment.aggregate([{ $match: { ...scope, status: "SUCCESS", paidAt: { $gte: start } } }, { $group: { _id: "$mode", amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } }]),
    Customer.countDocuments({ ...scope, status: "ACTIVE" }), Scheme.countDocuments({ ...scope, status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] } }),
    Scheme.countDocuments({ ...scope, "installments.status": "OVERDUE" }), Scheme.countDocuments({ ...scope, status: "MATURED" }), CashHandover.countDocuments({ ...scope, status: "PENDING" }),
    (await import("../models/index.js")).Grievance.countDocuments({ ...scope, status: { $in: ["OPEN", "IN_PROGRESS"] } }),
  ]);
  return { today: { amountPaise: todayPayments.reduce((sum, row) => sum + row.amountPaise, 0), count: todayPayments.reduce((sum, row) => sum + row.count, 0), byMode: fillModes(todayPayments) }, customers: { active: activeCustomers }, schemes: { active: activeSchemes, overdue, matured: maturities }, attention: { pendingCashHandovers: handovers, openGrievances: grievances } };
}
export async function chart(req, key) {
  if (key === "scheme-status-distribution") return Scheme.aggregate([{ $match: req.scope }, { $group: { _id: "$status", value: { $sum: 1 } } }, { $project: { _id: 0, key: "$_id", label: "$_id", value: 1 } }]);
  if (key === "gold-accrual-trend") return LedgerEntry.aggregate([{ $match: { ...req.scope, weightMg: { $gt: 0 } } }, { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$effectiveAt", timezone: "Asia/Kolkata" } }, value: { $sum: "$weightMg" } } }, { $sort: { _id: 1 } }, { $project: { _id: 0, key: "$_id", label: "$_id", value: 1 } }]);
  const group = key === "collection-by-branch" ? "$branchId" : key === "collection-by-mode" ? "$mode" : { $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "Asia/Kolkata" } };
  return Payment.aggregate([{ $match: { ...req.scope, status: "SUCCESS", ...dateMatch("paidAt", req.query) } }, { $group: { _id: group, value: { $sum: "$amountPaise" }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $project: { _id: 0, key: "$_id", label: "$_id", value: 1, count: 1 } }]);
}
export async function report(req, reportKey) {
  if (reportKey === "COLLECTION") return { summary: await collectionSummary(req), rows: await Payment.find({ ...req.scope, status: "SUCCESS", ...dateMatch("paidAt", req.query) }).sort({ paidAt: -1 }).limit(100).lean() };
  if (reportKey === "GOLD_ACCRUAL") { const rows = await LedgerEntry.aggregate([{ $match: { ...req.scope, weightMg: { $gt: 0 }, ...dateMatch("effectiveAt", req.query) } }, { $group: { _id: "$branchId", weightMg: { $sum: "$weightMg" }, amountPaise: { $sum: "$amountPaise" }, payments: { $sum: 1 } } }]); return { rows, totals: rows.reduce((a, r) => ({ weightMg: a.weightMg + r.weightMg, amountPaise: a.amountPaise + r.amountPaise, payments: a.payments + r.payments }), { weightMg: 0, amountPaise: 0, payments: 0 }) }; }
  if (reportKey === "STAFF_PERFORMANCE") return { rows: await Payment.aggregate([{ $match: { ...req.scope, status: "SUCCESS", ...dateMatch("paidAt", req.query) } }, { $group: { _id: "$collectedBy", amountPaise: { $sum: "$amountPaise" }, payments: { $sum: 1 } } }, { $sort: { amountPaise: -1 } }]) };
  const rows = await Scheme.find({ ...req.scope, status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] } }).limit(100).lean(); return { rows, summary: { schemes: rows.length } };
}
export async function createExport(req) { const { from, to } = req.body.filters ?? {}; if (from && to) { const rangeMs = new Date(`${to}T23:59:59Z`) - new Date(`${from}T00:00:00Z`); if (rangeMs < 0 || rangeMs > 5 * 366 * 86_400_000) throw new AppError("EXPORT_RANGE_TOO_LARGE", "Export date range cannot exceed five years.", 422); } const job = await ExportJob.create({ _id: createId("export"), tenantId: req.auth.tenantId, requestedBy: req.auth.id, type: req.body.type, filters: { ...req.body.filters, format: req.body.format } }); const queue = getQueue("exports"); await queue?.add("generate", { exportId: job._id }, { jobId: job._id, attempts: 3, backoff: { type: "exponential", delay: 5000 } }); return job.toObject(); }
export async function getExport(req) { const job = await ExportJob.findOne({ _id: req.params.exportId ?? req.params.id, tenantId: req.auth.tenantId }).lean(); return job; }
export async function auditEvents(req) { const filters = {}; for (const key of ["entityType", "entityId", "actorId", "action"]) if (req.query[key]) filters[key] = req.query[key]; return paginate(AuditEvent, { scope: req.scope, filters, cursor: req.query.cursor, limit: req.query.limit, sort: "occurredAt:desc" }); }
