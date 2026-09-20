import { env } from "../config/env.js";
import { getRedis, redisReady } from "../config/redis.js";

function tenantPageSize() {
  return env.MESSAGE_DISPATCH_TENANT_PAGE_SIZE ?? 32;
}

function tenantQueryConcurrency() {
  return env.MESSAGE_DISPATCH_TENANT_QUERY_CONCURRENCY ?? 4;
}

export function dispatchRotationKey(model) {
  return `swarnagrow:dispatch:tenant-rotation:${model.collection.collectionName}`;
}

/** Bounded page of tenant IDs with eligible dispatch rows (sorted). */
export async function listDispatchTenantPage(model, baseFilter, { afterTenantId = null, limit } = {}) {
  const pageLimit = limit ?? tenantPageSize();
  const pipeline = [
    { $match: baseFilter },
    { $group: { _id: "$tenantId" } },
    ...(afterTenantId ? [{ $match: { _id: { $gt: afterTenantId } } }] : []),
    { $sort: { _id: 1 } },
    { $limit: pageLimit },
  ];
  const rows = await model.aggregate(pipeline);
  return rows.map((row) => row._id).filter(Boolean);
}

async function readRotationCursor(key) {
  if (!redisReady()) return null;
  const value = await getRedis().get(key);
  return value || null;
}

async function writeRotationCursor(key, tenantId) {
  if (!redisReady() || !tenantId) return;
  await getRedis().set(key, tenantId, "EX", 86_400);
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Fair dispatch selection with bounded tenant page, rotation cursor, and limited DB concurrency.
 */
export async function fetchFairDispatchCandidates(model, baseFilter, opts) {
  const perTenant = Math.max(1, opts.perTenant);
  const globalCap = Math.max(1, opts.global);
  const rotationKey = opts.rotationKey ?? dispatchRotationKey(model);
  let afterTenantId = await readRotationCursor(rotationKey);

  let tenantIds = await listDispatchTenantPage(model, baseFilter, { afterTenantId });
  let wrapped = false;
  if (!tenantIds.length && afterTenantId) {
    wrapped = true;
    afterTenantId = null;
    tenantIds = await listDispatchTenantPage(model, baseFilter, { afterTenantId: null });
  }

  const pairs = await mapWithConcurrency(
    tenantIds,
    tenantQueryConcurrency(),
    async (tenantId) => {
      const rows = await model
        .find({ ...baseFilter, tenantId })
        .sort(opts.sort)
        .limit(perTenant)
        .select(opts.select)
        .lean();
      return [tenantId, rows];
    },
  );
  const byTenant = new Map(pairs);

  const picked = [];
  for (let round = 0; round < perTenant && picked.length < globalCap; round += 1) {
    for (const tenantId of tenantIds) {
      if (picked.length >= globalCap) break;
      const rows = byTenant.get(tenantId);
      if (rows?.[round]) picked.push(rows[round]);
    }
  }

  if (tenantIds.length) {
    await writeRotationCursor(rotationKey, tenantIds[tenantIds.length - 1]);
  } else if (wrapped) {
    await writeRotationCursor(rotationKey, "");
  }

  return {
    batch: picked.slice(0, globalCap),
    tenantIds,
    wrapped,
    afterTenantId,
  };
}
