import mongoose from "mongoose";
import { AlertSeverity, AlertStatus, AlertType, CashAdjustmentDirection, CashHandoverStatus, ClosureType, ExportStatus, ExportType, HandoverInitiator, MessageChannel, MessageStatus, MessageType, RedemptionMode, RedemptionStatus, UploadPurpose, UploadStatus } from "../constants/enums.js";
import { baseOptions, branchField, enumField, immutablePlugin, integerField, stringId, tenantField, versionField } from "./schema-helpers.js";

const goldRateSchema = new mongoose.Schema({ _id: stringId("grt"), tenantId: tenantField, branchId: branchField, ratePerGramPaise: integerField({ required: true, min: 1 }), effectiveDate: { type: String, required: true }, purity: { type: String, default: "22K" }, source: String, enteredBy: String, version: versionField }, baseOptions);
// Multiple publishes per day are kept as immutable history; lookups take the latest by createdAt.
goldRateSchema.index({ tenantId: 1, branchId: 1, effectiveDate: 1, createdAt: -1 });
goldRateSchema.index({ tenantId: 1, effectiveDate: -1, createdAt: -1 });

const handoverSchema = new mongoose.Schema({
  _id: stringId("csh"), tenantId: tenantField, branchId: branchField, staffId: { type: String, required: true, index: true }, amountPaise: integerField({ required: true, min: 1 }),
  initiator: enumField(HandoverInitiator, { required: true }), status: enumField(CashHandoverStatus, { default: CashHandoverStatus.PENDING }), submittedAt: Date, settledAt: Date, settledBy: String, acceptedAmountPaise: integerField(), discrepancyPaise: integerField(), discrepancyDirection: String, reason: String, remarks: String, version: versionField,
}, baseOptions);
handoverSchema.index({ tenantId: 1, branchId: 1, status: 1, createdAt: -1 });

const redemptionSchema = new mongoose.Schema({
  _id: stringId("red"), tenantId: tenantField, branchId: branchField, schemeId: { type: String, required: true, index: true }, customerId: { type: String, required: true }, closureType: enumField(ClosureType, { required: true }), mode: enumField(RedemptionMode, { required: true }), status: enumField(RedemptionStatus, { default: RedemptionStatus.REQUESTED }),
  principalPaise: integerField(), benefitPaise: integerField(), benefitWeightMg: integerField(), benefitRatePerGramPaise: integerField(), penaltyPaise: integerField(), settlementPaise: integerField(), weightMg: integerField(),
  /** Cash physically paid out (CASH / purchase adjust / transfer). Zero for gold handover. */
  cashOutPaise: integerField(),
  /** Gold handover: rate locked at completion for reference valuation. */
  handoverRatePerGramPaise: integerField(),
  handoverRateEffectiveDate: String,
  /** Gold handover: weight × handover rate at completion (not cash out). */
  handoverValuePaise: integerField(),
  modeDetails: mongoose.Schema.Types.Mixed,
  requestedBy: String, approvedBy: String, completedBy: String, requestedAt: Date, approvedAt: Date, completedAt: Date, rejectionReason: String, version: versionField,
}, baseOptions);
redemptionSchema.index(
  { tenantId: 1, schemeId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: [RedemptionStatus.REQUESTED, RedemptionStatus.PENDING_APPROVAL, RedemptionStatus.APPROVED] } } },
);

const messageSchema = new mongoose.Schema({
  _id: stringId("msg"), tenantId: tenantField, branchId: branchField, customerId: String, schemeId: String, type: enumField(MessageType, { required: true }), status: enumField(MessageStatus, { default: MessageStatus.QUEUED }),
  channel: enumField(MessageChannel, { required: true }), templateKey: String, templateParams: mongoose.Schema.Types.Mixed, providerMessageId: String, attemptCount: integerField(), lastAttemptAt: Date, deliveredAt: Date, failedAt: Date, readAt: Date, failureCode: String, failureMessage: String,
}, baseOptions);
messageSchema.index({ tenantId: 1, status: 1, createdAt: -1 }); messageSchema.index({ providerMessageId: 1 }, { unique: true, sparse: true });

const uploadSchema = new mongoose.Schema({ _id: stringId("upl"), tenantId: tenantField, ownerId: String, purpose: enumField(UploadPurpose, { required: true }), fileName: String, contentType: String, sizeBytes: integerField(), objectKey: String, status: enumField(UploadStatus, { default: UploadStatus.PENDING }), expiresAt: Date, attachedEntityType: String, attachedEntityId: String, scannedAt: Date, scanProvider: String }, baseOptions);
uploadSchema.index({ tenantId: 1, attachedEntityType: 1, attachedEntityId: 1 });
const exportSchema = new mongoose.Schema({ _id: stringId("exp"), tenantId: tenantField, requestedBy: String, type: enumField(ExportType, { required: true }), status: enumField(ExportStatus, { default: ExportStatus.QUEUED }), filters: mongoose.Schema.Types.Mixed, objectKey: String, downloadExpiresAt: Date, rowCount: integerField(), error: String, auditResults: mongoose.Schema.Types.Mixed }, baseOptions);
const alertSchema = new mongoose.Schema({ _id: stringId("alt"), tenantId: tenantField, branchId: branchField, type: enumField(AlertType, { required: true }), severity: enumField(AlertSeverity, { default: AlertSeverity.WARNING }), status: enumField(AlertStatus, { default: AlertStatus.OPEN }), title: String, message: String, entityType: String, entityId: String, metadata: mongoose.Schema.Types.Mixed, dismissedAt: Date, dismissedBy: String }, baseOptions);
alertSchema.index({ tenantId: 1, status: 1, severity: 1, createdAt: -1 });
const cashAdjustmentSchema = new mongoose.Schema({ _id: stringId("cad"), tenantId: tenantField, branchId: branchField, staffId: { type: String, required: true, index: true }, direction: enumField(CashAdjustmentDirection, { required: true }), amountPaise: integerField({ required: true, min: 1 }), reason: { type: String, required: true }, createdBy: String }, baseOptions);
cashAdjustmentSchema.plugin(immutablePlugin);

export const GoldRate = mongoose.model("GoldRate", goldRateSchema);
export const CashHandover = mongoose.model("CashHandover", handoverSchema);
export const Redemption = mongoose.model("Redemption", redemptionSchema);
export const Message = mongoose.model("Message", messageSchema);
export const Upload = mongoose.model("Upload", uploadSchema);
export const ExportJob = mongoose.model("ExportJob", exportSchema);
export const Alert = mongoose.model("Alert", alertSchema);
export const CashAdjustment = mongoose.model("CashAdjustment", cashAdjustmentSchema);
