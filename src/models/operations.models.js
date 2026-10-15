import mongoose from "mongoose";
import { AlertSeverity, AlertStatus, AlertType, CashAdjustmentDirection, CashHandoverStatus, ClosureType, ExportStatus, ExportType, HandoverInitiator, JobStatus, MessageChannel, MessageStatus, MessageType, PostSettlementRefundCaseStatus, PostSettlementRefundDisposition, PushBroadcastSourceKind, RedemptionMode, RedemptionStatus, UploadPurpose, UploadStatus } from "../constants/enums.js";
import { baseOptions, branchField, enumField, immutablePlugin, integerField, optionalIntegerField, stringId, tenantField, versionField } from "./schema-helpers.js";

const goldRateSchema = new mongoose.Schema({ _id: stringId("grt"), tenantId: tenantField, branchId: branchField, ratePerGramPaise: integerField({ required: true, min: 1 }), effectiveDate: { type: String, required: true }, purity: { type: String, enum: ["22K"], default: "22K" }, source: String, enteredBy: String, version: versionField }, baseOptions);
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
  principalPaise: integerField(), benefitPaise: integerField(), calculatedBenefitPaise: optionalIntegerField(), includedBenefitPaise: optionalIntegerField(), benefitWeightMg: integerField(), benefitRatePerGramPaise: integerField(), penaltyPaise: integerField(), penaltyWeightMg: integerField(), settlementPaise: integerField(), weightMg: integerField(),
  /** Cash physically paid out (CASH / purchase adjust / transfer). Zero for gold handover. */
  cashOutPaise: integerField(),
  /** Gold handover: rate locked at completion for reference valuation. */
  handoverRatePerGramPaise: integerField(),
  handoverRateEffectiveDate: String,
  /** Gold handover: weight × handover rate at completion (not cash out). */
  handoverValuePaise: integerField(),
  /** Cash-value gold handover: settlementPaise − handoverValuePaise (rounding at weight precision). Disclosure only. */
  roundingDeltaPaise: integerField(),
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
  dispatchPriority: { type: Number, default: 0 },
  /** @deprecated use dispatchState / dispatchedAt — kept for mixed-version reads only */
  enqueuedAt: Date,
  dispatchState: String,
  dispatchLeaseOwner: String,
  dispatchLeaseExpiresAt: Date,
  dispatchAttemptCount: { type: Number, default: 0 },
  lastDispatchAttemptAt: Date,
  dispatchedAt: Date,
  broadcastIdempotencyKey: String,
  reminderDedupeKey: String,
}, baseOptions);
messageSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
messageSchema.index({ tenantId: 1, "templateParams.broadcastId": 1, createdAt: -1 });
messageSchema.index({ providerMessageId: 1 }, { unique: true, sparse: true });
messageSchema.index({ status: 1, dispatchPriority: 1, createdAt: 1 });
messageSchema.index({ status: 1, enqueuedAt: 1, createdAt: 1 });
messageSchema.index({ status: 1, dispatchState: 1, dispatchLeaseExpiresAt: 1, dispatchPriority: 1, createdAt: 1 });
messageSchema.index({ status: 1, dispatchState: 1, dispatchedAt: 1 });
messageSchema.index({ tenantId: 1, status: 1, dispatchState: 1, dispatchPriority: 1, createdAt: 1 });
messageSchema.index(
  { tenantId: 1, broadcastIdempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { broadcastIdempotencyKey: { $type: "string" } },
  },
);
messageSchema.index({ tenantId: 1, status: 1, branchId: 1, customerId: 1, _id: 1 });
messageSchema.index(
  { tenantId: 1, reminderDedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { reminderDedupeKey: { $type: "string" } },
  },
);
messageSchema.index({ tenantId: 1, customerId: 1, channel: 1, createdAt: -1 });

const pushBroadcastSchema = new mongoose.Schema({
  _id: stringId("pbc"),
  tenantId: tenantField,
  branchId: branchField,
  requestedBy: { type: String, required: true },
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true, trim: true },
  deepLink: { type: String, default: "/home" },
  imageUploadId: String,
  messageType: enumField(MessageType, { default: MessageType.MANUAL_PUSH }),
  sourceKind: enumField(PushBroadcastSourceKind, { default: PushBroadcastSourceKind.MANUAL }),
  productId: String,
  categoryId: String,
  campaignBusinessKey: String,
  promotionKind: String,
  rateId: String,
  rateSource: String,
  ratePurity: String,
  ratePerGramPaise: optionalIntegerField({ min: 0 }),
  schemeEffectiveDate: String,
  ecommerceEffectiveAt: Date,
  imageSourceUploadId: String,
  audience: { type: String, enum: ["ALL_DEVICES", "BRANCH", "CUSTOMERS"], required: true },
  customerIds: { type: [String], default: [] },
  status: enumField(JobStatus, { default: JobStatus.QUEUED }),
  stats: {
    audienceCount: integerField(),
    messagesQueued: integerField(),
    delivered: integerField(),
    failed: integerField(),
  },
  cursorCustomerId: String,
  fanoutContinuationPending: { type: Boolean, default: false },
  chunkAttempts: integerField({ min: 0 }),
  leaseOwner: String,
  leaseExpiresAt: Date,
  pushImageUrl: String,
  pushImageUrlValidUntil: Date,
  error: String,
  startedAt: Date,
  completedAt: Date,
}, baseOptions);
pushBroadcastSchema.index({ tenantId: 1, createdAt: -1 });
pushBroadcastSchema.index({ tenantId: 1, status: 1 });
pushBroadcastSchema.index({ tenantId: 1, status: 1, leaseExpiresAt: 1 });
pushBroadcastSchema.index({ status: 1, fanoutContinuationPending: 1, leaseExpiresAt: 1 });
pushBroadcastSchema.index({ tenantId: 1, status: 1, branchId: 1, cursorCustomerId: 1 });
pushBroadcastSchema.index(
  { tenantId: 1, campaignBusinessKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      campaignBusinessKey: { $type: "string" },
      sourceKind: {
        $in: [
          PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
          PushBroadcastSourceKind.GOLD_RATE_NOTIFICATION,
        ],
      },
    },
  },
);

const uploadSchema = new mongoose.Schema({ _id: stringId("upl"), tenantId: tenantField, ownerId: String, purpose: enumField(UploadPurpose, { required: true }), fileName: String, contentType: String, sizeBytes: integerField(), objectKey: String, status: enumField(UploadStatus, { default: UploadStatus.PENDING }), expiresAt: Date, attachedEntityType: String, attachedEntityId: String, scannedAt: Date, scanProvider: String }, baseOptions);
uploadSchema.index({ tenantId: 1, attachedEntityType: 1, attachedEntityId: 1 });
const exportSchema = new mongoose.Schema({ _id: stringId("exp"), tenantId: tenantField, requestedBy: String, type: enumField(ExportType, { required: true }), status: enumField(ExportStatus, { default: ExportStatus.QUEUED }), scopeSnapshot: { tenantId: String, branchId: { type: String, default: null } }, filters: mongoose.Schema.Types.Mixed, objectKey: String, downloadExpiresAt: Date, rowCount: integerField(), error: String, auditResults: mongoose.Schema.Types.Mixed }, baseOptions);
exportSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
exportSchema.index({ status: 1, updatedAt: 1 });
const alertSchema = new mongoose.Schema({ _id: stringId("alt"), tenantId: tenantField, branchId: branchField, type: enumField(AlertType, { required: true }), severity: enumField(AlertSeverity, { default: AlertSeverity.WARNING }), status: enumField(AlertStatus, { default: AlertStatus.OPEN }), title: String, message: String, entityType: String, entityId: String, metadata: mongoose.Schema.Types.Mixed, dismissedAt: Date, dismissedBy: String, resolvedAt: Date }, baseOptions);
alertSchema.index({ tenantId: 1, status: 1, severity: 1, createdAt: -1 });
alertSchema.index(
  { tenantId: 1, type: 1, entityId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: AlertStatus.OPEN },
    name: "alert_open_tenant_type_entity_unique",
  },
);
const cashAdjustmentSchema = new mongoose.Schema({ _id: stringId("cad"), tenantId: tenantField, branchId: branchField, staffId: { type: String, required: true, index: true }, direction: enumField(CashAdjustmentDirection, { required: true }), amountPaise: integerField({ required: true, min: 1 }), reason: { type: String, required: true }, createdBy: String }, baseOptions);
cashAdjustmentSchema.plugin(immutablePlugin);

/** Serializes concurrent cash handovers/adjustments per staff custody position. */
const cashStaffCustodySchema = new mongoose.Schema({
  _id: stringId("csc"),
  tenantId: tenantField,
  branchId: branchField,
  staffId: { type: String, required: true },
  version: versionField,
}, baseOptions);
cashStaffCustodySchema.index({ tenantId: 1, branchId: 1, staffId: 1 }, { unique: true });

const postSettlementRefundCaseSchema = new mongoose.Schema({
  _id: stringId("psrc"),
  tenantId: tenantField,
  branchId: branchField,
  paymentRefundId: { type: String, required: true },
  providerRefundId: String,
  schemeId: { type: String, required: true, index: true },
  paymentId: { type: String, required: true },
  customerId: { type: String, required: true },
  redemptionId: String,
  refundAmountPaise: integerField({ required: true, min: 1 }),
  refundWeightMg: integerField(),
  refundCompletedAt: { type: Date, required: true },
  settlementSnapshot: mongoose.Schema.Types.Mixed,
  status: enumField(PostSettlementRefundCaseStatus, { default: PostSettlementRefundCaseStatus.PENDING_RESOLUTION }),
  disposition: enumField(PostSettlementRefundDisposition),
  resolutionReason: String,
  resolvedBy: String,
  resolvedAt: Date,
  version: versionField,
}, baseOptions);
postSettlementRefundCaseSchema.index({ tenantId: 1, paymentRefundId: 1 }, { unique: true });
postSettlementRefundCaseSchema.index({ tenantId: 1, status: 1, refundCompletedAt: -1 });

export const GoldRate = mongoose.model("GoldRate", goldRateSchema);
export const CashHandover = mongoose.model("CashHandover", handoverSchema);
export const Redemption = mongoose.model("Redemption", redemptionSchema);
export const Message = mongoose.model("Message", messageSchema);
export const PushBroadcast = mongoose.model("PushBroadcast", pushBroadcastSchema);
export const Upload = mongoose.model("Upload", uploadSchema);
export const ExportJob = mongoose.model("ExportJob", exportSchema);
export const Alert = mongoose.model("Alert", alertSchema);
export const CashAdjustment = mongoose.model("CashAdjustment", cashAdjustmentSchema);
export const CashStaffCustody = mongoose.model("CashStaffCustody", cashStaffCustodySchema);
export const PostSettlementRefundCase = mongoose.model("PostSettlementRefundCase", postSettlementRefundCaseSchema);
