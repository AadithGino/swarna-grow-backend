import { AuditEvent, Customer, Payment, Redemption, Scheme, User } from "../models/index.js";
import { AuditActorType, AuditEntityType } from "../constants/enums.js";
import { errors } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import {
  dateMatch,
  effectiveScope,
  escaped,
  searchRegex,
} from "../lib/query-filters.js";
import { branchDto, loadBranchMap } from "../lib/relation-maps.js";

const SECRET_KEYS = /password|otp|token|secret|salt|card|authorization/i;
function sanitize(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEYS.test(key))
      .map(([key, item]) => [
        key,
        typeof item === "object" ? sanitize(item) : item,
      ]),
  );
}

const ACTION_LABELS = {
  CUSTOMER_CREATED: "Customer created",
  CUSTOMER_UPDATED: "Customer updated",
  CUSTOMER_BLOCKED: "Customer blocked",
  CUSTOMER_UNBLOCKED: "Customer unblocked",
  CUSTOMER_KYC_SUBMITTED: "KYC submitted",
  CUSTOMER_KYC_REVIEWED: "KYC reviewed",
  CUSTOMER_NOMINEE_UPDATED: "Nominee updated",
  CUSTOMER_NOMINEE_REMOVED: "Nominee removed",
  CUSTOMER_NOTE_ADDED: "Note added",
  SCHEME_ENROLLED: "Scheme enrolled",
  SCHEME_ENROLMENT_EXPIRED: "Scheme enrolment expired",
  SCHEME_PROJECTION_RECOMPUTED: "Scheme projection recomputed",
  PAYMENT_RECORDED: "Payment recorded",
  PAYMENT_REVERSED: "Payment reversed",
  STAFF_CREATED: "Staff created",
  STAFF_DEACTIVATED: "Staff deactivated",
  BRANCH_CREATED: "Branch created",
  GOLD_RATE_SET: "Gold rate set",
  CASH_HANDOVER_CREATED: "Cash handover created",
  CASH_HANDOVER_ACCEPTED: "Cash handover accepted",
  CASH_HANDOVER_REJECTED: "Cash handover rejected",
  CASH_HANDOVER_CANCELLED: "Cash handover cancelled",
  REDEMPTION_REQUESTED: "Redemption requested",
  PREMATURE_CLOSURE_REQUESTED: "Premature closure requested",
  REDEMPTION_PENDING_APPROVAL: "Redemption pending approval",
  REDEMPTION_APPROVED: "Redemption approved",
  REDEMPTION_REJECTED: "Redemption rejected",
  REDEMPTION_COMPLETED: "Redemption completed",
  SCHEME_REDEEMED: "Scheme marked redeemed",
  SCHEME_CLOSED_PREMATURE: "Scheme closed prematurely",
  FLEXIBLE_LOCK_APPLIED: "Flexible lock applied",
};

function formatScalar(value) {
  if (value == null) return "—";
  if (typeof value === "object") {
    if (value.amountPaise != null)
      return `₹${(Number(value.amountPaise) / 100).toLocaleString("en-IN")}`;
    if (value.status != null) return String(value.status);
    if (value.name != null) return String(value.name);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function diffChanges(before, after) {
  if (!before && !after) return [];
  if (!before && after) {
    return Object.keys(after)
      .filter(
        (key) =>
          ![
            "_id",
            "tenantId",
            "createdAt",
            "updatedAt",
            "version",
            "passwordHash",
            "fcmTokens",
          ].includes(key),
      )
      .slice(0, 8)
      .map((field) => ({ field, from: "—", to: formatScalar(after[field]) }));
  }
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  const skip = new Set([
    "_id",
    "tenantId",
    "createdAt",
    "updatedAt",
    "passwordHash",
    "fcmTokens",
    "planSnapshot",
    "installments",
    "cycles",
  ]);
  const changes = [];
  for (const field of keys) {
    if (skip.has(field)) continue;
    const from = before?.[field];
    const to = after?.[field];
    const fromText = formatScalar(from);
    const toText = formatScalar(to);
    if (fromText === toText) continue;
    changes.push({ field, from: fromText, to: toText });
    if (changes.length >= 8) break;
  }
  return changes;
}

function buildSummary(event) {
  const label =
    ACTION_LABELS[event.action] ??
    event.action.replaceAll("_", " ").toLowerCase();
  if (event.metadata?.reason) return `${label}: ${event.metadata.reason}`;
  if (event.metadata?.remarks) return `${label}: ${event.metadata.remarks}`;
  if (event.metadata?.note) return `${label}: ${event.metadata.note}`;
  if (event.after?.customerNumber)
    return `${label} · ${event.after.customerNumber}`;
  if (event.after?.enrollmentNumber)
    return `${label} · ${event.after.enrollmentNumber}`;
  if (event.after?.receiptNumber)
    return `${label} · ${event.after.receiptNumber}`;
  if (event.after?.name) return `${label} · ${event.after.name}`;
  if (event.after?.amountPaise != null) {
    return `${label} · ₹${(Number(event.after.amountPaise) / 100).toLocaleString("en-IN")}`;
  }
  return label;
}

async function attachActors(events) {
  if (!events.length) return events;
  const branchIds = [
    ...new Set(events.map((row) => row.branchId).filter(Boolean)),
  ];
  const userIds = [
    ...new Set(
      events
        .filter(
          (row) =>
            row.actorType === AuditActorType.USER || row.actorType === "USER",
        )
        .map((row) => row.actorId)
        .filter(Boolean),
    ),
  ];
  const customerIds = [
    ...new Set(
      events
        .filter(
          (row) =>
            row.actorType === AuditActorType.CUSTOMER ||
            row.actorType === "CUSTOMER",
        )
        .map((row) => row.actorId)
        .filter(Boolean),
    ),
  ];
  const tenantId = events[0]?.tenantId;
  const [users, customers, branchMap] = await Promise.all([
    userIds.length
      ? User.find({ _id: { $in: userIds } })
          .select("_id name role")
          .lean()
      : [],
    customerIds.length
      ? Customer.find({ _id: { $in: customerIds } })
          .select("_id name")
          .lean()
      : [],
    tenantId ? loadBranchMap(tenantId, branchIds) : Promise.resolve(new Map()),
  ]);
  const userMap = new Map(users.map((row) => [row._id, row]));
  const customerMap = new Map(customers.map((row) => [row._id, row]));
  return events.map((event) => {
    const user = userMap.get(event.actorId);
    const customer = customerMap.get(event.actorId);
    const actorName =
      user?.name ??
      customer?.name ??
      (event.actorType === "SYSTEM"
        ? "System"
        : event.actorId
          ? String(event.actorId)
          : "—");
    const changes = diffChanges(event.before, event.after);
    return {
      ...event,
      actor: {
        id: event.actorId,
        type: event.actorType,
        name: actorName,
        role: user?.role,
      },
      branch: branchDto(branchMap.get(event.branchId)),
      summary: buildSummary(event),
      changes,
    };
  });
}

function branchIdFromAuditPayload(before, after, req) {
  const afterRow = sanitize(after);
  const beforeRow = sanitize(before);
  return (
    afterRow?.branchId ??
    beforeRow?.branchId ??
    req?.scope?.branchId ??
    req?.auth?.branchId ??
    undefined
  );
}

export async function writeAudit({
  req,
  action,
  entityType,
  entityId,
  before,
  after,
  metadata,
  actorType,
  session,
}) {
  const id = createId("audit");
  await AuditEvent.create(
    [
      {
        _id: id,
        tenantId: req.auth.tenantId,
        branchId: branchIdFromAuditPayload(before, after, req),
        actorType:
          actorType ??
          (req.auth.type === "CUSTOMER"
            ? AuditActorType.CUSTOMER
            : AuditActorType.USER),
        actorId: req.auth.id,
        action,
        entityType,
        entityId,
        before: sanitize(before),
        after: sanitize(after),
        metadata: sanitize(metadata),
        traceId: req.traceId,
        ip: req.ip,
        userAgent: req.headers?.["user-agent"],
      },
    ],
    { session },
  );
  return id;
}

export async function listEntityAudit(req, entityType, entityId) {
  const result = await paginate(AuditEvent, {
    scope: { tenantId: req.auth.tenantId },
    filters: { entityType, entityId },
    cursor: req.query.cursor,
    limit: req.query.limit ?? 50,
    sort: "occurredAt:desc",
  });
  result.data = await attachActors(result.data);
  return result;
}

/** Customer 360 activity: customer events plus related scheme/payment/redemption audits. */
export async function listCustomerAudit(req, customerId) {
  const tenantId = req.auth.tenantId;
  const branchFilter = req.scope?.branchId ? { branchId: req.scope.branchId } : {};
  const customer = await Customer.findOne({ _id: customerId, tenantId, ...branchFilter }).select("_id").lean();
  if (!customer) throw errors.notFound("Customer");
  const [payments, schemes, redemptions] = await Promise.all([
    Payment.find({ tenantId, customerId, ...branchFilter }).select("_id").lean(),
    Scheme.find({ tenantId, customerId, ...branchFilter }).select("_id").lean(),
    Redemption.find({ tenantId, customerId, ...branchFilter }).select("_id").lean(),
  ]);
  const entityIds = [
    customerId,
    ...payments.map((row) => row._id),
    ...schemes.map((row) => row._id),
    ...redemptions.map((row) => row._id),
  ];
  const result = await paginate(AuditEvent, {
    scope: { tenantId },
    filters: {
      entityType: {
        $in: [
          AuditEntityType.CUSTOMER,
          AuditEntityType.SCHEME,
          AuditEntityType.PAYMENT,
          AuditEntityType.REDEMPTION,
        ],
      },
      entityId: { $in: entityIds },
    },
    cursor: req.query.cursor,
    limit: req.query.limit ?? 50,
    sort: "occurredAt:desc",
  });
  result.data = await attachActors(result.data);
  return result;
}

function auditListScope(req) {
  return effectiveScope(req);
}

export async function listAuditEvents(req) {
  const scope = auditListScope(req);
  const filters = {};
  for (const key of ["entityType", "entityId", "actorId"]) {
    if (req.query[key]) filters[key] = req.query[key];
  }
  const actionQ = String(req.query.action ?? "").trim();
  if (actionQ) {
    filters.action = new RegExp(escaped(actionQ), "i");
  }
  // Accept `type` as an alias used by the admin UI filter.
  if (!filters.entityType && req.query.type) filters.entityType = req.query.type;
  Object.assign(filters, dateMatch("occurredAt", req.query));
  const pattern = searchRegex(req.query.q);
  if (pattern) {
    const actorRows = await User.find({
      tenantId: req.auth.tenantId,
      name: pattern,
    })
      .select("_id")
      .limit(40)
      .lean();
    const actorIds = actorRows.map((row) => row._id);
    filters.$or = [
      { action: pattern },
      { entityId: pattern },
      { actorId: pattern },
      ...(actorIds.length ? [{ actorId: { $in: actorIds } }] : []),
      { "after.customerNumber": pattern },
      { "after.enrollmentNumber": pattern },
      { "after.receiptNumber": pattern },
      { "after.name": pattern },
      { "after.status": pattern },
      { "metadata.note": pattern },
      { "metadata.reason": pattern },
      { "metadata.remarks": pattern },
    ];
  }
  const result = await paginate(AuditEvent, {
    scope,
    filters,
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: "occurredAt:desc",
  });
  if (!req.query.cursor) {
    result.meta.total = await AuditEvent.countDocuments({ ...scope, ...filters });
  }
  result.data = await attachActors(result.data);
  return result;
}

export { sanitize };
