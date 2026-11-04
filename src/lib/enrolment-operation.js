import { EnrolmentOperation } from '../models/index.js';
import { hashIdempotencyBody } from '../services/idempotency.service.js';
import { withTransientTransactionRetry } from './transaction.js';
import { errors } from './app-error.js';

export async function withDurableEnrolment(req, work) {
  const key = String(req.headers?.['x-idempotency-key'] ?? '').trim();
  // HTTP enrol routes already require a key; preserve unkeyed internal callers.
  if (!key) return withTransientTransactionRetry(work);
  const identity = { tenantId: req.auth.tenantId, actorId: req.auth.id, scope: `${req.auth.type}:${req.baseUrl ?? 'enrol'}`, key };
  const id = `enrop_${hashIdempotencyBody(identity)}`;
  const bodyHash = hashIdempotencyBody({ body: req.body, targetCycle: req.query?.targetCycle });
  const replay = row => {
    if (row.bodyHash !== bodyHash) throw errors.conflict('IDEMPOTENCY_KEY_REUSED', 'Enrolment key was used with different inputs.');
    return row.result;
  };
  const existing = await EnrolmentOperation.findById(id).lean();
  if (existing) return replay(existing);
  try {
    return await withTransientTransactionRetry(async session => {
      const found = await EnrolmentOperation.findById(id).session(session).lean();
      if (found) return replay(found);
      const result = await work(session);
      await EnrolmentOperation.create([{ _id: id, ...identity, bodyHash, result }], { session });
      return result;
    });
  } catch (error) {
    if (error.code === 11000) {
      const committed = await EnrolmentOperation.findById(id).lean();
      if (committed) return replay(committed);
    }
    throw error;
  }
}
