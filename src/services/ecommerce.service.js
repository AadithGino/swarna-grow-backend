import {
  AuditEntityType,
  EcommerceProductStatus,
  EcommercePriceMode,
  UploadPurpose,
} from "../constants/enums.js";
import {
  EcommerceCategory,
  EcommerceFulfilmentSettings,
  EcommerceGoldRate,
  EcommerceProduct,
  EcommerceTaxSettings,
} from "../models/index.js";
import { mapPublishedStorePolicies } from "../lib/ecommerce-store-policies.js";
import {
  assertEcommerceCatalogWrite,
  assertEcommerceOperational,
  isEcommerceCatalogWriteAllowed,
  presentEcommerceAccessStateForTenant,
} from "../lib/ecommerce-access.js";
import { customerHasEcommerceOrderHistory } from "../lib/ecommerce-tenant-history.js";
import { computeProductPriceEstimate } from "../lib/ecommerce-pricing.js";
import {
  loadInventoryAvailability,
  mapPublicAvailability,
} from "../lib/ecommerce-inventory.js";
import { normalizeEcommerceSlug } from "../lib/ecommerce-slug.js";
import {
  buildMergedProductForPatch,
  PRICING_PATCH_KEYS,
  pricingFieldsFromPatchAssign,
  validateProductScheduleWindows,
} from "../lib/ecommerce-product-patch.js";
import { createId } from "../lib/ids.js";
import { moneyRef } from "../lib/money.js";
import { paginate } from "../lib/pagination.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { writeAudit } from "./audit.service.js";
import { uploadViewPath, validateUploadReferences } from "./upload.service.js";

function enforceVersion(doc, expectedVersion) {
  if (expectedVersion == null) return;
  if (Number(doc.version) !== Number(expectedVersion)) {
    throw errors.conflict("VERSION_CONFLICT", "Record was updated elsewhere. Refresh and retry.", {
      current: {
        version: doc.version,
        updatedAt: doc.updatedAt ?? null,
        id: doc._id,
      },
    });
  }
}

export async function loadTaxSettings(tenantId) {
  return EcommerceTaxSettings.findOne({ tenantId }).lean();
}

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

function mapCategory(row) {
  return {
    id: row._id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? "",
    imageUploadId: row.imageUploadId ?? null,
    imageUrl: row.imageUploadId ? uploadViewPath(row.imageUploadId) : null,
    displayOrder: row.displayOrder ?? 0,
    active: row.active !== false,
    version: row.version ?? 1,
    updatedAt: row.updatedAt ?? null,
  };
}

function mapProduct(row, { includePricing = false, tenant, rateRow, taxSettings } = {}) {
  const base = {
    id: row._id,
    name: row.name,
    slug: row.slug,
    sku: row.sku ?? "",
    description: row.description ?? "",
    categoryId: row.categoryId ?? null,
    imageUploadIds: row.imageUploadIds ?? [],
    imageUrls: (row.imageUploadIds ?? []).map((id) => ({
      uploadId: id,
      viewUrl: uploadViewPath(id),
    })),
    featured: row.featured === true,
    status: row.status,
    purity: row.purity ?? null,
    goldWeightMg: row.goldWeightMg ?? 0,
    makingChargeMode: row.makingChargeMode ?? null,
    makingCharge: row.makingCharge ?? {},
    stones: row.stones ?? [],
    stoneChargePaise: row.stoneChargePaise ?? null,
    otherChargesPaise: row.otherChargesPaise ?? null,
    priceMode: row.priceMode,
    fixedPricing: row.fixedPricing ?? null,
    offer: row.offer ?? null,
    taxClassification: row.taxClassification ?? null,
    version: row.version ?? 1,
    updatedAt: row.updatedAt ?? null,
  };
  if (!includePricing) return base;
  const estimate = computeProductPriceEstimate({
    product: row,
    rateRow,
    taxSettings,
  });
  return {
    ...base,
    pricing: presentPricingEstimate(estimate),
    catalogWriteAllowed: tenant ? isEcommerceCatalogWriteAllowed(tenant) : undefined,
  };
}

function presentPricingEstimate(estimate) {
  const moneyOrNull = (paise) =>
    paise == null ? null : moneyRef(paise);
  return {
    ...estimate,
    preTaxSubtotal: moneyOrNull(estimate.preTaxSubtotalPaise),
    displayTotal: moneyOrNull(estimate.displayTotalPaise),
    gold: {
      ...estimate.gold,
      goldValue: moneyRef(estimate.gold.goldValuePaise),
      ratePerGram: moneyRef(estimate.gold.ratePerGramPaise ?? 0),
    },
    making: {
      ...estimate.making,
      beforeOffer: moneyRef(estimate.making.beforeOfferPaise),
      offerDiscount: moneyRef(estimate.making.offerDiscountPaise),
      afterOffer: moneyRef(estimate.making.afterOfferPaise),
    },
    stones: moneyRef(estimate.stonesPaise),
    otherCharges: moneyRef(estimate.otherChargesPaise),
    tax: {
      ...estimate.tax,
      total: moneyOrNull(estimate.tax.totalPaise),
      lines: (estimate.tax.lines ?? []).map((line) => ({
        ...line,
        taxableBase: moneyRef(line.taxableBasePaise),
        tax: moneyRef(line.taxPaise),
      })),
    },
  };
}

async function loadTaxSettingsScoped(tenantId, session) {
  const q = EcommerceTaxSettings.findOne({ tenantId });
  return session ? q.session(session).lean() : q.lean();
}

async function latestRateForPurityScoped(tenantId, purity, at = new Date(), session) {
  if (!purity) return null;
  const q = EcommerceGoldRate.findOne({
    tenantId,
    purity,
    effectiveAt: { $lte: at },
  })
    .sort({ effectiveAt: -1, createdAt: -1 });
  return session ? q.session(session).lean() : q.lean();
}

async function mapProductWithPricing(row, { tenant, tenantId, session } = {}) {
  const taxSettings = await loadTaxSettingsScoped(tenantId, session);
  const rateRow =
    row.priceMode === EcommercePriceMode.GOLD_RATE_BASED
      ? await latestRateForPurityScoped(tenantId, row.purity, new Date(), session)
      : null;
  return mapProduct(row, {
    includePricing: true,
    tenant,
    rateRow,
    taxSettings,
  });
}

async function assertActiveCategoryForTenant(tenantId, categoryId, session) {
  if (!categoryId) return;
  const cat = await EcommerceCategory.findOne({ _id: categoryId, tenantId }).session(session);
  if (!cat) throw errors.notFound("Category");
  if (cat.active === false) {
    throw errors.validation([
      { field: "categoryId", message: "Choose an active category or leave uncategorised." },
    ]);
  }
}

async function activeCategoryIdsForTenant(tenantId) {
  return EcommerceCategory.find({ tenantId, active: true }).distinct("_id");
}

async function isProductVisibleOnStorefront(product, tenantId) {
  if (product.status !== EcommerceProductStatus.PUBLISHED) return false;
  if (!product.categoryId) return true;
  const cat = await EcommerceCategory.findOne({
    _id: product.categoryId,
    tenantId,
    active: true,
  }).lean();
  return Boolean(cat);
}

function validateTaxRatesPayload(rates, defaultClassification) {
  const codes = rates.map((r) => r.code);
  const seen = new Set();
  for (const code of codes) {
    if (seen.has(code)) {
      throw errors.validation([{ field: "rates", message: `Duplicate tax rate code "${code}".` }]);
    }
    seen.add(code);
  }
  if (defaultClassification != null && defaultClassification !== "") {
    const match = rates.find(
      (r) => r.code === defaultClassification && r.active !== false,
    );
    if (!match) {
      throw errors.validation([
        {
          field: "defaultClassification",
          message: "Default classification must match an active configured rate code.",
        },
      ]);
    }
  }
}

function mapTaxSettingsRow(row) {
  if (!row) {
    return {
      defaultClassification: null,
      rates: [],
      version: 1,
    };
  }
  return {
    defaultClassification: row.defaultClassification ?? null,
    rates: row.rates ?? [],
    hsnSacMappings: row.hsnSacMappings ?? [],
    version: row.version ?? 1,
    updatedAt: row.updatedAt ?? null,
  };
}

async function assertPublishPricingReady(product, tenantId, session) {
  const taxSettings = await loadTaxSettingsScoped(tenantId, session);
  const rateRow =
    product.priceMode === EcommercePriceMode.GOLD_RATE_BASED
      ? await latestRateForPurityScoped(tenantId, product.purity, new Date(), session)
      : null;
  const estimate = computeProductPriceEstimate({ product, rateRow, taxSettings });
  if (!estimate.computable) {
    throw errors.validation(
      estimate.blockers.map((b) => ({
        field: "pricing",
        message: b.message ?? b.code,
        code: b.code,
      })),
    );
  }
}

export async function getStoreStatus(req) {
  return {
    ecommerce: await presentEcommerceAccessStateForTenant(req.tenant),
    catalogWriteAllowed: isEcommerceCatalogWriteAllowed(req.tenant),
  };
}

export async function listCategories(req) {
  const activeOnly = req.query.activeOnly === "true";
  const filter = {};
  if (activeOnly) filter.active = true;
  const result = await paginate(EcommerceCategory, {
    scope: { tenantId: req.auth.tenantId },
    filters: filter,
    sort: "displayOrder:asc",
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  return {
    items: result.data.map(mapCategory),
    meta: result.meta,
  };
}

export async function createCategory(req) {
  assertEcommerceCatalogWrite(req.tenant);
  return withTransaction(async (session) => {
    const slug = normalizeEcommerceSlug(req.body.slug ?? req.body.name);
    const row = (
      await EcommerceCategory.create(
        [
          {
            _id: createId("ecat"),
            tenantId: req.auth.tenantId,
            name: String(req.body.name).trim(),
            slug,
            description: req.body.description ?? "",
            displayOrder: req.body.displayOrder ?? 0,
            active: req.body.active !== false,
          },
        ],
        { session },
      )
    )[0];
    if (req.body.imageUploadId) {
      await validateUploadReferences({
        req,
        uploadIds: [req.body.imageUploadId],
        purpose: UploadPurpose.ECOMMERCE_CATEGORY_IMAGE,
        session,
        entityType: "ECOMMERCE_CATEGORY",
        entityId: row._id,
      });
      row.imageUploadId = req.body.imageUploadId;
      await row.save({ session });
    }
    await writeAudit({
      req,
      action: "ECOMMERCE_CATEGORY_CREATED",
      entityType: AuditEntityType.ECOMMERCE_CATEGORY,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    return mapCategory(row.toObject());
  });
}

export async function getCategory(req) {
  const row = await EcommerceCategory.findOne({
    _id: req.params.categoryId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!row) throw errors.notFound("Category");
  return mapCategory(row);
}

export async function patchCategory(req) {
  assertEcommerceCatalogWrite(req.tenant);
  return withTransaction(async (session) => {
    const row = await EcommerceCategory.findOne({
      _id: req.params.categoryId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!row) throw errors.notFound("Category");
    enforceVersion(row, req.body.expectedVersion);
    const patch = { ...req.body };
    delete patch.expectedVersion;
    if (patch.slug != null) patch.slug = normalizeEcommerceSlug(patch.slug);
    if (patch.name != null) patch.name = String(patch.name).trim();
    if (patch.imageUploadId) {
      await validateUploadReferences({
        req,
        uploadIds: [patch.imageUploadId],
        purpose: UploadPurpose.ECOMMERCE_CATEGORY_IMAGE,
        session,
        entityType: "ECOMMERCE_CATEGORY",
        entityId: row._id,
      });
    }
    Object.assign(row, patch);
    row.version += 1;
    await row.save({ session });
    await writeAudit({
      req,
      action: "ECOMMERCE_CATEGORY_UPDATED",
      entityType: AuditEntityType.ECOMMERCE_CATEGORY,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    return mapCategory(row.toObject());
  });
}

export async function archiveCategory(req) {
  assertEcommerceCatalogWrite(req.tenant);
  return patchCategory({
    ...req,
    body: { expectedVersion: req.body.expectedVersion, active: false },
  });
}

function validateProductPricingFields(body) {
  if (body.priceMode === EcommercePriceMode.FIXED) {
    const base = body.fixedPricing?.basePricePaise;
    if (base == null || base < 0) {
      throw errors.validation([
        { field: "fixedPricing.basePricePaise", message: "Base price is required for fixed products." },
      ]);
    }
    if (body.offer) {
      throw errors.validation([
        { field: "offer", message: "Offers on making charge apply only to gold-rate-based products." },
      ]);
    }
  }
  if (body.priceMode === EcommercePriceMode.GOLD_RATE_BASED) {
    if (!body.purity) {
      throw errors.validation([{ field: "purity", message: "Purity is required for gold-rate-based products." }]);
    }
    if (!(body.goldWeightMg > 0)) {
      throw errors.validation([{ field: "goldWeightMg", message: "Gold weight must be greater than zero." }]);
    }
    if (!body.makingChargeMode) {
      throw errors.validation([{ field: "makingChargeMode", message: "Making charge mode is required." }]);
    }
  }
}

export async function listProducts(req) {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.categoryId) filter.categoryId = req.query.categoryId;
  if (req.query.featured === "true") filter.featured = true;
  const result = await paginate(EcommerceProduct, {
    scope: { tenantId: req.auth.tenantId },
    filters: filter,
    sort: "updatedAt:desc",
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  const taxSettings = await loadTaxSettings(req.auth.tenantId);
  const items = [];
  for (const row of result.data) {
    const rateRow =
      row.priceMode === EcommercePriceMode.GOLD_RATE_BASED
        ? await latestRateForPurity(req.auth.tenantId, row.purity)
        : null;
    items.push(
      mapProduct(row, {
        includePricing: req.query.includePricing === "true",
        tenant: req.tenant,
        rateRow,
        taxSettings,
      }),
    );
  }
  return { items, meta: result.meta };
}

export async function createProduct(req) {
  assertEcommerceCatalogWrite(req.tenant);
  validateProductPricingFields(req.body);
  return withTransaction(async (session) => {
    const slug = normalizeEcommerceSlug(req.body.slug ?? req.body.name);
    if (req.body.categoryId) {
      await assertActiveCategoryForTenant(req.auth.tenantId, req.body.categoryId, session);
    }
    const row = (
      await EcommerceProduct.create(
        [
          {
            _id: createId("eprd"),
            tenantId: req.auth.tenantId,
            name: String(req.body.name).trim(),
            slug,
            sku: req.body.sku ? String(req.body.sku).trim() : "",
            description: req.body.description ?? "",
            categoryId: req.body.categoryId ?? null,
            imageUploadIds: [],
            featured: req.body.featured === true,
            status: EcommerceProductStatus.DRAFT,
            purity: req.body.purity ?? null,
            goldWeightMg: req.body.goldWeightMg ?? 0,
            makingChargeMode: req.body.makingChargeMode ?? null,
            makingCharge: req.body.makingCharge ?? {},
            stones: req.body.stones ?? [],
            stoneChargePaise: req.body.stoneChargePaise ?? null,
            otherChargesPaise: req.body.otherChargesPaise ?? null,
            priceMode: req.body.priceMode,
            fixedPricing: req.body.fixedPricing ?? null,
            offer: req.body.offer ?? null,
            taxClassification: req.body.taxClassification ?? null,
          },
        ],
        { session },
      )
    )[0];
    if (req.body.imageUploadIds?.length) {
      await validateUploadReferences({
        req,
        uploadIds: req.body.imageUploadIds,
        purpose: UploadPurpose.ECOMMERCE_PRODUCT_IMAGE,
        session,
        entityType: "ECOMMERCE_PRODUCT",
        entityId: row._id,
      });
      row.imageUploadIds = req.body.imageUploadIds;
      await row.save({ session });
    }
    await writeAudit({
      req,
      action: "ECOMMERCE_PRODUCT_CREATED",
      entityType: AuditEntityType.ECOMMERCE_PRODUCT,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    return mapProduct(row.toObject(), { tenant: req.tenant });
  });
}

export async function getProduct(req) {
  const row = await EcommerceProduct.findOne({
    _id: req.params.productId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!row) throw errors.notFound("Product");
  const taxSettings = await loadTaxSettings(req.auth.tenantId);
  const rateRow =
    row.priceMode === EcommercePriceMode.GOLD_RATE_BASED
      ? await latestRateForPurity(req.auth.tenantId, row.purity)
      : null;
  return mapProduct(row, {
    includePricing: true,
    tenant: req.tenant,
    rateRow,
    taxSettings,
  });
}

export async function patchProduct(req) {
  assertEcommerceCatalogWrite(req.tenant);
  const notificationIntent = req.body.notification;
  const {
    assertPromotionNotificationAuthorized,
    buildOfferIntent,
    persistCampaignIntent,
    mergePromotionResult,
    tryEnqueuePromotionAfterCommit,
  } = await import("./ecommerce-promotion.service.js");
  assertPromotionNotificationAuthorized(req, notificationIntent);
  let pendingCampaignId = null;
  const result = await withTransaction(async (session) => {
    const row = await EcommerceProduct.findOne({
      _id: req.params.productId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!row) throw errors.notFound("Product");
    enforceVersion(row, req.body.expectedVersion);
    const before = row.toObject();
    const patch = { ...req.body };
    delete patch.expectedVersion;
    delete patch.notification;
    if (patch.slug != null) patch.slug = normalizeEcommerceSlug(patch.slug);
    const merged = buildMergedProductForPatch(before, patch);
    validateProductPricingFields(merged);
    validateProductScheduleWindows(merged);
    const pricingAssign = pricingFieldsFromPatchAssign(merged, patch);
    const nextCategoryId =
      patch.categoryId !== undefined ? patch.categoryId : row.categoryId;
    const nextStatus = patch.status ?? row.status;
    if (patch.categoryId != null || nextStatus === EcommerceProductStatus.PUBLISHED) {
      await assertActiveCategoryForTenant(req.auth.tenantId, nextCategoryId, session);
    }
    if (nextStatus === EcommerceProductStatus.PUBLISHED) {
      await assertPublishPricingReady(merged, req.auth.tenantId, session);
    }
    if (patch.imageUploadIds?.length) {
      await validateUploadReferences({
        req,
        uploadIds: patch.imageUploadIds,
        purpose: UploadPurpose.ECOMMERCE_PRODUCT_IMAGE,
        session,
        entityType: "ECOMMERCE_PRODUCT",
        entityId: row._id,
      });
    }
    const scalarPatch = { ...patch };
    for (const key of PRICING_PATCH_KEYS) delete scalarPatch[key];
    Object.assign(row, scalarPatch, pricingAssign);
    row.version += 1;
    await row.save({ session });
    await writeAudit({
      req,
      action: "ECOMMERCE_PRODUCT_UPDATED",
      entityType: AuditEntityType.ECOMMERCE_PRODUCT,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    const mapped = await mapProductWithPricing(row.toObject(), {
      tenant: req.tenant,
      tenantId: req.auth.tenantId,
      session,
    });
    let promotion = { queued: false };
    if (notificationIntent?.enabled && notificationIntent?.kind === "OFFER") {
      const intent = await buildOfferIntent(req, {
        before,
        after: row.toObject(),
        notification: notificationIntent,
      });
      if (!intent) {
        promotion = { queued: false };
      } else if (intent.skip) {
        promotion = { queued: false, reason: intent.reason };
      } else {
        const persisted = await persistCampaignIntent(session, req, intent);
        pendingCampaignId = persisted.campaignId ?? null;
        promotion = mergePromotionResult(
          {
            campaign: persisted.campaign,
            intentPersisted: Boolean(pendingCampaignId),
            duplicate: Boolean(persisted.duplicate),
            scheduled: Boolean(intent.scheduledFor),
          },
          null,
        );
      }
    }
    return { mapped, promotion };
  });
  const enq = await tryEnqueuePromotionAfterCommit(pendingCampaignId, req.auth.tenantId);
  return { ...result.mapped, promotion: mergePromotionResult(result.promotion, enq) };
}

export async function publishProduct(req) {
  assertEcommerceCatalogWrite(req.tenant);
  const notificationIntent = req.body.notification;
  const {
    assertPromotionNotificationAuthorized,
    buildNewArrivalIntent,
    persistCampaignIntent,
    mergePromotionResult,
    tryEnqueuePromotionAfterCommit,
  } = await import("./ecommerce-promotion.service.js");
  assertPromotionNotificationAuthorized(req, notificationIntent);
  let isFirstPublication = false;
  let pendingCampaignId = null;
  let promotion = { queued: false };
  const result = await withTransaction(async (session) => {
    const row = await EcommerceProduct.findOne({
      _id: req.params.productId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!row) throw errors.notFound("Product");
    enforceVersion(row, req.body.expectedVersion);
    const wasPublished = row.status === EcommerceProductStatus.PUBLISHED;
    isFirstPublication = !wasPublished && !row.firstPublishedAt;
    validateProductPricingFields({
      ...row.toObject(),
      status: EcommerceProductStatus.PUBLISHED,
      priceMode: row.priceMode,
    });
    const merged = { ...row.toObject(), status: EcommerceProductStatus.PUBLISHED };
    await assertActiveCategoryForTenant(req.auth.tenantId, merged.categoryId, session);
    await assertPublishPricingReady(merged, req.auth.tenantId, session);
    row.status = EcommerceProductStatus.PUBLISHED;
    if (!row.firstPublishedAt && !wasPublished) {
      row.firstPublishedAt = new Date();
    }
    row.version += 1;
    await row.save({ session });
    await writeAudit({
      req,
      action: "ECOMMERCE_PRODUCT_PUBLISHED",
      entityType: AuditEntityType.ECOMMERCE_PRODUCT,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    const product = row.toObject();
    if (notificationIntent?.enabled && isFirstPublication) {
      const intent = await buildNewArrivalIntent(req, product, notificationIntent);
      if (intent) {
        const persisted = await persistCampaignIntent(session, req, intent);
        pendingCampaignId = persisted.campaignId ?? null;
        promotion = mergePromotionResult(
          {
            campaign: persisted.campaign,
            intentPersisted: Boolean(pendingCampaignId),
            duplicate: Boolean(persisted.duplicate),
          },
          null,
        );
      }
    } else if (notificationIntent?.enabled && !isFirstPublication) {
      promotion = { queued: false, reason: "NOT_FIRST_PUBLICATION" };
    }
    return product;
  });
  const enq = await tryEnqueuePromotionAfterCommit(pendingCampaignId, req.auth.tenantId);
  promotion = mergePromotionResult(promotion, enq);
  const mapped = await mapProductWithPricing(result, {
    tenant: req.tenant,
    tenantId: req.auth.tenantId,
  });
  return { ...mapped, promotion };
}

export async function archiveProduct(req) {
  assertEcommerceCatalogWrite(req.tenant);
  return patchProduct({
    ...req,
    body: {
      expectedVersion: req.body.expectedVersion,
      status: EcommerceProductStatus.ARCHIVED,
    },
  });
}

export async function previewProductPrice(req) {
  const row = await EcommerceProduct.findOne({
    _id: req.params.productId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!row) throw errors.notFound("Product");
  const taxSettings = await loadTaxSettings(req.auth.tenantId);
  const rateRow =
    row.priceMode === EcommercePriceMode.GOLD_RATE_BASED
      ? await latestRateForPurity(req.auth.tenantId, row.purity)
      : null;
  const estimate = computeProductPriceEstimate({ product: row, rateRow, taxSettings });
  return presentPricingEstimate(estimate);
}

export async function setEcommerceGoldRate(req) {
  assertEcommerceCatalogWrite(req.tenant);
  const notificationIntent = req.body.notification;
  const {
    assertPromotionNotificationAuthorized,
    buildEcommerceGoldRateNotificationIntent,
    persistRateNotificationIntent,
    mergePromotionResult,
    finalizeRateNotificationAfterCommit,
  } = await import("./gold-rate-notification.service.js");
  assertPromotionNotificationAuthorized(req, notificationIntent);
  let pendingCampaignId = null;
  let notification = { intentPersisted: false };
  const { resolveEcommerceGoldRateEffectiveAt } = await import("../lib/ecommerce-gold-rate-effective.js");
  const { effectiveAt } = resolveEcommerceGoldRateEffectiveAt(req.body);
  const mapped = await withTransaction(async (session) => {
    const row = (
      await EcommerceGoldRate.create(
        [
          {
            _id: createId("egrt"),
            tenantId: req.auth.tenantId,
            purity: req.body.purity,
            ratePerGramPaise: req.body.ratePerGramPaise,
            effectiveAt,
            enteredBy: req.auth.id,
          },
        ],
        { session },
      )
    )[0];
    await writeAudit({
      req,
      action: "ECOMMERCE_GOLD_RATE_SET",
      entityType: AuditEntityType.ECOMMERCE_GOLD_RATE,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    if (notificationIntent?.enabled) {
      const intent = buildEcommerceGoldRateNotificationIntent(req, row.toObject(), {
        effectiveTiming: req.body.effectiveTiming ?? (req.body.effectiveAt ? "SCHEDULED" : "NOW"),
      });
      if (intent.skip) {
        notification = { intentPersisted: false, skipped: true, reason: intent.reason };
      } else {
        const persisted = await persistRateNotificationIntent(session, req, intent);
        pendingCampaignId = persisted.campaignId ?? null;
        notification = mergePromotionResult(
          {
            intentPersisted: Boolean(pendingCampaignId),
            duplicate: Boolean(persisted.duplicate),
            scheduled: Boolean(intent.scheduledFor && new Date(intent.scheduledFor).getTime() > Date.now()),
            campaign: persisted.campaign,
          },
          null,
        );
      }
    }
    return {
      id: row._id,
      purity: row.purity,
      ratePerGramPaise: row.ratePerGramPaise,
      ratePerGram: moneyRef(row.ratePerGramPaise),
      effectiveAt: row.effectiveAt,
      version: row.version,
      notification,
    };
  });
  if (pendingCampaignId) {
    const enq = await finalizeRateNotificationAfterCommit(pendingCampaignId, req.auth.tenantId);
    mapped.notification = mergePromotionResult(mapped.notification, enq);
  }
  return mapped;
}

export async function listEcommerceGoldRates(req) {
  const filter = {};
  if (req.query.purity) filter.purity = req.query.purity;
  const result = await paginate(EcommerceGoldRate, {
    scope: { tenantId: req.auth.tenantId },
    filters: filter,
    sort: "effectiveAt:desc",
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  return {
    items: result.data.map((row) => ({
      id: row._id,
      purity: row.purity,
      ratePerGramPaise: row.ratePerGramPaise,
      ratePerGram: moneyRef(row.ratePerGramPaise),
      effectiveAt: row.effectiveAt,
      enteredBy: row.enteredBy ?? null,
      version: row.version ?? 1,
      createdAt: row.createdAt,
    })),
    meta: result.meta,
  };
}

export async function getEcommerceGoldRatesCurrent(req) {
  const purities = ["18K", "22K", "24K"];
  const at = req.query.at ? new Date(req.query.at) : new Date();
  const rows = await Promise.all(
    purities.map(async (purity) => {
      const row = await latestRateForPurity(req.auth.tenantId, purity, at);
      return row
        ? {
            purity,
            id: row._id,
            ratePerGramPaise: row.ratePerGramPaise,
            ratePerGram: moneyRef(row.ratePerGramPaise),
            effectiveAt: row.effectiveAt,
            version: row.version,
          }
        : { purity, id: null, ratePerGramPaise: null, ratePerGram: null, effectiveAt: null, version: null };
    }),
  );
  return { rates: rows, asOf: at.toISOString() };
}

export async function getTaxSettings(req) {
  const row = await loadTaxSettings(req.auth.tenantId);
  if (!row) {
    return {
      defaultClassification: null,
      rates: [],
      version: 1,
    };
  }
  return {
    defaultClassification: row.defaultClassification ?? null,
    rates: row.rates ?? [],
    hsnSacMappings: row.hsnSacMappings ?? [],
    version: row.version ?? 1,
    updatedAt: row.updatedAt ?? null,
  };
}

export async function putTaxSettings(req) {
  assertEcommerceCatalogWrite(req.tenant);
  const rates = req.body.rates ?? [];
  const defaultClassification =
    "defaultClassification" in req.body ? req.body.defaultClassification : undefined;
  return withTransaction(async (session) => {
    let row = await EcommerceTaxSettings.findOne({ tenantId: req.auth.tenantId }).session(session);
    const nextDefault =
      defaultClassification !== undefined
        ? defaultClassification
        : (row?.defaultClassification ?? null);
    validateTaxRatesPayload(rates, nextDefault);
    if (row) {
      if (req.body.expectedVersion == null) {
        throw errors.validation([
          { field: "expectedVersion", message: "expectedVersion is required when updating tax settings." },
        ]);
      }
      enforceVersion(row, req.body.expectedVersion);
      row.rates = rates;
      if (defaultClassification !== undefined) {
        row.defaultClassification = defaultClassification;
      }
      if (req.body.hsnSacMappings) {
        row.hsnSacMappings = req.body.hsnSacMappings.map((m) => ({
          classification: String(m.classification).trim(),
          hsnSacCode: String(m.hsnSacCode).trim().toUpperCase(),
          hsnSacType: m.hsnSacType,
        }));
      }
      row.updatedBy = req.auth.id;
      row.version += 1;
      await row.save({ session });
    } else {
      if (req.body.expectedVersion != null && req.body.expectedVersion !== 1) {
        throw errors.validation([
          {
            field: "expectedVersion",
            message: "First tax settings save must omit expectedVersion or send 1.",
          },
        ]);
      }
      row = (
        await EcommerceTaxSettings.create(
          [
            {
              _id: createId("etax"),
              tenantId: req.auth.tenantId,
              defaultClassification: defaultClassification ?? null,
              rates,
              hsnSacMappings: (req.body.hsnSacMappings ?? []).map((m) => ({
                classification: String(m.classification).trim(),
                hsnSacCode: String(m.hsnSacCode).trim().toUpperCase(),
                hsnSacType: m.hsnSacType,
              })),
              updatedBy: req.auth.id,
            },
          ],
          { session },
        )
      )[0];
    }
    await writeAudit({
      req,
      action: "ECOMMERCE_TAX_SETTINGS_UPDATED",
      entityType: AuditEntityType.ECOMMERCE_TAX_SETTINGS,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    return mapTaxSettingsRow(row.toObject());
  });
}

export async function shopAvailability(req) {
  const ecommerce = await presentEcommerceAccessStateForTenant(req.tenant);
  const hasOrderHistory = req.auth?.id
    ? await customerHasEcommerceOrderHistory(req.auth.tenantId, req.auth.id)
    : false;
  return {
    available: ecommerce.active,
    ecommerce: { ...ecommerce, hasOrderHistory },
    hasOrderHistory,
    orderHistoryAvailable: hasOrderHistory,
  };
}

export async function shopGetStorePolicies(req) {
  assertEcommerceOperational(req.tenant);
  const settings = await EcommerceFulfilmentSettings.findOne({ tenantId: req.auth.tenantId }).lean();
  const mapped = mapPublishedStorePolicies(settings);
  if (!mapped.ready) {
    return { published: false, policies: null };
  }
  return {
    published: true,
    policies: {
      version: mapped.version,
      publishedAt: mapped.publishedAt,
      shippingPolicyText: mapped.shippingPolicyText,
      returnsPolicyText: mapped.returnsPolicyText,
      cancellationPolicyText: mapped.cancellationPolicyText,
      refundContactPolicyText: mapped.refundContactPolicyText,
      returnEligibilityDays: mapped.returnEligibilityDays,
    },
  };
}

export async function shopListCategories(req) {
  assertEcommerceOperational(req.tenant);
  const rows = await EcommerceCategory.find({
    tenantId: req.auth.tenantId,
    active: true,
  })
    .sort({ displayOrder: 1, name: 1 })
    .lean();
  return { items: rows.map(mapCategory) };
}

export async function shopListProducts(req) {
  assertEcommerceOperational(req.tenant);
  const activeCategories = await activeCategoryIdsForTenant(req.auth.tenantId);
  const storefrontVisibility = {
    $or: [
      { categoryId: null },
      { categoryId: { $exists: false } },
      { categoryId: "" },
      { categoryId: { $in: activeCategories } },
    ],
  };
  const filter = {
    status: EcommerceProductStatus.PUBLISHED,
    $and: [storefrontVisibility],
  };
  if (req.query.categoryId) {
    if (!activeCategories.includes(req.query.categoryId)) {
      return { items: [], meta: { hasMore: false, nextCursor: null } };
    }
    filter.categoryId = req.query.categoryId;
    delete filter.$and;
  }
  if (req.query.featured === "true") filter.featured = true;
  const q = String(req.query.q ?? "").trim();
  if (q.length >= 2) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$and = [...(filter.$and ?? []), { name: { $regex: escaped, $options: "i" } }];
  }
  const sortKey = String(req.query.sort ?? "newest").trim();
  const sort = sortKey === "name" ? "name:asc" : "updatedAt:desc";
  const result = await paginate(EcommerceProduct, {
    scope: { tenantId: req.auth.tenantId },
    filters: filter,
    sort,
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  const taxSettings = await loadTaxSettings(req.auth.tenantId);
  const items = [];
  for (const row of result.data) {
    const rateRow =
      row.priceMode === EcommercePriceMode.GOLD_RATE_BASED
        ? await latestRateForPurity(req.auth.tenantId, row.purity)
        : null;
    const mapped = mapProduct(row, {
      includePricing: true,
      tenant: req.tenant,
      rateRow,
      taxSettings,
    });
    const availability = await loadInventoryAvailability(req.auth.tenantId, row._id);
    items.push({
      ...mapped,
      availability: mapPublicAvailability(availability),
    });
  }
  return { items, meta: result.meta };
}

export async function shopGetProduct(req) {
  assertEcommerceOperational(req.tenant);
  const key = req.params.productIdOrSlug;
  const row = await EcommerceProduct.findOne({
    tenantId: req.auth.tenantId,
    status: EcommerceProductStatus.PUBLISHED,
    $or: [{ _id: key }, { slug: key }],
  }).lean();
  if (!row) throw errors.notFound("Product");
  if (!(await isProductVisibleOnStorefront(row, req.auth.tenantId))) {
    throw errors.notFound("Product");
  }
  const taxSettings = await loadTaxSettings(req.auth.tenantId);
  const rateRow =
    row.priceMode === EcommercePriceMode.GOLD_RATE_BASED
      ? await latestRateForPurity(req.auth.tenantId, row.purity)
      : null;
  const mapped = mapProduct(row, {
    includePricing: true,
    tenant: req.tenant,
    rateRow,
    taxSettings,
  });
  const availability = await loadInventoryAvailability(req.auth.tenantId, row._id);
  return {
    ...mapped,
    availability: mapPublicAvailability(availability),
  };
}
