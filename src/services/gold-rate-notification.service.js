import {
  EcommercePromotionCampaignStatus,
  EcommercePromotionKind,
  GoldRateNotificationSource,
  MessageType,
} from "../constants/enums.js";
import { createId } from "../lib/ids.js";
import {
  ECOMMERCE_GOLD_RATE_DEEP_LINK,
  SCHEME_GOLD_RATE_DEEP_LINK,
  suggestEcommerceGoldRateNotificationCopy,
  suggestSchemeGoldRateNotificationCopy,
} from "../lib/gold-rate-notification-copy.js";
import {
  ecommerceNotificationScheduledFor,
  isHistoricalEcommerceEffectiveAt,
  isHistoricalSchemeEffectiveDate,
  schemeNotificationScheduledFor,
} from "../lib/gold-rate-notification-schedule.js";
import { trimPromotionCopy } from "../lib/ecommerce-promotion-copy.js";
import { EcommercePromotionCampaign } from "../models/index.js";
import {
  assertPromotionNotificationAuthorized,
  mergePromotionResult,
  tryEnqueuePromotionAfterCommit,
} from "./ecommerce-promotion.service.js";

const TERMINAL_CAMPAIGN = new Set([
  EcommercePromotionCampaignStatus.SENT,
  EcommercePromotionCampaignStatus.FAILED,
  EcommercePromotionCampaignStatus.CANCELLED,
]);

function mapCampaignDto(row) {
  return {
    id: row._id,
    businessKey: row.businessKey,
    kind: row.kind,
    status: row.status,
    rateId: row.rateId ?? null,
    rateSource: row.rateSource ?? null,
    purity: row.purity ?? null,
    ratePerGramPaise: row.ratePerGramPaise ?? null,
    schemeEffectiveDate: row.schemeEffectiveDate ?? null,
    ecommerceEffectiveAt: row.ecommerceEffectiveAt ?? null,
    broadcastId: row.broadcastId ?? null,
    title: row.title,
    body: row.body,
    deepLink: row.deepLink,
    audience: row.audience,
    branchId: row.branchId ?? null,
    customerIds: row.customerIds ?? [],
    scheduledFor: row.scheduledFor ?? null,
    stats: row.stats ?? {},
    skippedReason: row.skippedReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function persistRateNotificationIntent(session, req, intent) {
  const tenantId = req.auth.tenantId;
  const { businessKey } = intent;
  let existingQuery = EcommercePromotionCampaign.findOne({ tenantId, businessKey });
  if (session) existingQuery = existingQuery.session(session);
  const existing = await existingQuery.lean();
  if (existing && [EcommercePromotionCampaignStatus.SENDING, EcommercePromotionCampaignStatus.SENT].includes(existing.status)) {
    return { duplicate: true, campaign: mapCampaignDto(existing), campaignId: existing._id };
  }
  if (existing && !TERMINAL_CAMPAIGN.has(existing.status) && existing.broadcastId) {
    return { duplicate: true, campaign: mapCampaignDto(existing), campaignId: existing._id };
  }

  const payload = {
    kind: intent.kind,
    status: EcommercePromotionCampaignStatus.QUEUED,
    rateId: intent.rateId,
    rateSource: intent.rateSource,
    purity: intent.purity ?? null,
    ratePerGramPaise: intent.ratePerGramPaise,
    schemeEffectiveDate: intent.schemeEffectiveDate ?? null,
    ecommerceEffectiveAt: intent.ecommerceEffectiveAt ?? null,
    broadcastId: null,
    title: intent.title,
    body: intent.body,
    deepLink: intent.deepLink,
    audience: intent.audience,
    branchId: intent.branchId ?? null,
    customerIds: intent.customerIds ?? [],
    scheduledFor: intent.scheduledFor ?? null,
    requestedBy: req.auth.id,
    scopeBranchId: req.scope?.branchId ?? intent.scopeBranchId ?? intent.branchId ?? null,
    skippedReason: null,
    stats: { eligibleCustomers: 0, messagesQueued: 0, delivered: 0, failed: 0, pending: 0 },
    deliveryLeaseOwner: null,
    deliveryLeaseExpiresAt: null,
    titleOverridden: false,
    bodyOverridden: false,
  };

  if (existing) {
    const updateOpts = session ? { session } : {};
    await EcommercePromotionCampaign.updateOne(
      { _id: existing._id, tenantId },
      { $set: payload, $inc: { version: 1 } },
      updateOpts,
    );
    let refreshedQuery = EcommercePromotionCampaign.findById(existing._id);
    if (session) refreshedQuery = refreshedQuery.session(session);
    const refreshed = await refreshedQuery.lean();
    return { campaign: mapCampaignDto(refreshed), campaignId: existing._id };
  }

  const id = createId("epcm");
  const createOpts = session ? { session } : {};
  await EcommercePromotionCampaign.create(
    [{ _id: id, tenantId, businessKey, ...payload }],
    createOpts,
  );
  return { campaign: mapCampaignDto({ _id: id, tenantId, businessKey, ...payload }), campaignId: id };
}

export function buildSchemeGoldRateNotificationIntent(req, rateRow) {
  const effectiveDateYmd = String(rateRow.effectiveDate).slice(0, 10);
  if (isHistoricalSchemeEffectiveDate(effectiveDateYmd)) {
    return { skip: true, reason: "HISTORICAL_BACKFILL" };
  }
  const scheduledFor = schemeNotificationScheduledFor(effectiveDateYmd);
  const suggested = suggestSchemeGoldRateNotificationCopy({
    ratePerGramPaise: rateRow.ratePerGramPaise,
    effectiveDateYmd,
  });
  const { title, body } = trimPromotionCopy(suggested.title, suggested.body);
  return {
    kind: EcommercePromotionKind.SCHEME_GOLD_RATE,
    businessKey: `scheme-gold-rate:${rateRow._id}`,
    rateId: rateRow._id,
    rateSource: GoldRateNotificationSource.SCHEME,
    purity: rateRow.purity ?? "22K",
    ratePerGramPaise: rateRow.ratePerGramPaise,
    schemeEffectiveDate: effectiveDateYmd,
    title,
    body,
    deepLink: SCHEME_GOLD_RATE_DEEP_LINK,
    audience: rateRow.branchId ? "BRANCH" : "ALL_DEVICES",
    branchId: rateRow.branchId ?? null,
    scopeBranchId: req.scope?.branchId ?? rateRow.branchId ?? null,
    customerIds: [],
    scheduledFor,
    messageType: MessageType.SCHEME_GOLD_RATE_UPDATED,
  };
}

export function buildEcommerceGoldRateNotificationIntent(req, rateRow, { effectiveTiming = "SCHEDULED" } = {}) {
  const effectiveAt = rateRow.effectiveAt instanceof Date
    ? rateRow.effectiveAt
    : new Date(rateRow.effectiveAt);
  if (effectiveTiming !== "NOW" && isHistoricalEcommerceEffectiveAt(effectiveAt)) {
    return { skip: true, reason: "HISTORICAL_BACKFILL" };
  }
  const scheduledFor = ecommerceNotificationScheduledFor(effectiveAt);
  const suggested = suggestEcommerceGoldRateNotificationCopy({
    purity: rateRow.purity,
    ratePerGramPaise: rateRow.ratePerGramPaise,
    effectiveAt: effectiveAt.toISOString(),
  });
  const { title, body } = trimPromotionCopy(suggested.title, suggested.body);
  return {
    kind: EcommercePromotionKind.ECOMMERCE_GOLD_RATE,
    businessKey: `ecommerce-gold-rate:${rateRow._id}`,
    rateId: rateRow._id,
    rateSource: GoldRateNotificationSource.ECOMMERCE,
    purity: rateRow.purity,
    ratePerGramPaise: rateRow.ratePerGramPaise,
    ecommerceEffectiveAt: effectiveAt,
    title,
    body,
    deepLink: ECOMMERCE_GOLD_RATE_DEEP_LINK,
    audience: "ALL_DEVICES",
    branchId: null,
    customerIds: [],
    scheduledFor,
    messageType: MessageType.ECOMMERCE_GOLD_RATE_UPDATED,
  };
}

export async function finalizeRateNotificationAfterCommit(campaignId, tenantId) {
  return tryEnqueuePromotionAfterCommit(campaignId, tenantId);
}

export async function listSchemeGoldRateNotificationCampaigns(req) {
  const { paginate } = await import("../lib/pagination.js");
  const { EcommercePromotionKind } = await import("../constants/enums.js");
  const filter = { kind: EcommercePromotionKind.SCHEME_GOLD_RATE };
  if (req.scope?.branchId) {
    filter.$or = [{ branchId: req.scope.branchId }, { scopeBranchId: req.scope.branchId }];
  }
  const result = await paginate(EcommercePromotionCampaign, {
    scope: { tenantId: req.auth.tenantId },
    filters: filter,
    sort: "createdAt:desc",
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  return {
    items: result.data.map(mapCampaignDto),
    meta: result.meta,
  };
}

export {
  assertPromotionNotificationAuthorized,
  mergePromotionResult,
};
