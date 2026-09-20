export { fetchFairDispatchCandidates, listDispatchTenantPage, dispatchRotationKey } from "./dispatch-tenant-fairness.js";

/**
 * Pick queued messages with tenant fairness and global cap.
 * @param {object[]} rows - sorted by dispatchPriority asc, createdAt asc
 * @param {{ perTenant: number, global: number }} limits
 */
export function selectFairMessageBatch(rows, limits) {
  const perTenant = Math.max(1, limits.perTenant);
  const globalCap = Math.max(1, limits.global);
  const picked = [];
  const tenantCounts = new Map();

  for (const row of rows) {
    if (picked.length >= globalCap) break;
    const tenantId = row.tenantId ?? "";
    const used = tenantCounts.get(tenantId) ?? 0;
    if (used >= perTenant) continue;
    picked.push(row);
    tenantCounts.set(tenantId, used + 1);
  }
  return picked;
}
