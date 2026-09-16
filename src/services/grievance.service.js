import { AuditEntityType, GrievanceMessageType, GrievancePriority, GrievanceStatus } from "../constants/enums.js";
import { Customer, Grievance } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { writeAudit } from "./audit.service.js";
import { paginate } from "../lib/pagination.js";
import { nextSequence } from "./sequence.service.js";
import { effectiveScope, searchRegex } from "../lib/query-filters.js";
import { now } from "../lib/date.js";
import {
  branchDto,
  customerDto,
  loadBranchMap,
  loadCustomerMap,
  loadUserMap,
  userDto,
} from "../lib/relation-maps.js";

const SLA_HOURS = Object.freeze({ URGENT: 1, HIGH: 4, NORMAL: 24, LOW: 48 });
const TRANSITIONS = Object.freeze({ OPEN: ["IN_PROGRESS"], IN_PROGRESS: ["WAITING_FOR_CUSTOMER", "RESOLVED"], WAITING_FOR_CUSTOMER: ["IN_PROGRESS", "RESOLVED"], RESOLVED: ["CLOSED", "IN_PROGRESS"], CLOSED: [] });
const dueAt = (createdAt, priority) => new Date(new Date(createdAt).getTime() + SLA_HOURS[priority] * 3_600_000);
function grievanceScope(req) {
  if (req.auth.type === "CUSTOMER") {
    return { tenantId: req.auth.tenantId, customerId: req.auth.id };
  }
  return effectiveScope(req);
}

const ACTIVE_GRIEVANCE_STATUSES = [
  GrievanceStatus.OPEN,
  GrievanceStatus.IN_PROGRESS,
  GrievanceStatus.WAITING_FOR_CUSTOMER,
];

async function grievanceListSummary(req, listFilters = {}) {
  const scope = { ...grievanceScope(req), ...listFilters };
  const at = now();
  const startOfToday = at.startOf("day").toDate();
  const activeFilter = { ...scope, status: { $in: ACTIVE_GRIEVANCE_STATUSES } };
  const [open, inProgress, waitingForCustomer, urgent, overdueFirstResponse, resolvedToday] =
    await Promise.all([
      Grievance.countDocuments({ ...scope, status: GrievanceStatus.OPEN }),
      Grievance.countDocuments({ ...scope, status: GrievanceStatus.IN_PROGRESS }),
      Grievance.countDocuments({
        ...scope,
        status: GrievanceStatus.WAITING_FOR_CUSTOMER,
      }),
      Grievance.countDocuments({
        ...activeFilter,
        priority: GrievancePriority.URGENT,
      }),
      Grievance.countDocuments({
        ...activeFilter,
        firstResponseAt: { $exists: false },
        firstResponseDueAt: { $lt: new Date() },
      }),
      Grievance.countDocuments({
        ...scope,
        resolvedAt: { $gte: startOfToday },
      }),
    ]);
  return {
    open,
    inProgress,
    waitingForCustomer,
    urgent,
    overdueFirstResponse,
    resolvedToday,
  };
}

function actorDisplayName(message, customerMap, userMap) {
  if (message.actorType === "SYSTEM") return "System";
  if (message.actorType === "CUSTOMER") {
    return customerMap.get(message.actorId)?.name ?? "Customer";
  }
  return userMap.get(message.actorId)?.name ?? "Staff";
}

function mapGrievanceMessages(row, customerMap, userMap) {
  return (row.messages ?? []).map((message) => ({
    ...message,
    messageType: message.type,
    author: {
      actorType: message.actorType,
      name: actorDisplayName(message, customerMap, userMap),
    },
  }));
}

async function enrichGrievanceList(tenantId, rows) {
  if (!rows.length) return rows;
  const [customerMap, branchMap, userMap] = await Promise.all([
    loadCustomerMap(tenantId, rows.map((row) => row.customerId)),
    loadBranchMap(tenantId, rows.map((row) => row.branchId)),
    loadUserMap(rows.map((row) => row.assigneeId)),
  ]);
  return rows.map((row) => ({
    ...row,
    customer: customerDto(customerMap.get(row.customerId)),
    branch: branchDto(branchMap.get(row.branchId)),
    assignee: userDto(userMap.get(row.assigneeId)),
    firstResponseOverdue: !row.firstResponseAt && row.firstResponseDueAt < new Date(),
  }));
}

async function enrichGrievanceDetail(tenantId, row) {
  const [customerMap, branchMap, userMap] = await Promise.all([
    loadCustomerMap(tenantId, [row.customerId]),
    loadBranchMap(tenantId, [row.branchId]),
    loadUserMap([
      row.assigneeId,
      ...(row.messages ?? []).map((message) => message.actorId),
    ]),
  ]);
  return {
    ...row,
    customer: customerDto(customerMap.get(row.customerId)),
    branch: branchDto(branchMap.get(row.branchId)),
    assignee: userDto(userMap.get(row.assigneeId)),
    firstResponseOverdue: !row.firstResponseAt && row.firstResponseDueAt < new Date(),
    messages: mapGrievanceMessages(row, customerMap, userMap),
  };
}
export async function createGrievance(req) { return withTransaction(async (session) => { const createdAt = new Date(); const number = await nextSequence(req.auth.tenantId, `grievance:${createdAt.getFullYear()}`, session); const row = (await Grievance.create([{ _id: createId("grievance"), tenantId: req.auth.tenantId, branchId: req.auth.branchId, customerId: req.auth.id, ticketNumber: `SG-${createdAt.getFullYear()}-${String(number).padStart(6, "0")}`, ...req.body, priority: GrievancePriority.NORMAL, firstResponseDueAt: dueAt(createdAt, GrievancePriority.NORMAL), messages: [{ type: GrievanceMessageType.PUBLIC_REPLY, actorType: "CUSTOMER", actorId: req.auth.id, body: req.body.description, attachmentUploadIds: req.body.attachmentUploadIds }] }], { session }))[0]; const auditEventId = await writeAudit({ req, action: "GRIEVANCE_CREATED", entityType: AuditEntityType.GRIEVANCE, entityId: row._id, after: row.toObject(), session }); return { ...row.toObject(), auditEventId }; }); }
export async function listGrievances(req) {
  const filters = {};
  for (const key of ["status", "category", "priority", "assigneeId"]) if (req.query[key]) filters[key] = req.query[key];
  if (req.query.overdueOnly === "true" || req.query.overdueOnly === true) {
    filters.firstResponseAt = { $exists: false };
    filters.firstResponseDueAt = { $lt: new Date() };
    filters.status = { $in: ACTIVE_GRIEVANCE_STATUSES };
  }
  const pattern = searchRegex(req.query.q);
  if (pattern) {
    const matchedCustomers = await Customer.find({
      tenantId: req.auth.tenantId,
      ...(req.scope.branchId ? { branchId: req.scope.branchId } : {}),
      $or: [{ name: pattern }, { mobile: pattern }, { customerNumber: pattern }],
    }).select("_id").lean();
    filters.$or = [
      { ticketNumber: pattern },
      { subject: pattern },
      { customerId: { $in: matchedCustomers.map((row) => row._id) } },
    ];
  }
  const sort = req.query.sort ?? "createdAt:desc";
  const page = await paginate(Grievance, {
    scope: grievanceScope(req),
    filters,
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort,
  });
  const includeSummary =
    req.query.includeSummary === "true" || req.query.includeSummary === true;
  if (includeSummary) {
    page.meta = {
      ...page.meta,
      summary: await grievanceListSummary(req, filters),
    };
  }
  page.data = await enrichGrievanceList(req.auth.tenantId, page.data);
  return page;
}
export async function getGrievance(req) {
  const row = await Grievance.findOne({ _id: req.params.grievanceId ?? req.params.id, ...grievanceScope(req) }).lean();
  if (!row) throw errors.notFound("Grievance");
  return enrichGrievanceDetail(req.auth.tenantId, row);
}
export async function addGrievanceMessage(req) { return withTransaction(async (session) => { const row = await Grievance.findOne({ _id: req.params.grievanceId, ...grievanceScope(req) }).session(session); if (!row) throw errors.notFound("Grievance"); if (req.body.expectedVersion && req.body.expectedVersion !== row.version) throw new AppError("VERSION_CONFLICT", "This grievance changed. Refresh and try again.", 409); if (req.auth.type === "CUSTOMER" && req.body.messageType === GrievanceMessageType.INTERNAL_NOTE) throw errors.forbidden(); const message = { type: req.body.messageType, actorType: req.auth.type === "CUSTOMER" ? "CUSTOMER" : "USER", actorId: req.auth.id, body: req.body.body, attachmentUploadIds: req.body.attachmentUploadIds, createdAt: new Date() }; row.messages.push(message); if (req.auth.type !== "CUSTOMER" && message.type === GrievanceMessageType.PUBLIC_REPLY && !row.firstResponseAt) row.firstResponseAt = new Date(); row.version += 1; await row.save({ session }); const auditEventId = await writeAudit({ req, action: message.type === GrievanceMessageType.INTERNAL_NOTE ? "GRIEVANCE_NOTE_ADDED" : "GRIEVANCE_REPLIED", entityType: AuditEntityType.GRIEVANCE, entityId: row._id, metadata: { messageType: message.type }, session }); return { message: row.messages.at(-1), version: row.version, auditEventId }; }); }
export async function mutateGrievance(req, action) { return withTransaction(async (session) => { const row = await Grievance.findOne({ _id: req.params.grievanceId, ...req.scope }).session(session); if (!row) throw errors.notFound("Grievance"); const before = row.toObject(); if (action === "assign") row.assigneeId = req.body.assigneeId; if (action === "priority") { row.priority = req.body.priority; if (!row.firstResponseAt) row.firstResponseDueAt = dueAt(row.createdAt, row.priority); } if (action === "status") { const next = req.body.status; if (!TRANSITIONS[row.status].includes(next)) throw errors.business("GRIEVANCE_STATUS_INVALID", "This grievance cannot move to the requested status."); row.status = next; if (next === GrievanceStatus.RESOLVED) row.resolvedAt = new Date(); if (next === GrievanceStatus.CLOSED) row.closedAt = new Date(); } row.version += 1; await row.save({ session }); const auditEventId = await writeAudit({ req, action: `GRIEVANCE_${action.toUpperCase()}_UPDATED`, entityType: AuditEntityType.GRIEVANCE, entityId: row._id, before, after: row.toObject(), session }); return { ...row.toObject(), auditEventId }; }); }
export async function reopenGrievance(req) { return withTransaction(async (session) => { const row = await Grievance.findOne({ _id: req.params.grievanceId, tenantId: req.auth.tenantId, customerId: req.auth.id }).session(session); if (!row) throw errors.notFound("Grievance"); if (row.status !== GrievanceStatus.RESOLVED || !row.resolvedAt || Date.now() - row.resolvedAt.getTime() > 7 * 86_400_000) throw errors.business("GRIEVANCE_REOPEN_WINDOW_EXPIRED", "This grievance can no longer be reopened."); if (req.body.expectedVersion !== row.version) throw new AppError("VERSION_CONFLICT", "This grievance changed. Refresh and try again.", 409); row.status = GrievanceStatus.IN_PROGRESS; row.resolvedAt = undefined; row.version += 1; await row.save({ session }); const auditEventId = await writeAudit({ req, action: "GRIEVANCE_REOPENED", entityType: AuditEntityType.GRIEVANCE, entityId: row._id, after: row.toObject(), session }); return { ...row.toObject(), auditEventId }; }); }
