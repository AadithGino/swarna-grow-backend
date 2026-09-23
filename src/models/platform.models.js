import mongoose from "mongoose";
import { BillingCycle, InvoiceStatus, PlanTier } from "../constants/enums.js";
import { baseOptions, enumField, integerField, stringId, versionField } from "./schema-helpers.js";

const subscriptionPlanSchema = new mongoose.Schema({
  _id: stringId("subscriptionPlan"), tier: enumField(PlanTier, { required: true }), name: String, displayName: String,
  pricePaise: integerField(), monthlyPricePaise: integerField(), yearlyPricePaise: integerField(),
  trialDays: { type: Number, default: 0 }, highlighted: { type: Boolean, default: false }, sortOrder: { type: Number, default: 0 },
  priceLabel: String, billingCycle: enumField(BillingCycle), limits: mongoose.Schema.Types.Mixed,
  features: mongoose.Schema.Types.Mixed, displayFeatures: [mongoose.Schema.Types.Mixed],
  active: { type: Boolean, default: true }, version: versionField,
}, baseOptions);
subscriptionPlanSchema.index({ tier: 1, billingCycle: 1 }, { unique: true });
const templateDefinitionSchema = new mongoose.Schema({
  _id: stringId("tpl"), tenantId: { type: String, default: null, index: true }, messageType: { type: String, required: true },
  language: { type: String, default: "en" }, providerTemplateName: String, providerTemplateId: String, body: String,
  variables: [String], buttonUrlVariableKey: String, approvalStatus: String, active: { type: Boolean, default: true }, version: versionField,
}, baseOptions);
templateDefinitionSchema.index({ tenantId: 1, messageType: 1, language: 1 }, { unique: true });
const invoiceSchema = new mongoose.Schema({
  _id: stringId("inv"), tenantId: { type: String, required: true, index: true }, invoiceNumber: String,
  periodStart: String, periodEnd: String, lineItems: [{ description: String, amountPaise: integerField() }],
  subtotalPaise: integerField(), taxPercent: Number, taxPaise: integerField(), amountPaise: integerField(),
  status: enumField(InvoiceStatus, { default: InvoiceStatus.ISSUED }), dueDate: String, notes: String,
  pdfUrl: String, paidAt: Date, reference: String, version: versionField,
}, baseOptions);
invoiceSchema.index({ tenantId: 1, createdAt: -1 });
invoiceSchema.index(
  { invoiceNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      invoiceNumber: { $exists: true, $type: "string", $gt: "" },
    },
    name: "invoice_number_unique_nonempty",
  },
);

const subscriptionUpgradeRequestSchema = new mongoose.Schema({
  _id: stringId("upg"),
  tenantId: { type: String, required: true, index: true },
  requestedBy: String,
  targetTier: { type: String, required: true },
  billingCycle: { type: String, default: "MONTHLY" },
  note: String,
  status: { type: String, default: "PENDING_PLATFORM", index: true },
}, baseOptions);
subscriptionUpgradeRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export const SubscriptionPlan = mongoose.model("SubscriptionPlan", subscriptionPlanSchema);
export const TemplateDefinition = mongoose.model("TemplateDefinition", templateDefinitionSchema);
export const Invoice = mongoose.model("Invoice", invoiceSchema);
export const SubscriptionUpgradeRequest = mongoose.model(
  "SubscriptionUpgradeRequest",
  subscriptionUpgradeRequestSchema,
);

const appPlatformConfigSchema = new mongoose.Schema(
  {
    minimumVersion: { type: String, default: "1.0.0" },
    latestVersion: { type: String, default: "1.0.0" },
    forceUpdate: { type: Boolean, default: false },
    storeUrl: { type: String, default: null },
  },
  { _id: false },
);

const platformSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    appConfig: {
      android: { type: appPlatformConfigSchema, default: () => ({}) },
      ios: { type: appPlatformConfigSchema, default: () => ({}) },
      maintenance: {
        enabled: { type: Boolean, default: false },
        title: { type: String, default: null },
        message: { type: String, default: null },
      },
    },
    version: versionField,
  },
  baseOptions,
);

export const PlatformSettings = mongoose.model("PlatformSettings", platformSettingsSchema);
