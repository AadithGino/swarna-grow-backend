import {
  AuditEntityType,
  EcommerceProductStatus,
  EcommercePriceMode,
  UploadPurpose,
} from "../constants/enums.js";
import {
  EcommerceCategory,
  EcommerceGoldRate,
  EcommerceProduct,
  EcommerceTaxSettings,
} from "../models/index.js";
import {
  assertEcommerceCatalogWrite,
  assertEcommerceOperational,
  isEcommerceCatalogWriteAllowed,
  presentEcommerceAccessState,
} from "../lib/ecommerce-access.js";
import { computeProductPriceEstimate } from "../lib/ecommerce-pricing.js";
import { normalizeEcommerceSlug } from "../lib/ecommerce-slug.js";
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
    throw errors.conflict("VERSION_CONFLICT", "Record was updated elsewhere. Refresh and retry.");
  }
}

async function loadTaxSettings(tenantId) {
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
  return {
    ...estimate,
    preTaxSubtotal: moneyRef(estimate.preTaxSubtotalPaise),
    displayTotal: moneyRef(estimate.displayTotalPaise),
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
      total: moneyRef(estimate.tax.totalPaise),
      lines: estimate.tax.lines.map((line) => ({
        ...line,
        taxableBase: moneyRef(line.taxableBasePaise),
        tax: moneyRef(line.taxPaise),
      })),
    },
  };
}

export async function getStoreStatus(req) {
  return {
    ecommerce: presentEcommerceAccessState(req.tenant),
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
  return withTransaction(async (session) => {
    const row = await EcommerceProduct.findOne({
      _id: req.params.productId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!row) throw errors.notFound("Product");
    enforceVersion(row, req.body.expectedVersion);
    validateProductPricingFields({
      ...row.toObject(),
      ...req.body,
      priceMode: req.body.priceMode ?? row.priceMode,
    });
    const patch = { ...req.body };
    delete patch.expectedVersion;
    if (patch.slug != null) patch.slug = normalizeEcommerceSlug(patch.slug);
    if (patch.status === EcommerceProductStatus.PUBLISHED) {
      assertEcommerceCatalogWrite(req.tenant);
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
    Object.assign(row, patch);
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
    return getProduct(req);
  });
}

export async function publishProduct(req) {
  assertEcommerceCatalogWrite(req.tenant);
  return patchProduct({
    ...req,
    body: {
      expectedVersion: req.body.expectedVersion,
      status: EcommerceProductStatus.PUBLISHED,
    },
  });
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
  return withTransaction(async (session) => {
    const row = (
      await EcommerceGoldRate.create(
        [
          {
            _id: createId("egrt"),
            tenantId: req.auth.tenantId,
            purity: req.body.purity,
            ratePerGramPaise: req.body.ratePerGramPaise,
            effectiveAt: new Date(req.body.effectiveAt),
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
    return {
      id: row._id,
      purity: row.purity,
      ratePerGramPaise: row.ratePerGramPaise,
      ratePerGram: moneyRef(row.ratePerGramPaise),
      effectiveAt: row.effectiveAt,
      version: row.version,
    };
  });
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
    version: row.version ?? 1,
    updatedAt: row.updatedAt ?? null,
  };
}

export async function putTaxSettings(req) {
  assertEcommerceCatalogWrite(req.tenant);
  return withTransaction(async (session) => {
    let row = await EcommerceTaxSettings.findOne({ tenantId: req.auth.tenantId }).session(session);
    if (row) {
      enforceVersion(row, req.body.expectedVersion);
      row.defaultClassification = req.body.defaultClassification ?? row.defaultClassification;
      row.rates = req.body.rates ?? row.rates;
      row.updatedBy = req.auth.id;
      row.version += 1;
      await row.save({ session });
    } else {
      row = (
        await EcommerceTaxSettings.create(
          [
            {
              _id: createId("etax"),
              tenantId: req.auth.tenantId,
              defaultClassification: req.body.defaultClassification ?? null,
              rates: req.body.rates ?? [],
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
    return getTaxSettings(req);
  });
}

export async function shopAvailability(req) {
  return {
    available: presentEcommerceAccessState(req.tenant).active,
    ecommerce: presentEcommerceAccessState(req.tenant),
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
  const filter = {
    status: EcommerceProductStatus.PUBLISHED,
  };
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
        includePricing: true,
        tenant: req.tenant,
        rateRow,
        taxSettings,
      }),
    );
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
