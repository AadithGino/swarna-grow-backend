import { IdempotencyRecord } from "../models/index.js";
import { sha256 } from "../lib/crypto.js";
import { AppError } from "../lib/app-error.js";

const stable = (value) => { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); };
export async function beginIdempotency({ tenantId, actorId, endpoint, key, body }) {
  const bodyHash = sha256(stable(body ?? {}));
  try {
    const record = await IdempotencyRecord.create({ tenantId, actorId, endpoint, key, bodyHash, expiresAt: new Date(Date.now() + 86_400_000) });
    return { record, replay: false };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const record = await IdempotencyRecord.findOne({ tenantId, actorId, endpoint, key });
    if (!record || record.bodyHash !== bodyHash) throw new AppError("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used with a different request.", 409);
    if (record.state === "PROCESSING") throw new AppError("REQUEST_IN_PROGRESS", "An identical request is already being processed.", 409);
    return { record, replay: true };
  }
}
export async function completeIdempotency(record, responseStatus, responseBody) { await IdempotencyRecord.updateOne({ _id: record._id }, { $set: { state: "COMPLETED", responseStatus, responseBody } }); }
export async function abandonIdempotency(record) { if (record) await IdempotencyRecord.deleteOne({ _id: record._id, state: "PROCESSING" }); }
