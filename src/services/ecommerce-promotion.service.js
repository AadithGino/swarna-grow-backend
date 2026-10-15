import {
  EcommercePromotionCampaignStatus,
  EcommercePromotionKind,
  MessageType,
} from "../constants/enums.js";
import { Permission } from "../constants/permissions.js";
import { AppError } from "../lib/app-error.js";
import { errors } from "../lib/app-error.js";
import { isEcommerceOperational } from "../lib/ecommerce-access.js";
import {
  computeProductPriceEstimate,
} from "../lib/ecommerce-pricing.js";
import {
  categoryShopDeepLink,
  hasNotifiableOffer,
  hasOfferBenefit,
  offerRevisionDigest,
  offerRevisionKey,
  productShopDeepLink,
  resolveCampaignCopy,
  resolvePromotionSchedule,
  suggestCategoryPromotionCopy,
  suggestOfferPromotionCopy,
  suggestProductPromotionCopy,
  trimPromotionCopy,
} from "../lib/ecommerce-promotion-copy.js";
import { createId } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import { effectiveScope } from "../lib/query-filters.js";
import { logger } from "../config/logger.js";
import {
  EcommerceCategory,
  EcommerceGoldRate,
  EcommerceProduct,
  EcommercePromotionCampaign,
} from "../models/index.js";
import { countPushAudience } from "./push-broadcast.service.js";
import { loadTaxSettings } from "./ecommerce.service.js";

export {
  categoryShopDeepLink,
  hasNotifiableOffer,
  offerRevisionDigest,
  offerRevisionKey,
  productShopDeepLink,
  suggestCategoryPromotionCopy,
  suggestOfferPromotionCopy,
  suggestProductPromotionCopy,
};

export {
  deliverPromotionCampaign,
  enqueuePromotionCampaignDelivery,
  runEcommercePromotionMaintenance,
  reconcilePromotionCampaignByBroadcast,
  reconcilePromotionCampaignDispatch,
} from "./ecommerce-promotion-delivery.service.js";

async function latestRateForPurity(tenantId, purity, at = new Date()) {
  if (!purity) return null;
  return EcommerceGoldRate.findOne({
    tenantId,
    purity,
    effectiveAt: { $lte: at },
  })
    .sort({ effectiveAt: -1, createdAt: -1 })
    .lean();
}

async function pricingContext(tenantId, product) {
  const taxSettings = await loadTaxSettings(tenantId);
  const rateRow =
    product.priceMode === "GOLD_RATE_BASED"
      ? await latestRateForPurity(tenantId, product.purity)
      : null;
  return { taxSettings, rateRow };
}

function trimCopy(title, body) {
  return trimPromotionCopy(title, body);
}

export function assertPromotionNotificationAuthorized(req, notification) {
  if (!notification?.enabled) return;
  const permissions = req.auth?.permissions ?? [];
  if (permissions.includes("*")) return;
  if (!permissions.includes(Permission.MESSAGE_SEND)) {
    throw errors.forbidden("Sending notifications requires message.send permission.");
  }
}

async function assertPromoTargetOperational(req) {
  if (!isEcommerceOperational(req.tenant)) {
    throw errors.forbidden("Online store is not active.");
  }
}

async function loadPublishedProduct(req, productId) {
  const row = await EcommerceProduct.findOne({
    _id: productId,
    tenantId: req.auth.tenantId,
    status: "PUBLISHED",
  }).lean();
  if (!row) throw errors.notFound("Product");
  if (row.categoryId) {
    const cat = await EcommerceCategory.findOne({
      _id: row.categoryId,
      tenantId: req.auth.tenantId,
      active: true,
    }).lean();
    if (!cat) {
      throw new AppError("CATEGORY_INACTIVE", "Product category is not active.", 422);
    }
  }
  return row;
}

async function loadActiveCategory(req, categoryId) {
  const row = await EcommerceCategory.findOne({
    _id: categoryId,
    tenantId: req.auth.tenantId,
    active: true,
  }).lean();
  if (!row) throw errors.notFound("Category");
  return row;
}

function mapCampaignDto(row) {
  return {
    id: row._id,
    businessKey: row.businessKey,
    kind: row.kind,
    status: row.status,
    productId: row.productId ?? null,
    categoryId: row.categoryId ?? null,
    broadcastId: row.broadcastId ?? null,
    title: row.title,
    body: row.body,
    deepLink: row.deepLink,
    audience: row.audience,
    branchId: row.branchId ?? null,
    customerIds: row.customerIds ?? [],
    imageUploadId: row.imageUploadId ?? null,
    scheduledFor: row.scheduledFor ?? null,
    offerRevision: row.offerRevision ?? null,
    stats: row.stats ?? {},
    skippedReason: row.skippedReason ?? null,
    rateId: row.rateId ?? null,
    rateSource: row.rateSource ?? null,
    purity: row.purity ?? null,
    ratePerGramPaise: row.ratePerGramPaise ?? null,
    schemeEffectiveDate: row.schemeEffectiveDate ?? null,
    ecommerceEffectiveAt: row.ecommerceEffectiveAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const TERMINAL_CAMPAIGN = new Set([
  EcommercePromotionCampaignStatus.SENT,
  EcommercePromotionCampaignStatus.FAILED,
  EcommercePromotionCampaignStatus.CANCELLED,
]);

export async function persistCampaignIntent(session, req, params) {
  const {
    kind,
    businessKey,
    product,
    category,
    title,
    body,
    audience = "ALL_DEVICES",
    branchId = null,
    customerIds = [],
    imageUploadId = null,
    scheduledFor = null,
    offerRevision = null,
  } = params;

  const titleOverridden = Boolean(title?.trim());
  const bodyOverridden = Boolean(body?.trim());
  const copyAtMs = scheduledFor ? new Date(scheduledFor).getTime() : Date.now();

  const tenantId = req.auth.tenantId;
  let existingQuery = EcommercePromotionCampaign.findOne({ tenantId, businessKey });
  if (session) existingQuery = existingQuery.session(session);
  const existing = await existingQuery.lean();
  if (existing && [EcommercePromotionCampaignStatus.SENDING, EcommercePromotionCampaignStatus.SENT].includes(existing.status)) {
    return { duplicate: true, campaign: mapCampaignDto(existing) };
  }
  if (existing && !TERMINAL_CAMPAIGN.has(existing.status) && existing.broadcastId) {
    return { duplicate: true, campaign: mapCampaignDto(existing) };
  }

  const deepLink = product
    ? productShopDeepLink(product.slug)
    : categoryShopDeepLink(category._id);
  const copy = await resolveCampaignCopy({
    kind,
    product,
    category,
    title: titleOverridden ? title : null,
    body: bodyOverridden ? body : null,
    tenantId: req.auth.tenantId,
    atMs: copyAtMs,
  });

  const payload = {
    kind,
    status: EcommercePromotionCampaignStatus.QUEUED,
    productId: product?._id,
    categoryId: category?._id,
    broadcastId: null,
    title: copy.title,
    body: copy.body,
    deepLink,
    audience,
    branchId,
    customerIds,
    imageUploadId,
    scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
    offerRevision,
    titleOverridden,
    bodyOverridden,
    requestedBy: req.auth.id,
    scopeBranchId: req.scope?.branchId ?? null,
    skippedReason: null,
    stats: { eligibleCustomers: 0, messagesQueued: 0, delivered: 0, failed: 0, pending: 0 },
    deliveryLeaseOwner: null,
    deliveryLeaseExpiresAt: null,
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
  await EcommercePromotionCampaign.create([{ _id: id, tenantId, businessKey, ...payload }], createOpts);
  return { campaign: mapCampaignDto({ _id: id, tenantId, businessKey, ...payload }), campaignId: id };
}

export async function tryEnqueuePromotionAfterCommit(campaignId, tenantId) {
  if (!campaignId) return { intentPersisted: false, enqueueAttempted: false };
  try {
    const row = await EcommercePromotionCampaign.findOne({ _id: campaignId, tenantId }).lean();
    if (!row || row.status !== EcommercePromotionCampaignStatus.QUEUED) {
      return {
        intentPersisted: true,
        enqueueAttempted: false,
        campaign: row ? mapCampaignDto(row) : null,
      };
    }
    if (row.scheduledFor && new Date(row.scheduledFor).getTime() > Date.now()) {
      return { intentPersisted: true, enqueueAttempted: false, scheduled: true, campaign: mapCampaignDto(row) };
    }
    const { enqueuePromotionCampaignDelivery } = await import("./ecommerce-promotion-delivery.service.js");
    const enq = await enqueuePromotionCampaignDelivery(campaignId, tenantId, {
      attempt: row.deliveryAttemptCount ?? 0,
    });
    return {
      intentPersisted: true,
      enqueueAttempted: true,
      enqueued: enq.scheduled === true || enq.enqueued === true,
      enqueuePending: enq.alreadyPending === true,
      enqueueError: enq.scheduled || enq.enqueued || enq.alreadyPending
        ? null
        : enq.reason ?? null,
      campaign: mapCampaignDto(row),
    };
  } catch (error) {
    logger.error({ err: error, campaignId, tenantId }, "Promotion enqueue failed after commit");
    return {
      intentPersisted: true,
      enqueueAttempted: true,
      enqueued: false,
      enqueueError: error?.code ?? error?.message ?? "ENQUEUE_FAILED",
    };
  }
}

async function previewInternal(req, { product, category, title, body }) {
  await assertPromoTargetOperational(req);
  const audience = audienceFromBody(req.body, req.scope);
  const audiencePreview = await countPushAudience(req, audience);
  return {
    title,
    body,
    deepLink: product ? productShopDeepLink(product.slug) : categoryShopDeepLink(category._id),
    imageUploadId: product?.imageUploadIds?.[0] ?? category?.imageUploadId ?? null,
    audience: audience.audience,
    branchId: audience.branchId,
    customerIds: audience.customerIds,
    eligibleCustomers: audiencePreview.eligibleDevices,
    subscriptionCap: audiencePreview.subscriptionCap,
    disclaimer:
      "Eligible customers have a registered app device; delivery is not guaranteed.",
  };
}

function audienceFromBody(body, scope) {
  const audience = body.audience ?? "ALL_DEVICES";
  if (!["ALL_DEVICES", "BRANCH", "CUSTOMERS"].includes(audience)) {
    throw new AppError("INVALID_AUDIENCE", "Unsupported audience.", 422);
  }
  const branchId = audience === "BRANCH" ? (body.branchId ?? scope?.branchId ?? null) : null;
  const customerIds = [...new Set((body.customerIds ?? []).map(String).filter(Boolean))];
  if (audience === "BRANCH" && !branchId) {
    throw new AppError("BRANCH_REQUIRED", "Choose a branch for branch-scoped push.", 422);
  }
  if (audience === "CUSTOMERS" && !customerIds.length) {
    throw new AppError("INVALID_AUDIENCE", "Select at least one customer.", 422);
  }
  return { audience, branchId, customerIds };
}

export async function previewProductPromotion(req) {
  const product = await loadPublishedProduct(req, req.params.productId);
  const { taxSettings, rateRow } = await pricingContext(req.auth.tenantId, product);
  const estimate = computeProductPriceEstimate({ product, rateRow, taxSettings });
  const suggested = suggestProductPromotionCopy(product, estimate);
  const title = req.body.title?.trim() || suggested.title;
  const body = req.body.body?.trim() || suggested.body;
  trimCopy(title, body);
  return previewInternal(req, { product, title, body });
}

export async function previewCategoryPromotion(req) {
  const category = await loadActiveCategory(req, req.params.categoryId);
  const suggested = suggestCategoryPromotionCopy(category);
  const title = req.body.title?.trim() || suggested.title;
  const body = req.body.body?.trim() || suggested.body;
  trimCopy(title, body);
  return previewInternal(req, { category, title, body });
}

async function queueCampaign(req, params) {
  const persisted = await persistCampaignIntent(null, req, params);
  if (persisted.duplicate) {
    return { campaign: persisted.campaign, duplicate: true };
  }
  const campaignId = persisted.campaignId ?? persisted.campaign?.id;
  const scheduled = params.scheduledFor && new Date(params.scheduledFor).getTime() > Date.now();
  if (scheduled) {
    return { campaign: persisted.campaign, scheduled: true, intentPersisted: true };
  }
  const enq = await tryEnqueuePromotionAfterCommit(campaignId, req.auth.tenantId);
  return {
    campaign: enq.campaign ?? persisted.campaign,
    intentPersisted: true,
    enqueued: enq.enqueued === true,
    enqueueError: enq.enqueueError ?? null,
    queued: enq.enqueued === true,
  };
}

export async function sendProductPromotion(req) {
  const product = await loadPublishedProduct(req, req.params.productId);
  const { taxSettings, rateRow } = await pricingContext(req.auth.tenantId, product);
  const estimate = computeProductPriceEstimate({ product, rateRow, taxSettings });
  const suggested = suggestProductPromotionCopy(product, estimate);
  const { title, body } = trimCopy(
    req.body.title?.trim() || suggested.title,
    req.body.body?.trim() || suggested.body,
  );
  const audience = audienceFromBody(req.body, req.scope);
  const idempotencyKey = req.headers["x-idempotency-key"] ?? req.idempotencyKey;
  const businessKey = idempotencyKey
    ? `manual-product:${req.params.productId}:${idempotencyKey}`
    : `manual-product:${req.params.productId}:${createId("tmp")}`;
  return queueCampaign(req, {
    kind: EcommercePromotionKind.MANUAL_PRODUCT,
    businessKey,
    messageType: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    product,
    title,
    body,
    ...audience,
    imageUploadId: product.imageUploadIds?.[0] ?? null,
  });
}

export async function sendCategoryPromotion(req) {
  const category = await loadActiveCategory(req, req.params.categoryId);
  const suggested = suggestCategoryPromotionCopy(category);
  const { title, body } = trimCopy(
    req.body.title?.trim() || suggested.title,
    req.body.body?.trim() || suggested.body,
  );
  const audience = audienceFromBody(req.body, req.scope);
  const idempotencyKey = req.headers["x-idempotency-key"] ?? req.idempotencyKey;
  const businessKey = idempotencyKey
    ? `manual-category:${req.params.categoryId}:${idempotencyKey}`
    : `manual-category:${req.params.categoryId}:${createId("tmp")}`;
  return queueCampaign(req, {
    kind: EcommercePromotionKind.MANUAL_CATEGORY,
    businessKey,
    messageType: MessageType.ECOMMERCE_CATEGORY_PROMOTION,
    category,
    title,
    body,
    ...audience,
    imageUploadId: category.imageUploadId ?? null,
  });
}

export async function listPromotionCampaigns(req) {
  const scope = effectiveScope(req);
  const filters = {};
  if (req.query.productId) filters.productId = String(req.query.productId);
  if (req.query.categoryId) filters.categoryId = String(req.query.categoryId);
  const result = await paginate(EcommercePromotionCampaign, {
    scope: { tenantId: scope.tenantId, ...filters },
    filters: {},
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: "createdAt:desc",
  });
  return { items: result.data.map(mapCampaignDto), meta: result.meta };
}

export async function getPromotionCampaign(req) {
  const row = await EcommercePromotionCampaign.findOne({
    _id: req.params.campaignId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!row) throw errors.notFound("Campaign");
  return mapCampaignDto(row);
}

export async function buildNewArrivalIntent(req, product, notification) {
  if (!notification?.enabled) return null;
  const businessKey = `new-arrival:${product._id}`;
  return {
    kind: EcommercePromotionKind.NEW_ARRIVAL,
    businessKey,
    product,
    title: notification.title,
    body: notification.body,
    audience: notification.audience ?? "ALL_DEVICES",
    branchId: notification.branchId ?? null,
    customerIds: notification.customerIds ?? [],
    imageUploadId: product.imageUploadIds?.[0] ?? null,
  };
}

export async function buildOfferIntent(req, { before, after, notification }) {
  if (!notification?.enabled || notification?.kind !== "OFFER") return null;
  if (before && offerRevisionDigest(before) === offerRevisionDigest(after)) {
    return { skip: true, reason: "OFFER_UNCHANGED" };
  }
  const atMs = Date.now();
  const scheduledFor = resolvePromotionSchedule(after, atMs);
  const benefitAtMs = scheduledFor ? new Date(scheduledFor).getTime() : atMs;
  if (!hasNotifiableOffer(after, benefitAtMs)) {
    return { skip: true, reason: "OFFER_INACTIVE" };
  }
  const { taxSettings, rateRow } = await pricingContext(req.auth.tenantId, after);
  const estimate = computeProductPriceEstimate({ product: after, rateRow, taxSettings, atMs: benefitAtMs });
  if (!hasOfferBenefit(after, estimate, benefitAtMs)) {
    return { skip: true, reason: "OFFER_NO_BENEFIT" };
  }
  const revision = offerRevisionDigest(after);
  const businessKey = `offer:${after._id}:${revision}`;
  return {
    kind: EcommercePromotionKind.OFFER,
    businessKey,
    product: after,
    title: notification.title,
    body: notification.body,
    audience: notification.audience ?? "ALL_DEVICES",
    branchId: notification.branchId ?? null,
    customerIds: notification.customerIds ?? [],
    imageUploadId: after.imageUploadIds?.[0] ?? null,
    scheduledFor,
    offerRevision: revision,
  };
}

function mergePromotionResult(base, enq) {
  if (!enq) return base;
  return {
    ...base,
    intentPersisted: enq.intentPersisted ?? base.intentPersisted,
    enqueued: enq.enqueued ?? false,
    enqueueAttempted: enq.enqueueAttempted ?? false,
    enqueueError: enq.enqueueError ?? null,
    scheduled: enq.scheduled ?? base.scheduled,
    campaign: enq.campaign ?? base.campaign,
    queued: enq.enqueued === true,
  };
}

export { mergePromotionResult };
export { tryEnqueuePromotionAfterCommit as finalizePromotionAfterCommit };
