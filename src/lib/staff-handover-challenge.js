/**
 * Staff-issued handover challenges (Option A legacy pickup compatibility).
 * Separate from customer-revealed pickup display codes — must not prove handover alone.
 *
 * Bound to: orderId, customerId, branchId, purpose, expiry.
 * Consumed once atomically by caller inside a MongoDB transaction.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { seal, unseal } from "./crypto.js";
import { AppError } from "./app-error.js";

export const STAFF_HANDOVER_CHALLENGE_PURPOSE = Object.freeze({
  ECOMMERCE_PICKUP_LEGACY_CONFIRM: "ECOMMERCE_PICKUP_LEGACY_CONFIRM",
  ECOMMERCE_PICKUP_STAFF_VERIFY: "ECOMMERCE_PICKUP_STAFF_VERIFY",
  DIGITAL_METAL_REDEMPTION_PICKUP_LEGACY: "DIGITAL_METAL_REDEMPTION_PICKUP_LEGACY",
});

const DEFAULT_TTL_MS = 15 * 60_000;

function hashChallenge(code, binding) {
  const payload = [
    String(binding.orderId),
    String(binding.customerId),
    String(binding.branchId ?? ""),
    String(binding.purpose),
    String(code),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

function generateChallengeCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * @returns {{ challengeCode: string, challengeHash: string, challengeSealed: string, expiresAt: Date }}
 */
export function createStaffHandoverChallenge(binding, { ttlMs = DEFAULT_TTL_MS } = {}) {
  assertBinding(binding);
  const challengeCode = generateChallengeCode();
  const expiresAt = new Date(Date.now() + Math.max(60_000, ttlMs));
  return {
    challengeCode,
    challengeHash: hashChallenge(challengeCode, binding),
    challengeSealed: seal(challengeCode),
    expiresAt,
    purpose: binding.purpose,
    orderId: binding.orderId,
    customerId: binding.customerId,
    branchId: binding.branchId ?? null,
  };
}

function assertBinding(binding) {
  if (!binding?.orderId || !binding?.customerId || !binding?.purpose) {
    throw new AppError("VALIDATION", "Handover challenge binding requires orderId, customerId, and purpose.", 400);
  }
  if (!Object.values(STAFF_HANDOVER_CHALLENGE_PURPOSE).includes(binding.purpose)) {
    throw new AppError("VALIDATION", "Invalid handover challenge purpose.", 400, { purpose: binding.purpose });
  }
}

/**
 * Verify customer-submitted challenge against stored record (not yet consumed).
 */
export function verifyStaffHandoverChallenge(stored, submittedCode, expectedBinding) {
  assertBinding(expectedBinding);
  if (!stored?.challengeHash || stored.consumedAt) {
    throw new AppError("HANDOVER_CHALLENGE_INVALID", "Handover challenge is not active.", 409);
  }
  if (stored.expiresAt && new Date(stored.expiresAt).getTime() < Date.now()) {
    throw new AppError("HANDOVER_CHALLENGE_EXPIRED", "Handover challenge expired. Ask staff for a new one.", 409);
  }
  for (const key of ["orderId", "customerId", "purpose"]) {
    if (String(stored[key] ?? "") !== String(expectedBinding[key] ?? "")) {
      throw new AppError("HANDOVER_CHALLENGE_INVALID", "Handover challenge does not match this order.", 403);
    }
  }
  const branchExpected = String(expectedBinding.branchId ?? "");
  const branchStored = String(stored.branchId ?? "");
  if (branchExpected && branchStored && branchExpected !== branchStored) {
    throw new AppError("HANDOVER_CHALLENGE_INVALID", "Handover challenge does not match this branch.", 403);
  }
  const code = String(submittedCode ?? "").trim();
  const expectedHash = hashChallenge(code, {
    orderId: expectedBinding.orderId,
    customerId: expectedBinding.customerId,
    branchId: expectedBinding.branchId ?? stored.branchId,
    purpose: expectedBinding.purpose,
  });
  const a = Buffer.from(String(stored.challengeHash));
  const b = Buffer.from(expectedHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError("HANDOVER_CHALLENGE_INVALID", "Handover challenge code is incorrect.", 400);
  }
  return { valid: true };
}

/** Mark challenge consumed in memory; persist consumedAt in the same transaction as handover. */
export function markStaffHandoverChallengeConsumed(stored) {
  if (stored.consumedAt) {
    throw new AppError("HANDOVER_CHALLENGE_USED", "Handover challenge already used.", 409);
  }
  return {
    ...stored,
    consumedAt: new Date(),
    challengeHash: null,
    challengeSealed: null,
  };
}

/**
 * Staff must explicitly confirm physical handover (not merely issue a challenge).
 * Persist the returned fields in the same MongoDB transaction as fulfilment writes.
 */
export function consumeStaffHandoverChallengeWithStaffConfirmation(stored, {
  submittedCode,
  binding,
  staffUserId,
  staffHandoverConfirmed,
}) {
  if (!staffUserId) {
    throw new AppError("FORBIDDEN", "Authorized staff identity is required.", 403);
  }
  if (staffHandoverConfirmed !== true) {
    throw new AppError(
      "STAFF_HANDOVER_CONFIRMATION_REQUIRED",
      "Staff must confirm physical handover before completing this action.",
      400,
    );
  }
  verifyStaffHandoverChallenge(stored, submittedCode, binding);
  const consumed = markStaffHandoverChallengeConsumed(stored);
  return {
    ...consumed,
    handoverConfirmedByStaffUserId: staffUserId,
    staffHandoverConfirmedAt: new Date(),
  };
}

/** Mongo filter: only one concurrent consumer wins when paired with consume update. */
export function staffHandoverChallengeActiveFilter(binding) {
  return {
    "staffHandoverChallenge.orderId": String(binding.orderId),
    "staffHandoverChallenge.customerId": String(binding.customerId),
    "staffHandoverChallenge.purpose": binding.purpose,
    "staffHandoverChallenge.consumedAt": null,
    ...(binding.branchId ? { "staffHandoverChallenge.branchId": String(binding.branchId) } : {}),
  };
}

export function staffHandoverChallengeConsumeMongoUpdate(staffUserId) {
  return {
    $set: {
      "staffHandoverChallenge.consumedAt": new Date(),
      "staffHandoverChallenge.handoverConfirmedByStaffUserId": staffUserId,
      "staffHandoverChallenge.staffHandoverConfirmedAt": new Date(),
      "staffHandoverChallenge.challengeHash": null,
      "staffHandoverChallenge.challengeSealed": null,
    },
  };
}

/**
 * Serializes consume attempts (for tests and single-process coordinators).
 * Two concurrent calls: exactly one succeeds.
 */
export function createStaffHandoverChallengeConsumer(initialRecord) {
  let record = { ...initialRecord, consumedAt: initialRecord.consumedAt ?? null };
  let chain = Promise.resolve();
  return {
    get record() {
      return record;
    },
    consume(params) {
      const run = chain.then(() => {
        const next = consumeStaffHandoverChallengeWithStaffConfirmation(record, params);
        record = next;
        return next;
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}

/** Staff console reveal (requires authorized staff — not customer pickup display code). */
export function revealStaffHandoverChallengeForStaff(stored) {
  if (!stored?.challengeSealed || stored.consumedAt) {
    throw new AppError("HANDOVER_CHALLENGE_INVALID", "No active handover challenge.", 409);
  }
  if (stored.expiresAt && new Date(stored.expiresAt).getTime() < Date.now()) {
    throw new AppError("HANDOVER_CHALLENGE_EXPIRED", "Handover challenge expired.", 409);
  }
  return {
    challengeCode: unseal(stored.challengeSealed),
    expiresAt: stored.expiresAt,
    purpose: stored.purpose,
  };
}
