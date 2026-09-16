import mongoose from "mongoose";
import { BillingCycle, InvoiceStatus, PlanTier } from "../constants/enums.js";
import { baseOptions, enumField, integerField, stringId, versionField } from "./schema-helpers.js";

const subscriptionPlanSchema = new mongoose.Schema({ _id: stringId("sub"), tier: enumField(PlanTier, { required: true }), name: String, pricePaise: integerField(), billingCycle: enumField(BillingCycle), limits: mongoose.Schema.Types.Mixed, features: [String], active: { type: Boolean, default: true }, version: versionField }, baseOptions);
subscriptionPlanSchema.index({ tier: 1, billingCycle: 1 }, { unique: true });
const templateDefinitionSchema = new mongoose.Schema({ _id: stringId("tpl"), tenantId: { type: String, default: null, index: true }, messageType: { type: String, required: true }, language: { type: String, default: "en" }, providerTemplateName: String, body: String, variables: [String], active: { type: Boolean, default: true }, version: versionField }, baseOptions);
templateDefinitionSchema.index({ tenantId: 1, messageType: 1, language: 1 }, { unique: true });
const invoiceSchema = new mongoose.Schema({ _id: stringId("inv"), tenantId: { type: String, required: true, index: true }, amountPaise: integerField(), status: enumField(InvoiceStatus, { default: InvoiceStatus.ISSUED }), dueDate: String, paidAt: Date, reference: String, version: versionField }, baseOptions);
invoiceSchema.index({ tenantId: 1, createdAt: -1 });

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
