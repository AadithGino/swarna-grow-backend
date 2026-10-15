import { goldRateForExactDate } from "./gold-rate-lookup.js";

/** Cache branchId (null = tenant default key) → applicable rate id for one business date. */
export function createSchemeRateApplicabilityCache() {
  const byBranchKey = new Map();
  return {
    async applicableRateId(tenantId, branchId, effectiveDateYmd) {
      const key = branchId ?? "__tenant__";
      if (byBranchKey.has(key)) return byBranchKey.get(key);
      const row = await goldRateForExactDate(
        { tenantId, branchId: branchId ?? null },
        effectiveDateYmd,
      );
      const id = row?._id ?? null;
      byBranchKey.set(key, id);
      return id;
    },
  };
}

export async function filterCustomersForSchemeRatePage({
  tenantId,
  customers,
  targetRateId,
  effectiveDateYmd,
  cache,
}) {
  const matched = [];
  for (const customer of customers) {
    const applicable = await cache.applicableRateId(
      tenantId,
      customer.branchId ?? null,
      effectiveDateYmd,
    );
    if (applicable === targetRateId) matched.push(customer);
  }
  return matched;
}

/** Scan paginated audience until one match or audience exhausted. */
export async function schemeRateHasAnyRecipient({
  tenantId,
  broadcast: _broadcast,
  targetRateId,
  effectiveDateYmd,
  fetchPage,
}) {
  const cache = createSchemeRateApplicabilityCache();
  let cursor = null;
  for (;;) {
    const page = await fetchPage({ cursorCustomerId: cursor, limit: 400 });
    if (!page.length) return false;
    const matched = await filterCustomersForSchemeRatePage({
      tenantId,
      customers: page,
      targetRateId,
      effectiveDateYmd,
      cache,
    });
    if (matched.length) return true;
    cursor = page[page.length - 1]._id;
    if (page.length < 400) return false;
  }
}
