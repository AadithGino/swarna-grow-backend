import { IdempotencyRecord } from "../models/index.js";
import { sha256 } from "../lib/crypto.js";
import { AppError } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { idempotencyEndpointsCompatible } from "../lib/idempotency-endpoint.js";

const LEASE_MS = 5 * 60_000;
const stable = (value) => { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); };

export function hashIdempotencyBody(body) {
  return sha256(stable(body ?? {}));
}

/** Allow retry when provider init failed without a durable checkout token. */
function isRepairablePaymentInitFailedRecord(record) {
  if (record?.state !== "COMPLETED" || record.responseStatus !== 422) return false;
  const code = record.responseBody?.error?.code;
  return (
    code === "PAYMENT_INIT_FAILED"
    || code === "PAYMENT_INITIATION_UNCERTAIN"
    || code === "PAYMENT_GATEWAY_UNAUTHORIZED"
  );
}

async function resolveExistingIdempotencyRecord({ tenantId, actorId, endpoint, key, bodyHash }) {
  const exact = await IdempotencyRecord.findOne({ tenantId, actorId, endpoint, key });
  if (exact) return exact;
  const siblings = await IdempotencyRecord.find({ tenantId, actorId, key });
  if (!siblings.length) return null;
  for (const row of siblings) {
    if (row.bodyHash !== bodyHash) {
      throw new AppError("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used with a different request.", 409);
    }
  }
  const compatible = siblings.filter((row) => idempotencyEndpointsCompatible(row.endpoint, endpoint));
  if (!compatible.length) {
    throw new AppError("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used on a different resource.", 409);
  }
  if (compatible.length > 1) {
    throw new AppError("IDEMPOTENCY_KEY_REUSED", "This idempotency key has conflicting idempotency records.", 409);
  }
  return compatible[0];
}

async function handleExistingIdempotencyRecord(record, { tenantId, actorId, endpoint, key, bodyHash, leaseOwner, leaseExpiresAt }) {
  if (record.bodyHash !== bodyHash) {
    throw new AppError("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used with a different request.", 409);
  }
  if (record.state === "PROCESSING") {
    if (record.leaseExpiresAt && record.leaseExpiresAt < new Date()) {
      const claimed = await IdempotencyRecord.findOneAndUpdate(
        { _id: record._id, state: "PROCESSING", leaseExpiresAt: { $lt: new Date() } },
        { $set: { leaseOwner, leaseExpiresAt, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), endpoint } },
        { new: true },
      );
      if (claimed) return { record: claimed, replay: false };
    }
    throw new AppError("REQUEST_IN_PROGRESS", "An identical request is already being processed.", 409);
  }
  if (isRepairablePaymentInitFailedRecord(record)) {
    await IdempotencyRecord.deleteOne({ _id: record._id, state: "COMPLETED", responseStatus: 422 });
    const repaired = await IdempotencyRecord.create({
      tenantId,
      actorId,
      endpoint,
      key,
      bodyHash,
      leaseOwner,
      leaseExpiresAt,
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return { record: repaired, replay: false };
  }
  if (record.endpoint !== endpoint) {
    await IdempotencyRecord.updateOne({ _id: record._id }, { $set: { endpoint } });
    record.endpoint = endpoint;
  }
  return { record, replay: true };
}

export async function beginIdempotency({ tenantId, actorId, endpoint, key, body }) {
  const bodyHash = sha256(stable(body ?? {}));
  const leaseOwner = createId("lease");
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS);
  const lookupContext = { tenantId, actorId, endpoint, key, bodyHash, leaseOwner, leaseExpiresAt };

  const existing = await resolveExistingIdempotencyRecord(lookupContext);
  if (existing) return handleExistingIdempotencyRecord(existing, lookupContext);

  try {
    const record = await IdempotencyRecord.create({ tenantId, actorId, endpoint, key, bodyHash, leaseOwner, leaseExpiresAt, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) });
    return { record, replay: false };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const record = await IdempotencyRecord.findOne({ tenantId, actorId, endpoint, key });
    if (!record) {
      const raced = await resolveExistingIdempotencyRecord(lookupContext);
      if (raced) return handleExistingIdempotencyRecord(raced, lookupContext);
      throw error;
    }
    return handleExistingIdempotencyRecord(record, lookupContext);
  }
}
export async function renewIdempotencyLease(record) { if (record) await IdempotencyRecord.updateOne({ _id: record._id, state: "PROCESSING", leaseOwner: record.leaseOwner }, { $set: { heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + LEASE_MS) } }); }
export async function completeIdempotency(record, responseStatus, responseBody) { await IdempotencyRecord.updateOne({ _id: record._id, state: "PROCESSING", leaseOwner: record.leaseOwner }, { $set: { state: "COMPLETED", responseStatus, responseBody }, $unset: { leaseOwner: "", leaseExpiresAt: "" } }); }
export async function abandonIdempotency(record) { if (record) await IdempotencyRecord.deleteOne({ _id: record._id, state: "PROCESSING", leaseOwner: record.leaseOwner }); }
