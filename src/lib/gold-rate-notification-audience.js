import { goldRateForExactDate } from "./gold-rate-lookup.js";
import {
  countPushAudience,
  fetchAudienceCustomerPage,
} from "../services/push-broadcast.service.js";

async function collectEligibleCustomerIds(tenantId, broadcastDraft) {
  const ids = [];
  let cursor = null;
  for (;;) {
    const page = await fetchAudienceCustomerPage({
      tenantId,
      broadcast: broadcastDraft,
      cursorCustomerId: cursor,
      limit: 400,
    });
    if (!page.length) break;
    for (const row of page) ids.push(String(row._id));
    cursor = page[page.length - 1]._id;
    if (page.length < 400) break;
  }
  return ids;
}

export async function resolveSchemeGoldRateAudienceCustomerIds({
  tenantId,
  rateId,
  effectiveDateYmd,
  rateBranchId,
}) {
  const broadcastDraft = rateBranchId
    ? { audience: "BRANCH", branchId: rateBranchId, customerIds: [] }
    : { audience: "ALL_DEVICES", branchId: null, customerIds: [] };
  const candidates = await collectEligibleCustomerIds(tenantId, broadcastDraft);
  const matched = [];
  for (const customerId of candidates) {
    const customer = await import("../models/index.js").then((m) =>
      m.Customer.findById(customerId).select("branchId").lean(),
    );
    if (!customer) continue;
    const scope = { tenantId, branchId: customer.branchId ?? null };
    const resolved = await goldRateForExactDate(scope, effectiveDateYmd);
    if (resolved?._id === rateId) matched.push(customerId);
  }
  return [...new Set(matched)];
}

export async function resolveEcommerceGoldRateAudienceCustomerIds(req) {
  const draft = { audience: "ALL_DEVICES", branchId: null, customerIds: [] };
  return collectEligibleCustomerIds(req.auth.tenantId, draft);
}

export async function resolveEcommerceGoldRateAudienceCount(req) {
  const preview = await countPushAudience(req, { audience: "ALL_DEVICES" });
  return preview.eligibleDevices ?? 0;
}
