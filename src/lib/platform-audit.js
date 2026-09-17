import { maskSecret } from "./platform-dto.js";
import { writeAudit } from "../services/audit.service.js";

const SECRET_KEYS = new Set([
  "accessToken",
  "appSecret",
  "verifyToken",
  "saltKey",
  "passwordHash",
]);

export function redactPlatformAuditPayload(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactPlatformAuditPayload);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEYS.has(key) && typeof val === "string" && val.length > 0) {
      out[key] = maskSecret(val);
    } else if (val && typeof val === "object") {
      out[key] = redactPlatformAuditPayload(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

export async function auditPlatformMutation({
  req,
  action,
  entityType,
  entityId,
  tenantId,
  before,
  after,
  session,
}) {
  await writeAudit({
    req: {
      ...req,
      auth: { ...req.auth, tenantId: tenantId ?? req.auth?.tenantId ?? "platform" },
    },
    action,
    entityType,
    entityId,
    before: before ? redactPlatformAuditPayload(before) : undefined,
    after: after ? redactPlatformAuditPayload(after) : undefined,
    actorType: "USER",
    session,
  });
}
