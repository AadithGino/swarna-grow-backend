/**
 * Idempotent ecommerce catalog demo seed (MEHER / KAIRALI). Does not mutate tenant entitlement or settings.
 */
import {
  EcommerceGoldPurity,
  EcommerceMakingChargeMode,
  EcommerceOfferType,
  EcommercePriceMode,
  EcommerceProductStatus,
  EcommerceStockPolicy,
  TenantRole,
  UserStatus,
} from "../../src/constants/enums.js";
import { attachSubscriptionCatalogPlan } from "../../src/lib/subscription-plan-for-tenant.js";
import {
  isEcommerceCatalogWriteAllowed,
  isEcommerceOperational,
  presentEcommerceAccessState,
} from "../../src/lib/ecommerce-access.js";
import { deriveEcommerceCheckoutCapability } from "../../src/lib/ecommerce-checkout-capability.js";
import { computeProductPriceEstimate } from "../../src/lib/ecommerce-pricing.js";
import {
  Branch,
  EcommerceCategory,
  EcommerceGoldRate,
  EcommerceProduct,
  Tenant,
  User,
} from "../../src/models/index.js";
import { ensureDemoProductImageUpload } from "./ecommerce-demo-images.js";
import {
  DEMO_TAX_CLASSIFICATION,
  ensureDemoDisplayTaxSettings,
} from "./ecommerce-demo-tax.js";
import { ensureDemoCheckoutTaxConfig } from "./ecommerce-demo-checkout.js";
import { deriveDeliveryConfigured } from "../../src/lib/ecommerce-fulfilment.js";
import * as adminCommerce from "../../src/services/ecommerce-admin-commerce.service.js";
import * as ecommerce from "../../src/services/ecommerce.service.js";
import { loadTaxSettings } from "../../src/services/ecommerce.service.js";

export const DEMO_SEED_TAG = "swarnagrow-ecommerce-demo-seed v1";
export const DEMO_RATE_ENTERED_BY = "seed-ecommerce-demo";
/** Demo delivery — TEST DATA only; ₹0 charge so admin UI passes server configure checks. */
export const DEMO_SERVICEABLE_PINCODES = ["686691", "686692", "682001", "695001"];
export const DEMO_DELIVERY_CHARGE_PAISE = 0;

export function demoSlugPrefix(tenantCode) {
  return `demo-ec-${String(tenantCode).trim().toLowerCase()}-`;
}

export function demoSkuPrefix(tenantCode) {
  return `DEMO-EC-${String(tenantCode).trim().toUpperCase()}-`;
}

export function isDemoOwnedSlug(slug, tenantCode) {
  return String(slug ?? "").startsWith(demoSlugPrefix(tenantCode));
}

function demoProductKeyMarker(key) {
  return `[demo-product-key:${key}]`;
}

function demoDescription(text, productKey) {
  const keyLine = productKey ? `\n${demoProductKeyMarker(productKey)}` : "";
  return `${text}\n\n[${DEMO_SEED_TAG}]${keyLine}`;
}

function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function buildCategorySpecs(tenantCode) {
  const p = demoSlugPrefix(tenantCode);
  return [
    { key: "featured", slug: `${p}featured-picks`, name: "Featured picks", displayOrder: 0, active: true },
    { key: "rings", slug: `${p}rings`, name: "Rings", displayOrder: 10, active: true },
    { key: "chains", slug: `${p}chains`, name: "Chains", displayOrder: 20, active: true },
    { key: "inactive", slug: `${p}legacy-inactive`, name: "Legacy (inactive)", displayOrder: 99, active: false },
  ];
}

export function buildProductSpecs(tenantCode, categoryIds, taxClassification) {
  const sku = demoSkuPrefix(tenantCode);
  const p = demoSlugPrefix(tenantCode);
  const { featured, rings, chains } = categoryIds;
  const tc = taxClassification ?? undefined;

  return [
    {
      key: "draft-gold-22k",
      slug: `${p}draft-gold-22k`,
      sku: `${sku}DRAFT-22K`,
      name: "Demo draft gold band (22K)",
      categoryId: rings,
      status: EcommerceProductStatus.DRAFT,
      featured: false,
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: EcommerceGoldPurity["22K"],
      goldWeightMg: 4200,
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 85_000 },
      taxClassification: tc,
    },
    {
      key: "fixed-featured-sale",
      slug: `${p}fixed-featured-sale`,
      sku: `${sku}FIX-SALE`,
      name: "Demo fixed pendant (sale window)",
      categoryId: featured,
      status: EcommerceProductStatus.PUBLISHED,
      featured: true,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: {
        basePricePaise: 45_000_00,
        salePricePaise: 39_990_00,
        saleStartsAt: isoDaysFromNow(-2),
        saleEndsAt: isoDaysFromNow(45),
      },
      taxClassification: tc,
      attachDemoImage: true,
    },
    {
      key: "fixed-standard",
      slug: `${p}fixed-standard`,
      sku: `${sku}FIX-STD`,
      name: "Demo fixed earrings",
      categoryId: rings,
      status: EcommerceProductStatus.PUBLISHED,
      featured: false,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 12_500_00 },
      taxClassification: tc,
      attachDemoImage: true,
    },
    {
      key: "gold-22k-fixed-making",
      slug: `${p}gold-22k-fixed-making`,
      sku: `${sku}G22-FIXMK`,
      name: "Demo 22K ring (fixed making)",
      categoryId: rings,
      status: EcommerceProductStatus.PUBLISHED,
      featured: true,
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: EcommerceGoldPurity["22K"],
      goldWeightMg: 3800,
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 120_000 },
      taxClassification: tc,
      attachDemoImage: true,
    },
    {
      key: "gold-18k-per-gram",
      slug: `${p}gold-18k-per-gram`,
      sku: `${sku}G18-PGRM`,
      name: "Demo 18K chain (per-gram making)",
      categoryId: chains,
      status: EcommerceProductStatus.PUBLISHED,
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: EcommerceGoldPurity["18K"],
      goldWeightMg: 9600,
      makingChargeMode: EcommerceMakingChargeMode.PER_GRAM_PAISE,
      makingCharge: { perGramPaise: 350_00 },
      taxClassification: tc,
    },
    {
      key: "gold-24k-offer-active",
      slug: `${p}gold-24k-offer-active`,
      sku: `${sku}G24-OFFACT`,
      name: "Demo 24K coin (active making offer)",
      categoryId: featured,
      status: EcommerceProductStatus.PUBLISHED,
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: EcommerceGoldPurity["24K"],
      goldWeightMg: 5000,
      makingChargeMode: EcommerceMakingChargeMode.PERCENT_OF_GOLD,
      makingCharge: { percentBps: 800 },
      offer: {
        type: EcommerceOfferType.PERCENT_OFF,
        percentBps: 1000,
        startsAt: isoDaysFromNow(-1),
        endsAt: isoDaysFromNow(21),
      },
      taxClassification: tc,
    },
    {
      key: "gold-22k-offer-future",
      slug: `${p}gold-22k-offer-future`,
      sku: `${sku}G22-OFFFUT`,
      name: "Demo 22K bangle (future making offer)",
      categoryId: chains,
      status: EcommerceProductStatus.PUBLISHED,
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: EcommerceGoldPurity["22K"],
      goldWeightMg: 7200,
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 95_000 },
      offer: {
        type: EcommerceOfferType.FIXED_PAISE_OFF,
        valuePaise: 25_000,
        startsAt: isoDaysFromNow(7),
        endsAt: isoDaysFromNow(30),
      },
      taxClassification: tc,
    },
    {
      key: "inactive-category-draft",
      slug: `${p}inactive-category-item`,
      sku: `${sku}INCAT-DRF`,
      name: "Demo draft (uncategorised — inactive category is separate)",
      categoryId: null,
      status: EcommerceProductStatus.DRAFT,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 8_000_00 },
      taxClassification: tc,
    },
    {
      key: "archived-fixed",
      slug: `${p}archived-fixed`,
      sku: `${sku}ARCHIVED`,
      name: "Demo archived fixed item",
      categoryId: rings,
      status: EcommerceProductStatus.ARCHIVED,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 9_999_00 },
      taxClassification: tc,
      attachDemoImage: true,
    },
    {
      key: "gold-stones-tracked",
      slug: `${p}gold-stones-tracked`,
      sku: `${sku}G22-STK5`,
      name: "Demo 22K ring with stones (in stock)",
      categoryId: rings,
      status: EcommerceProductStatus.PUBLISHED,
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: EcommerceGoldPurity["22K"],
      goldWeightMg: 4100,
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 110_000 },
      stones: [{ name: "CZ", chargePaise: 15_000 }],
      stoneChargePaise: 15_000,
      otherChargesPaise: 5000,
      taxClassification: tc,
      inventory: { policy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 5 },
    },
    {
      key: "gold-zero-stock",
      slug: `${p}gold-zero-stock`,
      sku: `${sku}G22-STK0`,
      name: "Demo 22K pendant (tracked, zero stock)",
      categoryId: rings,
      status: EcommerceProductStatus.PUBLISHED,
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: EcommerceGoldPurity["22K"],
      goldWeightMg: 2900,
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 75_000 },
      taxClassification: tc,
      inventory: { policy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 0 },
    },
    {
      key: "gold-made-to-order",
      slug: `${p}gold-made-to-order`,
      sku: `${sku}G22-MTO`,
      name: "Demo 22K custom chain (made to order)",
      categoryId: chains,
      status: EcommerceProductStatus.PUBLISHED,
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: EcommerceGoldPurity["22K"],
      goldWeightMg: 12000,
      makingChargeMode: EcommerceMakingChargeMode.PER_GRAM_PAISE,
      makingCharge: { perGramPaise: 400_00 },
      taxClassification: tc,
      inventory: { policy: EcommerceStockPolicy.MADE_TO_ORDER },
    },
  ];
}

export function resolveDemoTaxClassification(taxSettings) {
  const dc = taxSettings?.defaultClassification;
  if (dc && (taxSettings?.rates ?? []).some((r) => r.code === dc && r.active !== false)) {
    return dc;
  }
  const first = (taxSettings?.rates ?? []).find((r) => r.active !== false);
  return first?.code ?? null;
}

/** Demo rows on this tenant whose slug/SKU imply a different tenant code (mislabel, not cross-tenantId leak). */
export async function auditDemoCatalogLabels(tenantId, tenantCode) {
  const slugPrefix = demoSlugPrefix(tenantCode);
  const skuPrefix = demoSkuPrefix(tenantCode);
  const products = await EcommerceProduct.find({ tenantId, slug: /^demo-ec-/ })
    .select("slug sku tenantId")
    .lean();
  const mislabeledSlug = products.filter((p) => !String(p.slug).startsWith(slugPrefix));
  const mislabeledSku = products.filter(
    (p) => p.sku && String(p.sku).startsWith("DEMO-EC-") && !String(p.sku).startsWith(skuPrefix),
  );
  return {
    tenantId,
    tenantCode,
    demoProductCount: products.length,
    crossTenantIdLeakSuspected: false,
    mislabeledSlug: mislabeledSlug.map((p) => ({ slug: p.slug, sku: p.sku })),
    mislabeledSku: mislabeledSku.map((p) => ({ slug: p.slug, sku: p.sku })),
    diagnosis:
      mislabeledSku.length || mislabeledSlug.length
        ? "Demo catalog rows belong to this tenantId but use another tenant's demo prefix — re-run seed with the correct --tenants code (not a cross-tenant read leak)."
        : "OK",
  };
}

async function ensureDemoPickup(req, tenantCode, dryRun, report) {
  const existing = await adminCommerce.getAdminFulfilmentSettings(req);
  if (existing.pickupEnabled && (existing.pickupBranchIds?.length ?? 0) > 0) {
    report.fulfilment = { action: "preserved_existing_pickup" };
    return;
  }
  const branch =
    (await Branch.findOne({ tenantId: req.auth.tenantId, isHeadOffice: true, active: { $ne: false } }).lean())
    ?? (await Branch.findOne({ tenantId: req.auth.tenantId, active: { $ne: false } }).lean());
  if (!branch) {
    report.fulfilment = { action: "skipped_no_branch" };
    return;
  }
  if (dryRun) {
    report.fulfilment = { action: "would_enable_pickup", branchId: branch._id };
    return;
  }
  const updated = await adminCommerce.putAdminFulfilmentSettings({
    ...req,
    body: {
      expectedVersion: existing.version ?? 1,
      pickupEnabled: true,
      pickupBranchIds: [branch._id],
    },
  });
  report.fulfilment = {
    action: "enabled_pickup",
    branchId: branch._id,
    version: updated.version,
    note: "Display/demo pickup only — checkout tax not fabricated.",
  };
}

async function ensureDemoDelivery(req, dryRun, report) {
  const existing = await adminCommerce.getAdminFulfilmentSettings(req);
  const rowLike = {
    serviceablePincodes: existing.serviceablePincodes,
    deliveryChargePaise: existing.deliveryChargePaise,
  };
  if (existing.deliveryEnabled && deriveDeliveryConfigured(rowLike)) {
    report.delivery = { action: "preserved_existing_delivery" };
    return;
  }
  if (dryRun) {
    report.delivery = {
      action: "would_enable_demo_delivery",
      pincodes: DEMO_SERVICEABLE_PINCODES,
      deliveryChargePaise: DEMO_DELIVERY_CHARGE_PAISE,
    };
    return;
  }
  const updated = await adminCommerce.putAdminFulfilmentSettings({
    ...req,
    body: {
      expectedVersion: existing.version ?? 1,
      deliveryEnabled: true,
      serviceablePincodes: DEMO_SERVICEABLE_PINCODES,
      deliveryChargePaise: DEMO_DELIVERY_CHARGE_PAISE,
    },
  });
  report.delivery = {
    action: "enabled_demo_delivery",
    deliveryEnabled: updated.deliveryEnabled,
    deliveryConfigured: updated.deliveryConfigured,
    pincodes: updated.serviceablePincodes,
    deliveryChargePaise: updated.deliveryChargePaise,
    note: "TEST DATA — demo delivery; inter-state checkout tax comes from demo checkout fixture.",
  };
}

export async function buildAcceptanceEvidence(tenantId, tenantCode) {
  const taxSettings = await loadTaxSettings(tenantId);
  const prefix = demoSlugPrefix(tenantCode);
  const products = await EcommerceProduct.find({ tenantId, slug: { $regex: `^${prefix}` } }).lean();
  const categories = await EcommerceCategory.find({ tenantId, slug: { $regex: `^${prefix}` } }).lean();
  const rates = await EcommerceGoldRate.find({ tenantId }).sort({ effectiveAt: -1 }).lean();
  const byPurity = {};
  for (const purity of ["18K", "22K", "24K"]) {
    byPurity[purity] = rates.find((r) => r.purity === purity)?.ratePerGramPaise ?? null;
  }
  let published = 0;
  let draft = 0;
  let archived = 0;
  let computable = 0;
  let withImages = 0;
  let goldSample = null;
  let fixedSample = null;
  for (const row of products) {
    if (row.status === EcommerceProductStatus.PUBLISHED) published += 1;
    else if (row.status === EcommerceProductStatus.ARCHIVED) archived += 1;
    else draft += 1;
    if (row.imageUploadIds?.length) withImages += 1;
    const rateRow =
      row.priceMode === EcommercePriceMode.GOLD_RATE_BASED
        ? rates.find((r) => r.purity === row.purity)
        : null;
    const estimate = computeProductPriceEstimate({ product: row, rateRow, taxSettings });
    if (estimate.computable) computable += 1;
    if (
      !goldSample
      && row.status === EcommerceProductStatus.PUBLISHED
      && row.priceMode === EcommercePriceMode.GOLD_RATE_BASED
      && estimate.computable
    ) {
      goldSample = {
        slug: row.slug,
        priceMode: row.priceMode,
        displayTotalPaise: estimate.displayTotalPaise,
        preTaxSubtotalPaise: estimate.preTaxSubtotalPaise,
        taxTotalPaise: estimate.tax?.totalPaise ?? null,
      };
    }
    if (
      !fixedSample
      && row.status === EcommerceProductStatus.PUBLISHED
      && row.priceMode === EcommercePriceMode.FIXED
      && estimate.computable
    ) {
      fixedSample = {
        slug: row.slug,
        priceMode: row.priceMode,
        displayTotalPaise: estimate.displayTotalPaise,
        preTaxSubtotalPaise: estimate.preTaxSubtotalPaise,
        taxTotalPaise: estimate.tax?.totalPaise ?? null,
      };
    }
  }
  const samples = [goldSample, fixedSample].filter(Boolean);
  const activeCategories = categories.filter((c) => c.active).length;
  const labelAudit = await auditDemoCatalogLabels(tenantId, tenantCode);
  return {
    tenantCode,
    tenantId,
    tax: {
      configured: Boolean((taxSettings?.rates ?? []).some((r) => r.active !== false)),
      defaultClassification: taxSettings?.defaultClassification ?? null,
      demoFixture: taxSettings?.defaultClassification === DEMO_TAX_CLASSIFICATION,
    },
    goldRatesPaisePerGram: byPurity,
    categories: { total: categories.length, active: activeCategories },
    products: { total: products.length, published, draft, archived, computable, withImages },
    labelAudit,
    priceSamples: samples,
  };
}

async function findTenantOwnerId(tenantId) {
  const owner = await User.findOne({
    tenantId,
    role: TenantRole.TENANT_OWNER,
    status: UserStatus.ACTIVE,
  })
    .select("_id")
    .lean();
  if (owner) return owner._id;
  const any = await User.findOne({ tenantId, status: UserStatus.ACTIVE }).select("_id").lean();
  return any?._id ?? "seed-ecommerce-demo";
}

async function buildAdminReq(tenantLean, actorUserId) {
  const withCatalog = await attachSubscriptionCatalogPlan(tenantLean);
  return {
    auth: { tenantId: tenantLean._id, id: actorUserId },
    tenant: withCatalog,
    body: {},
    query: {},
    params: {},
    headers: { "user-agent": "seed-ecommerce-demo" },
    ip: "127.0.0.1",
  };
}

async function countDemoRecords(tenantId, tenantCode) {
  const prefix = demoSlugPrefix(tenantCode);
  const [categories, products, rates] = await Promise.all([
    EcommerceCategory.countDocuments({ tenantId, slug: { $regex: `^${prefix}` } }),
    EcommerceProduct.countDocuments({ tenantId, slug: { $regex: `^${prefix}` } }),
    EcommerceGoldRate.countDocuments({ tenantId, enteredBy: DEMO_RATE_ENTERED_BY }),
  ]);
  return { categories, products, goldRatesBySeed: rates };
}

async function latestRatePaise(tenantId, purity) {
  const row = await EcommerceGoldRate.findOne({ tenantId, purity })
    .sort({ effectiveAt: -1, createdAt: -1 })
    .lean();
  return row?.ratePerGramPaise ?? null;
}

async function ensureGoldRatesForDemo(req, dryRun, report, puritiesNeeded) {
  const defaults = {
    [EcommerceGoldPurity["18K"]]: 6_200_00,
    [EcommerceGoldPurity["22K"]]: 7_200_00,
    [EcommerceGoldPurity["24K"]]: 7_800_00,
  };
  for (const purity of puritiesNeeded) {
    const existing = await latestRatePaise(req.auth.tenantId, purity);
    if (existing) {
      report.goldRates.push({ purity, action: "skipped_existing", ratePerGramPaise: existing });
      continue;
    }
    if (dryRun) {
      report.goldRates.push({ purity, action: "would_create", ratePerGramPaise: defaults[purity] });
      continue;
    }
    const created = await ecommerce.setEcommerceGoldRate({
      ...req,
      auth: { ...req.auth, id: DEMO_RATE_ENTERED_BY },
      body: {
        purity,
        ratePerGramPaise: defaults[purity],
        effectiveAt: new Date().toISOString(),
      },
    });
    report.goldRates.push({ purity, action: "created", id: created.id, ratePerGramPaise: defaults[purity] });
  }
}

async function upsertCategory(req, tenantCode, spec, dryRun, report) {
  const existing = await EcommerceCategory.findOne({
    tenantId: req.auth.tenantId,
    slug: spec.slug,
  }).lean();
  const body = {
    name: spec.name,
    slug: spec.slug,
    description: demoDescription(`${spec.name} — demo category for ${DEMO_SEED_TAG}.`),
    displayOrder: spec.displayOrder,
    active: spec.active,
  };
  if (existing) {
    if (!isDemoOwnedSlug(existing.slug, tenantCode)) {
      throw new Error(`Refusing to update non-demo category ${existing.slug}`);
    }
    if (dryRun) {
      report.categories.push({ key: spec.key, action: "would_update", id: existing._id, slug: spec.slug });
      return existing._id;
    }
    const patched = await ecommerce.patchCategory({
      ...req,
      params: { categoryId: existing._id },
      body: { ...body, expectedVersion: existing.version ?? 1 },
    });
    report.categories.push({ key: spec.key, action: "updated", id: patched.id, slug: spec.slug });
    return patched.id;
  }
  if (dryRun) {
    report.categories.push({ key: spec.key, action: "would_create", slug: spec.slug });
    return null;
  }
  const created = await ecommerce.createCategory({ ...req, body });
  report.categories.push({ key: spec.key, action: "created", id: created.id, slug: spec.slug });
  return created.id;
}

function productBodyFromSpec(spec, taxClassification) {
  const {
    key: _key,
    status: _status,
    inventory: _inventory,
    attachDemoImage: _attachDemoImage,
    ...rest
  } = spec;
  return {
    ...rest,
    description: demoDescription(rest.description ?? rest.name, _key),
    taxClassification: rest.taxClassification ?? taxClassification ?? undefined,
  };
}

async function archiveOrphanMislabeledDemoProducts(req, tenantCode, dryRun, report) {
  const audit = await auditDemoCatalogLabels(req.auth.tenantId, tenantCode);
  const orphans = [...audit.mislabeledSlug];
  if (!orphans.length) return;
  report.orphanMislabeledArchived = [];
  for (const { slug } of orphans) {
    const doc = await EcommerceProduct.findOne({ tenantId: req.auth.tenantId, slug }).lean();
    if (!doc || String(doc.description ?? "").includes("demo-product-key:")) continue;
    if (dryRun) {
      report.orphanMislabeledArchived.push({ slug, action: "would_archive" });
      continue;
    }
    await ecommerce.patchProduct({
      ...req,
      params: { productId: doc._id },
      body: { expectedVersion: doc.version ?? 1, status: EcommerceProductStatus.ARCHIVED },
    });
    report.orphanMislabeledArchived.push({ slug, action: "archived" });
  }
}

async function findDemoProductForSpec(tenantId, spec) {
  const bySlug = await EcommerceProduct.findOne({ tenantId, slug: spec.slug }).lean();
  if (bySlug) return bySlug;
  const marker = demoProductKeyMarker(spec.key);
  return EcommerceProduct.findOne({
    tenantId,
    description: { $regex: marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") },
  }).lean();
}

async function tryPublishDemoProduct(req, productId, reportEntry) {
  const fresh = await EcommerceProduct.findById(productId).lean();
  if (!fresh || fresh.status === EcommerceProductStatus.PUBLISHED) {
    if (fresh) reportEntry.status = fresh.status;
    return;
  }
  try {
    const published = await ecommerce.publishProduct({
      ...req,
      params: { productId },
      body: { expectedVersion: fresh.version ?? 1 },
    });
    reportEntry.status = published.status;
  } catch (err) {
    reportEntry.publishBlocked = {
      code: err.code,
      message: err.message,
      details: err.details,
    };
  }
}

async function upsertProduct(req, tenantCode, spec, taxClassification, dryRun, report) {
  const existing = await findDemoProductForSpec(req.auth.tenantId, spec);
  const createBody = productBodyFromSpec(spec, taxClassification);

  let productId = existing?._id;
  if (existing) {
    const slugOwned = isDemoOwnedSlug(existing.slug, tenantCode);
    const descOwned = String(existing.description ?? "").includes(DEMO_SEED_TAG);
    if (!slugOwned && !descOwned) {
      throw new Error(`Refusing to update non-demo product ${existing.slug}`);
    }
    if (dryRun) {
      report.products.push({ key: spec.key, action: "would_update", slug: spec.slug, id: existing._id });
    } else {
      const patchBody = {
        ...createBody,
        slug: spec.slug,
        sku: spec.sku,
        expectedVersion: existing.version ?? 1,
      };
      if (spec.status) patchBody.status = spec.status;
      const patched = await ecommerce.patchProduct({
        ...req,
        params: { productId: existing._id },
        body: patchBody,
      });
      productId = patched.id;
      const entry = { key: spec.key, action: "updated", slug: spec.slug, id: productId, status: patched.status };
      report.products.push(entry);
      if (spec.status === EcommerceProductStatus.PUBLISHED) {
        await tryPublishDemoProduct(req, productId, entry);
      } else if (spec.status === EcommerceProductStatus.ARCHIVED && entry.status !== "ARCHIVED") {
        const fresh = await EcommerceProduct.findById(productId).lean();
        await ecommerce.patchProduct({
          ...req,
          params: { productId },
          body: { expectedVersion: fresh.version ?? 1, status: EcommerceProductStatus.ARCHIVED },
        });
      }
    }
  } else if (dryRun) {
    report.products.push({ key: spec.key, action: "would_create", slug: spec.slug });
  } else {
    const created = await ecommerce.createProduct({ ...req, body: createBody });
    productId = created.id;
    const entry = { key: spec.key, action: "created", slug: spec.slug, id: productId, status: created.status };
    report.products.push(entry);
    if (spec.status === EcommerceProductStatus.PUBLISHED) {
      await tryPublishDemoProduct(req, productId, entry);
    } else if (spec.status === EcommerceProductStatus.ARCHIVED) {
      const fresh = await EcommerceProduct.findById(productId).lean();
      await ecommerce.patchProduct({
        ...req,
        params: { productId },
        body: { expectedVersion: fresh.version ?? 1, status: EcommerceProductStatus.ARCHIVED },
      });
      entry.status = EcommerceProductStatus.ARCHIVED;
    }
  }

  if (!dryRun && productId && spec.inventory) {
    await syncInventory(req, productId, spec.inventory, report, spec.key);
  } else if (dryRun && spec.inventory) {
    report.inventory.push({ productKey: spec.key, action: "would_sync", ...spec.inventory });
  }

  if (!dryRun && productId && spec.attachDemoImage) {
    try {
      const uploadId = await ensureDemoProductImageUpload({
        tenantId: req.auth.tenantId,
        ownerUserId: req.auth.id,
        productSlug: spec.slug,
      });
      const fresh = await EcommerceProduct.findById(productId).lean();
      const ids = [...new Set([...(fresh.imageUploadIds ?? []), uploadId])];
      await ecommerce.patchProduct({
        ...req,
        params: { productId },
        body: { expectedVersion: fresh.version ?? 1, imageUploadIds: ids },
      });
      report.images.seeded = true;
      report.images.uploadIds = [...(report.images.uploadIds ?? []), uploadId];
    } catch (err) {
      report.images.error = err.message;
    }
  }

  return productId;
}

async function syncInventory(req, productId, invSpec, report, productKey) {
  let detail = await adminCommerce.getAdminInventoryProduct({
    ...req,
    params: { productId },
  });
  if (detail.stockPolicy !== invSpec.policy || detail.inventoryId == null) {
    detail = await adminCommerce.patchAdminInventoryProduct({
      ...req,
      params: { productId },
      body: {
        expectedVersion: detail.version ?? 0,
        stockPolicy: invSpec.policy,
        quantityOnHand:
          invSpec.policy === EcommerceStockPolicy.QUANTITY_TRACKED ? (detail.quantityOnHand ?? 0) : undefined,
      },
    });
  }
  if (invSpec.policy === EcommerceStockPolicy.QUANTITY_TRACKED) {
    const target = invSpec.quantityOnHand ?? 0;
    const current = detail.quantityOnHand ?? 0;
    const delta = target - current;
    if (delta !== 0) {
      detail = await adminCommerce.adjustAdminInventoryProduct({
        ...req,
        params: { productId },
        body: {
          expectedVersion: detail.version ?? 1,
          deltaQuantity: delta,
          reason: DEMO_SEED_TAG,
        },
      });
    }
  }
  report.inventory.push({
    productKey,
    productId,
    stockPolicy: detail.stockPolicy,
    quantityOnHand: detail.quantityOnHand,
    availableQuantity: detail.availableQuantity,
  });
}

export async function collectTenantEntitlementReport(tenantLean) {
  const withCatalog = await attachSubscriptionCatalogPlan(tenantLean);
  const taxSettings = await loadTaxSettings(tenantLean._id);
  const { EcommerceFulfilmentSettings } = await import("../../src/models/index.js");
  const fulfilment = await EcommerceFulfilmentSettings.findOne({ tenantId: tenantLean._id }).lean();
  const access = presentEcommerceAccessState(withCatalog);
  const checkout = deriveEcommerceCheckoutCapability({
    taxSettings,
    fulfilmentSettingsRow: fulfilment,
    tenant: withCatalog,
  });
  return {
    tenantId: tenantLean._id,
    tenantCode: tenantLean.code,
    catalogWriteAllowed: isEcommerceCatalogWriteAllowed(withCatalog),
    storeOperational: isEcommerceOperational(withCatalog),
    ecommerce: access,
    checkoutTaxReady: checkout.checkoutTaxReady,
    paymentAllowed: checkout.paymentAllowed,
    checkoutBlockers: checkout.blockers,
    taxConfigured: Boolean((taxSettings?.rates ?? []).some((r) => r.active !== false)),
    defaultTaxClassification: taxSettings?.defaultClassification ?? null,
  };
}

export async function runEcommerceDemoSeed({
  tenantCodes,
  dryRun = true,
  dbLabel = null,
} = {}) {
  const codes = tenantCodes.map((c) => String(c).trim().toUpperCase());
  const summary = {
    dryRun,
    dbLabel,
    tenants: [],
    errors: [],
  };

  for (const code of codes) {
    const tenant = await Tenant.findOne({ code }).lean();
    if (!tenant) {
      summary.errors.push({ code, error: "TENANT_NOT_FOUND" });
      continue;
    }
    const beforeCounts = await countDemoRecords(tenant._id, code);
    const entitlement = await collectTenantEntitlementReport(tenant);
    const report = {
      tenantCode: code,
      tenantId: tenant._id,
      tenantName: tenant.name,
      beforeCounts,
      entitlement,
      categories: [],
      products: [],
      inventory: [],
      goldRates: [],
      images: {
        seeded: false,
        uploadIds: [],
        note: "Uses storage provider + Upload row (demo PNG fixture).",
      },
      afterCounts: null,
      storefrontPreview: null,
    };

    if (!entitlement.catalogWriteAllowed) {
      report.skipped = "FEATURE_NOT_ENTITLED_CATALOG";
      summary.tenants.push(report);
      continue;
    }

    const actorUserId = await findTenantOwnerId(tenant._id);
    const req = await buildAdminReq(tenant, actorUserId);
    report.labelAudit = await auditDemoCatalogLabels(tenant._id, code);

    const taxClassification = await ensureDemoDisplayTaxSettings(req, dryRun, report);
    await ensureDemoPickup(req, code, dryRun, report);
    await ensureDemoCheckoutTaxConfig(req, {
      dryRun,
      report,
      itemClassification: taxClassification ?? DEMO_TAX_CLASSIFICATION,
      registeredState: "Kerala",
    });
    await ensureDemoDelivery(req, dryRun, report);
    const taxSettings = await loadTaxSettings(tenant._id);
    if (!taxClassification) {
      report.taxWarning =
        "No usable ecommerce display tax classification; publish will fail until tax is configured.";
    }

    const categorySpecs = buildCategorySpecs(code);
    const categoryIds = {};
    for (const cSpec of categorySpecs) {
      const id = await upsertCategory(req, code, cSpec, dryRun, report);
      if (id) categoryIds[cSpec.key] = id;
    }

    if (dryRun) {
      categoryIds.featured = categoryIds.featured ?? "dry-run";
      categoryIds.rings = categoryIds.rings ?? "dry-run";
      categoryIds.chains = categoryIds.chains ?? "dry-run";
      categoryIds.inactive = categoryIds.inactive ?? "dry-run";
    }

    const productSpecs = buildProductSpecs(code, categoryIds, taxClassification);
    const purities = new Set(
      productSpecs
        .filter((p) => p.priceMode === EcommercePriceMode.GOLD_RATE_BASED && p.purity)
        .map((p) => p.purity),
    );
    await ensureGoldRatesForDemo(req, dryRun, report, [...purities]);

    for (const pSpec of productSpecs) {
      try {
        await upsertProduct(req, code, pSpec, taxClassification, dryRun, report);
      } catch (err) {
        report.products.push({
          key: pSpec.key,
          error: err.code ?? err.message,
          message: err.message,
        });
      }
    }

    await archiveOrphanMislabeledDemoProducts(req, code, dryRun, report);

    report.afterCounts = dryRun ? beforeCounts : await countDemoRecords(tenant._id, code);

    if (!dryRun && entitlement.storeOperational) {
      const published = await EcommerceProduct.find({
        tenantId: tenant._id,
        slug: { $regex: `^${demoSlugPrefix(code)}` },
        status: EcommerceProductStatus.PUBLISHED,
      }).lean();
      const shopVisible = [];
      for (const row of published) {
        const rateRow =
          row.priceMode === EcommercePriceMode.GOLD_RATE_BASED
            ? await EcommerceGoldRate.findOne({ tenantId: tenant._id, purity: row.purity })
                .sort({ effectiveAt: -1 })
                .lean()
            : null;
        const estimate = computeProductPriceEstimate({ product: row, rateRow, taxSettings });
        shopVisible.push({
          slug: row.slug,
          computable: estimate.computable,
          blockers: estimate.blockers?.map((b) => b.code),
        });
      }
      report.storefrontPreview = shopVisible;
    } else if (!entitlement.storeOperational) {
      report.storefrontPreview = {
        blocked: true,
        reason: "Store not operational (planEntitled/enabled); customer shop APIs will return ECOMMERCE_NOT_AVAILABLE.",
      };
    }

    if (!dryRun) {
      report.labelAudit = await auditDemoCatalogLabels(tenant._id, code);
      report.acceptance = await buildAcceptanceEvidence(tenant._id, code);
      const minPublished = 6;
      if (report.acceptance.products.published < minPublished) {
        const blocked = report.products
          .filter((p) => p.publishBlocked)
          .map((p) => ({ key: p.key, ...p.publishBlocked }));
        summary.errors.push({
          code,
          error: "DEMO_PUBLISH_INCOMPLETE",
          published: report.acceptance.products.published,
          required: minPublished,
          publishBlocked: blocked,
        });
      }
      if (report.labelAudit?.mislabeledSku?.length || report.labelAudit?.mislabeledSlug?.length) {
        summary.errors.push({
          code,
          error: "DEMO_CATALOG_MISLABELED",
          labelAudit: report.labelAudit,
        });
      }
    }

    summary.tenants.push(report);
  }

  return summary;
}

export function customerPortalPaths(tenantCode) {
  const slug = String(tenantCode).trim().toLowerCase();
  return {
    login: `/customer/${slug}/login`,
    shop: `/customer/${slug}/shop`,
    cart: `/customer/${slug}/shop/cart`,
  };
}

export function adminPortalPaths() {
  return {
    catalog: "/ecommerce",
    categories: "/ecommerce/categories",
    goldRates: "/ecommerce/gold-rates",
    tax: "/ecommerce/tax",
    inventory: "/ecommerce/inventory",
    orders: "/ecommerce/orders",
    settingsSubscription: "/settings/subscription",
  };
}
