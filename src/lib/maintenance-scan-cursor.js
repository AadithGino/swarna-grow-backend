import { env } from "../config/env.js";
import { getRedis, redisReady } from "../config/redis.js";
import { randomToken } from "./crypto.js";
import { incrementOpsMetric, OpsMetric } from "./ops-metrics.js";

/** Versioned stream ids — do not reuse reminder cursor keys. */
export const MaintenanceScanStream = Object.freeze({
  DEFAULTING: "defaulting",
  FLEXIBLE_LOCK: "flexible_lock",
  PAYMENT_EXPIRY_INTENT: "payment_expiry_intent",
  PAYMENT_EXPIRY_LINK: "payment_expiry_link",
});

const KEY_PREFIX = "swarnagrow:maintenance:cursor:v1:";
const LEASE_KEY_PREFIX = "swarnagrow:maintenance:lease:v1:";

const RELEASE_LEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

const REFRESH_LEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`;

const WRITE_CURSOR_OWNER_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3])
  end
  return 0
`;

const CLEAR_CURSOR_OWNER_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[2])
  end
  return 0
`;

function cursorTtlSec() {
  return env.MAINTENANCE_CURSOR_TTL_SEC ?? 604_800;
}

function leaseMs() {
  return env.MAINTENANCE_SCAN_LEASE_MS ?? 120_000;
}

export function maintenanceScanCursorRedisKey(stream) {
  return `${KEY_PREFIX}${stream}`;
}

export function maintenanceScanLeaseRedisKey(stream) {
  return `${LEASE_KEY_PREFIX}${stream}`;
}

function isPlausibleId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]*_[0-9A-Z]{8,}$/i.test(value);
}

export function assertMaintenanceCursorRedis() {
  if (!redisReady()) {
    throw new Error("MAINTENANCE_CURSOR_REDIS_UNAVAILABLE");
  }
}

/** @returns {Promise<{ acquired: boolean, token: string|null }>} */
export async function acquireMaintenanceScanLease(stream) {
  assertMaintenanceCursorRedis();
  const key = maintenanceScanLeaseRedisKey(stream);
  const token = randomToken(16);
  const result = await getRedis().set(key, token, "PX", leaseMs(), "NX");
  return result === "OK" ? { acquired: true, token } : { acquired: false, token: null };
}

export async function refreshMaintenanceScanLease(stream, token) {
  if (!redisReady() || !token) return false;
  const result = await getRedis().eval(
    REFRESH_LEASE_SCRIPT,
    1,
    maintenanceScanLeaseRedisKey(stream),
    token,
    String(leaseMs()),
  );
  return result === 1;
}

export async function releaseMaintenanceScanLease(stream, token) {
  if (!redisReady() || !token) return false;
  const result = await getRedis().eval(
    RELEASE_LEASE_SCRIPT,
    1,
    maintenanceScanLeaseRedisKey(stream),
    token,
  );
  return result === 1;
}

async function writeMaintenanceScanCursorOwner(stream, lastId, token) {
  if (!lastId || !token) return false;
  const result = await getRedis().eval(
    WRITE_CURSOR_OWNER_SCRIPT,
    2,
    maintenanceScanLeaseRedisKey(stream),
    maintenanceScanCursorRedisKey(stream),
    token,
    String(lastId),
    String(cursorTtlSec()),
  );
  return result === 1 || result === "OK";
}

async function clearMaintenanceScanCursorOwner(stream, token) {
  if (!token) return false;
  const result = await getRedis().eval(
    CLEAR_CURSOR_OWNER_SCRIPT,
    2,
    maintenanceScanLeaseRedisKey(stream),
    maintenanceScanCursorRedisKey(stream),
    token,
  );
  return result === 1;
}

export async function readMaintenanceScanCursor(stream) {
  if (!redisReady()) {
    return { cursor: null, redisAvailable: false };
  }
  const raw = await getRedis().get(maintenanceScanCursorRedisKey(stream));
  if (!raw) return { cursor: null, redisAvailable: true };
  if (!isPlausibleId(raw)) {
    await clearMaintenanceScanCursor(stream);
    return { cursor: null, redisAvailable: true, recoveredInvalid: true };
  }
  return { cursor: raw, redisAvailable: true };
}

/** Unconditional cursor delete — test reset / operational rollback only. */
export async function clearMaintenanceScanCursor(stream) {
  if (!redisReady()) return;
  await getRedis().del(maintenanceScanCursorRedisKey(stream));
}

/** Unconditional lease delete — test reset / operational rollback only. */
export async function clearMaintenanceScanLease(stream) {
  if (!redisReady()) return;
  await getRedis().del(maintenanceScanLeaseRedisKey(stream));
}

async function readCursorForOwner(stream, token) {
  const raw = await getRedis().get(maintenanceScanCursorRedisKey(stream));
  if (!raw) return { cursor: null };
  if (!isPlausibleId(raw)) {
    await clearMaintenanceScanCursorOwner(stream, token);
    return { cursor: null, recoveredInvalid: true };
  }
  return { cursor: raw };
}

function emptyRotationStats(initialCursor = null) {
  return {
    processed: 0,
    scanned: 0,
    skipped: 0,
    conflicted: 0,
    failed: 0,
    expired: 0,
    deferred: 0,
    batchesRun: 0,
    hasMore: false,
    wrapped: false,
    continuationScheduled: 0,
    remainingBacklog: 0,
    cursorStart: initialCursor,
    cursorEnd: null,
    leaseBusy: false,
    ownershipLost: false,
  };
}

/**
 * Bounded keyset rotation with persisted cursor, at most one wrap per invocation.
 * @param {object} params
 * @param {string} params.stream
 * @param {number} params.maxBatches
 * @param {(cursor: string|null) => Promise<object>} params.runBatch
 */
export async function runRotatingMaintenanceScan({ stream, maxBatches, runBatch }) {
  assertMaintenanceCursorRedis();
  const lease = await acquireMaintenanceScanLease(stream);
  if (!lease.acquired) {
    incrementOpsMetric(OpsMetric.MAINTENANCE_SCAN_LEASE_BUSY);
    return { ...emptyRotationStats(null), leaseBusy: true };
  }

  const token = lease.token;
  const stats = emptyRotationStats(null);

  try {
    const initial = await readCursorForOwner(stream, token);
    stats.cursorStart = initial.cursor ?? null;
    let cursor = initial.cursor ?? null;
    let wrapped = false;

    for (let batchIdx = 0; batchIdx < maxBatches; batchIdx += 1) {
      if (!(await refreshMaintenanceScanLease(stream, token))) {
        stats.ownershipLost = true;
        incrementOpsMetric(OpsMetric.MAINTENANCE_SCAN_LEASE_LOST);
        break;
      }

      const batch = await runBatch(cursor);
      stats.batchesRun += 1;
      stats.processed += batch.processed ?? 0;
      stats.scanned += batch.scanned ?? 0;
      stats.skipped += batch.skipped ?? 0;
      stats.conflicted += batch.conflicted ?? 0;
      stats.failed += batch.failed ?? 0;
      stats.expired = (stats.expired ?? 0) + (batch.expired ?? 0);
      stats.deferred = (stats.deferred ?? 0) + (batch.deferred ?? 0);

      const scanned = batch.scanned ?? 0;
      const lastId = batch.lastCursor ?? batch.cursor ?? cursor;
      const hitLimit = Boolean(batch.hasMore);

      if (scanned === 0) {
        if (!(await clearMaintenanceScanCursorOwner(stream, token))) {
          stats.ownershipLost = true;
          incrementOpsMetric(OpsMetric.MAINTENANCE_SCAN_LEASE_LOST);
          break;
        }
        if (!wrapped) {
          wrapped = true;
          stats.wrapped = true;
          incrementOpsMetric(OpsMetric.MAINTENANCE_SCAN_WRAPPED);
          cursor = null;
          continue;
        }
        break;
      }

      cursor = lastId;
      stats.cursorEnd = cursor;

      if (hitLimit) {
        stats.hasMore = true;
        if (!(await writeMaintenanceScanCursorOwner(stream, cursor, token))) {
          stats.ownershipLost = true;
          incrementOpsMetric(OpsMetric.MAINTENANCE_SCAN_LEASE_LOST);
          break;
        }
        continue;
      }

      if (!(await clearMaintenanceScanCursorOwner(stream, token))) {
        stats.ownershipLost = true;
        incrementOpsMetric(OpsMetric.MAINTENANCE_SCAN_LEASE_LOST);
        break;
      }
      if (!wrapped) {
        wrapped = true;
        stats.wrapped = true;
        incrementOpsMetric(OpsMetric.MAINTENANCE_SCAN_WRAPPED);
        cursor = null;
        continue;
      }
      break;
    }

    if (stats.hasMore && cursor && !stats.ownershipLost) {
      if (await writeMaintenanceScanCursorOwner(stream, cursor, token)) {
        stats.continuationScheduled = 1;
        stats.remainingBacklog = 1;
        incrementOpsMetric(OpsMetric.MAINTENANCE_SCAN_CONTINUATION);
      } else {
        stats.ownershipLost = true;
        incrementOpsMetric(OpsMetric.MAINTENANCE_SCAN_LEASE_LOST);
      }
    }
  } finally {
    await releaseMaintenanceScanLease(stream, token);
  }

  return stats;
}
