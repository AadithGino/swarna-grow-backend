import mongoose from "mongoose";
import {
  EcommerceGoldPurity,
  EcommerceHsnSacType,
  EcommerceMakingChargeMode,
  EcommerceOfferType,
  EcommercePriceMode,
  EcommerceProductStatus,
  EcommerceBannerStatus,
  EcommerceBannerPlacement,
  EcommerceBannerDestination,
  EcommercePromotionCampaignStatus,
  EcommercePromotionKind,
} from "../constants/enums.js";
import {
  baseOptions,
  enumField,
  immutablePlugin,
  integerField,
  optionalIntegerField,
  branchField,
  stringId,
  tenantField,
  versionField,
} from "./schema-helpers.js";

const stoneLineSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 120 },
    chargePaise: integerField({ min: 0 }),
  },
  { _id: false },
);

const offerSchema = new mongoose.Schema(
  {
    type: enumField(EcommerceOfferType, { required: true }),
    valuePaise: optionalIntegerField({ min: 0 }),
    percentBps: optionalIntegerField({ min: 0, max: 10_000 }),
    startsAt: Date,
    endsAt: Date,
  },
  { _id: false },
);

const fixedPricingSchema = new mongoose.Schema(
  {
    basePricePaise: integerField({ min: 0 }),
    salePricePaise: optionalIntegerField({ min: 0 }),
    saleStartsAt: Date,
    saleEndsAt: Date,
  },
  { _id: false },
);

const makingChargeSchema = new mongoose.Schema(
  {
    fixedPaise: optionalIntegerField({ min: 0 }),
    perGramPaise: optionalIntegerField({ min: 0 }),
    percentBps: optionalIntegerField({ min: 0, max: 10_000 }),
  },
  { _id: false },
);

const categorySchema = new mongoose.Schema(
  {
    _id: stringId("ecat"),
    tenantId: tenantField,
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 4000 },
    imageUploadId: String,
    displayOrder: integerField({ default: 0 }),
    active: { type: Boolean, default: true },
    version: versionField,
  },
  baseOptions,
);
categorySchema.index({ tenantId: 1, slug: 1 }, { unique: true });
categorySchema.index({ tenantId: 1, active: 1, displayOrder: 1 });

const productSchema = new mongoose.Schema(
  {
    _id: stringId("eprd"),
    tenantId: tenantField,
    name: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, trim: true, maxlength: 120 },
    sku: { type: String, trim: true, maxlength: 64, default: "" },
    description: { type: String, default: "", maxlength: 8000 },
    categoryId: { type: String, index: true },
    imageUploadIds: { type: [String], default: [] },
    featured: { type: Boolean, default: false },
    status: enumField(EcommerceProductStatus, { default: EcommerceProductStatus.DRAFT }),
    purity: enumField(EcommerceGoldPurity),
    goldWeightMg: integerField({ min: 0 }),
    makingChargeMode: enumField(EcommerceMakingChargeMode),
    makingCharge: makingChargeSchema,
    stones: { type: [stoneLineSchema], default: [] },
    stoneChargePaise: optionalIntegerField({ min: 0 }),
    otherChargesPaise: optionalIntegerField({ min: 0 }),
    priceMode: enumField(EcommercePriceMode, { required: true }),
    fixedPricing: fixedPricingSchema,
    offer: offerSchema,
    taxClassification: { type: String, trim: true, maxlength: 64 },
    hsnSacCode: { type: String, trim: true, maxlength: 8 },
    hsnSacType: enumField(EcommerceHsnSacType),
    firstPublishedAt: Date,
    version: versionField,
  },
  baseOptions,
);
productSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
productSchema.index(
  { tenantId: 1, sku: 1 },
  {
    unique: true,
    partialFilterExpression: { sku: { $gt: "" } },
    name: "ecommerce_product_tenant_sku_unique",
  },
);
productSchema.index({ tenantId: 1, status: 1, featured: -1, updatedAt: -1 });
productSchema.index({ tenantId: 1, categoryId: 1, status: 1 });

const ecommerceGoldRateSchema = new mongoose.Schema(
  {
    _id: stringId("egrt"),
    tenantId: tenantField,
    purity: enumField(EcommerceGoldPurity, { required: true }),
    ratePerGramPaise: integerField({ required: true, min: 1 }),
    effectiveAt: { type: Date, required: true },
    enteredBy: String,
    version: versionField,
  },
  baseOptions,
);
ecommerceGoldRateSchema.plugin(immutablePlugin);
ecommerceGoldRateSchema.index({ tenantId: 1, purity: 1, effectiveAt: -1, createdAt: -1 });

const taxRateLineSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, maxlength: 32 },
    label: { type: String, trim: true, maxlength: 120 },
    rateBps: integerField({ required: true, min: 0, max: 10_000 }),
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

const hsnSacMappingSchema = new mongoose.Schema(
  {
    classification: { type: String, required: true, trim: true, maxlength: 64 },
    hsnSacCode: { type: String, required: true, trim: true, maxlength: 8 },
    hsnSacType: enumField(EcommerceHsnSacType, { required: true }),
  },
  { _id: false },
);

const taxSettingsSchema = new mongoose.Schema(
  {
    _id: stringId("etax"),
    tenantId: { type: String, required: true },
    defaultClassification: { type: String, trim: true, maxlength: 64 },
    rates: { type: [taxRateLineSchema], default: [] },
    hsnSacMappings: { type: [hsnSacMappingSchema], default: [] },
    version: versionField,
    updatedBy: String,
  },
  baseOptions,
);
taxSettingsSchema.index({ tenantId: 1 }, { unique: true, name: "ecommerce_tax_tenant_unique" });

const bannerSchema = new mongoose.Schema(
  {
    _id: stringId("ebnr"),
    tenantId: tenantField,
    title: { type: String, required: true, trim: true, maxlength: 120 },
    subtitle: { type: String, trim: true, maxlength: 200, default: "" },
    imageUploadId: String,
    placement: enumField(EcommerceBannerPlacement, { required: true }),
    displayOrder: integerField({ default: 0 }),
    status: enumField(EcommerceBannerStatus, { default: EcommerceBannerStatus.DRAFT }),
    destinationType: enumField(EcommerceBannerDestination, {
      default: EcommerceBannerDestination.NONE,
    }),
    targetCategoryId: String,
    targetProductId: String,
    startsAt: Date,
    endsAt: Date,
    version: versionField,
  },
  baseOptions,
);
bannerSchema.index({ tenantId: 1, status: 1, displayOrder: 1 });
bannerSchema.index({ tenantId: 1, placement: 1, status: 1, displayOrder: 1 });

const promotionCampaignSchema = new mongoose.Schema(
  {
    _id: stringId("epcm"),
    tenantId: tenantField,
    businessKey: { type: String, required: true, trim: true, maxlength: 200 },
    kind: enumField(EcommercePromotionKind, { required: true }),
    status: enumField(EcommercePromotionCampaignStatus, {
      default: EcommercePromotionCampaignStatus.QUEUED,
    }),
    productId: String,
    categoryId: String,
    broadcastId: String,
    title: { type: String, trim: true, maxlength: 120 },
    body: { type: String, trim: true, maxlength: 500 },
    deepLink: { type: String, trim: true, maxlength: 512 },
    audience: { type: String, enum: ["ALL_DEVICES", "BRANCH", "CUSTOMERS"], default: "ALL_DEVICES" },
    branchId: branchField,
    customerIds: { type: [String], default: [] },
    imageUploadId: String,
    scheduledFor: Date,
    offerRevision: { type: String, trim: true, maxlength: 128 },
    stats: {
      eligibleCustomers: integerField({ min: 0 }),
      messagesQueued: integerField({ min: 0 }),
      delivered: integerField({ min: 0 }),
      failed: integerField({ min: 0 }),
      pending: integerField({ min: 0 }),
    },
    requestedBy: { type: String, required: true },
    scopeBranchId: branchField,
    skippedReason: String,
    deliveryLeaseOwner: String,
    deliveryLeaseExpiresAt: Date,
    deliveryAttemptCount: integerField({ min: 0 }),
    titleOverridden: { type: Boolean, default: false },
    bodyOverridden: { type: Boolean, default: false },
    fanoutCompletedAt: Date,
    rateId: String,
    rateSource: { type: String, enum: ["SCHEME", "ECOMMERCE"] },
    purity: String,
    ratePerGramPaise: optionalIntegerField({ min: 0 }),
    schemeEffectiveDate: String,
    ecommerceEffectiveAt: Date,
    version: versionField,
  },
  baseOptions,
);
promotionCampaignSchema.index({ tenantId: 1, rateId: 1 });
promotionCampaignSchema.index({ tenantId: 1, businessKey: 1 }, { unique: true });
promotionCampaignSchema.index({ tenantId: 1, productId: 1, createdAt: -1 });
promotionCampaignSchema.index({ tenantId: 1, categoryId: 1, createdAt: -1 });
promotionCampaignSchema.index({ tenantId: 1, status: 1, scheduledFor: 1 });
promotionCampaignSchema.index({ tenantId: 1, status: 1, deliveryLeaseExpiresAt: 1 });
promotionCampaignSchema.index({ tenantId: 1, broadcastId: 1 });

export const EcommerceCategory = mongoose.model("EcommerceCategory", categorySchema);
export const EcommerceBanner = mongoose.model("EcommerceBanner", bannerSchema);
export const EcommerceProduct = mongoose.model("EcommerceProduct", productSchema);
export const EcommerceGoldRate = mongoose.model("EcommerceGoldRate", ecommerceGoldRateSchema);
export const EcommerceTaxSettings = mongoose.model("EcommerceTaxSettings", taxSettingsSchema);
export const EcommercePromotionCampaign = mongoose.model(
  "EcommercePromotionCampaign",
  promotionCampaignSchema,
);
