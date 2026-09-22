import { maskSecret } from "./platform-dto.js";
import { writeAudit } from "../services/audit.service.js";

const SECRET_KEYS = new Set([
  "accessToken",
  "appSecret",
  "verifyToken",
  "clientSecret",
  "webhookPassword",
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

/** Express `req` fields like `headers` are not own-enumerable — do not `{...req}` for audit. */
function auditRequestContext(req) {
  if (!req) {
    return {
      auth: { id: "platform-system", type: "SYSTEM", tenantId: "platform" },
      headers: {},
      ip: "system",
    };
  }
  return {
    auth: req.auth,
    headers: req.headers,
    ip: req.ip,
    traceId: req.traceId,
    scope: req.scope,
  };
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
  const request = auditRequestContext(req);
  await writeAudit({
    req: {
      ...request,
      auth: {
        ...request.auth,
        tenantId: tenantId ?? request.auth?.tenantId ?? "platform",
      },
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
