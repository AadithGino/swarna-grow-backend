import { AuditEvent } from "../models/index.js";
import { AuditActorType } from "../constants/enums.js";
import { createId } from "../lib/ids.js";

const SECRET_KEYS = /password|otp|token|secret|salt|card|authorization/i;
function sanitize(value) {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEYS.test(key)).map(([key, item]) => [key, typeof item === "object" ? sanitize(item) : item]));
}
export async function writeAudit({ req, action, entityType, entityId, before, after, metadata, actorType, session }) {
  const id = createId("audit");
  await AuditEvent.create([{ _id: id, tenantId: req.auth.tenantId, branchId: req.auth.branchId, actorType: actorType ?? (req.auth.type === "CUSTOMER" ? AuditActorType.CUSTOMER : AuditActorType.USER), actorId: req.auth.id, action, entityType, entityId, before: sanitize(before), after: sanitize(after), metadata: sanitize(metadata), traceId: req.traceId, ip: req.ip, userAgent: req.headers["user-agent"] }], { session });
  return id;
}
