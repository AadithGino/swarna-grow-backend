import mongoose from "mongoose";
import {
  GatewayRefundStatus,
  LateSuccessDetection,
  LinkStatus,
  PaymentIntentStatus,
  PaymentMode,
  PaymentSource,
  PaymentStatus,
} from "../constants/enums.js";
import {
  baseOptions,
  branchField,
  enumField,
  integerField,
  stringId,
  tenantField,
  versionField,
} from "./schema-helpers.js";

const paymentSchema = new mongoose.Schema(
  {
    _id: stringId("pay"),
    tenantId: tenantField,
    branchId: branchField,
    schemeId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    receiptNumber: { type: String, required: true },
    amountPaise: integerField({ required: true, min: 1 }),
    allocatedAmountPaise: integerField(),
    weightMg: integerField(),
    ratePerGramPaise: integerField(),
    mode: enumField(PaymentMode, { required: true }),
    status: enumField(PaymentStatus, { default: PaymentStatus.SUCCESS }),
    source: enumField(PaymentSource, { required: true }),
    reference: String,
    remarks: String,
    collectedBy: String,
    providerTransactionId: String,
    providerPayload: mongoose.Schema.Types.Mixed,
    paidAt: { type: Date, default: Date.now },
    reversedAt: Date,
    reversedBy: String,
    reversalReason: String,
    refundedAmountPaise: integerField({ default: 0, min: 0 }),
    gatewayRefundReservedPaise: integerField({ default: 0, min: 0 }),
    refundedWeightMg: integerField({ default: 0, min: 0 }),
    lastRefundedAt: Date,
    targetCycle: String,
    isLateSuccess: { type: Boolean, default: false },
    lateSuccessDetectedVia: enumField(LateSuccessDetection),
    gatewayCompletedAt: Date,
    delayMinutes: integerField(),
    requiresReview: { type: Boolean, default: false },
    reviewReason: String,
    gatewayReconcileAttempts: { type: Number, default: 0 },
    gatewayReconcileNextAt: Date,
    gatewayReconcileLeaseOwner: String,
    gatewayReconcileLeaseExpiresAt: Date,
    gatewayLastReconcileAt: Date,
    gatewayLastReconcileOutcome: String,
    gatewayLastReconcileError: String,
    gatewayLastProviderState: String,
  },
  baseOptions,
);
paymentSchema.index({ tenantId: 1, receiptNumber: 1 }, { unique: true });
paymentSchema.index({
  status: 1,
  mode: 1,
  gatewayReconcileNextAt: 1,
  _id: 1,
});
// Sparse still indexes explicit nulls; only index real provider txn ids.
paymentSchema.index(
  { tenantId: 1, providerTransactionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerTransactionId: { $type: "string", $gt: "" },
    },
  },
);
paymentSchema.index({ tenantId: 1, branchId: 1, paidAt: -1 });

const paymentLinkSchema = new mongoose.Schema(
  {
    _id: stringId("plk"),
    tenantId: tenantField,
    branchId: branchField,
    schemeId: String,
    customerId: String,
    tokenHash: { type: String, required: true, unique: true },
    amountPaise: integerField({ required: true, min: 1 }),
    targetCycle: String,
    paymentIntentId: String,
    positionVersion: integerField(),
    status: enumField(LinkStatus, { default: LinkStatus.CREATED }),
    expiresAt: { type: Date, required: true, index: true },
    openedAt: Date,
    paidAt: Date,
    paymentId: String,
    initiationClaimToken: String,
    initiationClaimExpiresAt: Date,
    createdBy: String,
  },
  baseOptions,
);

const paymentIntentSchema = new mongoose.Schema(
  {
    _id: stringId("pmi"),
    tenantId: tenantField,
    branchId: branchField,
    schemeId: String,
    customerId: String,
    targetCycle: String,
    amountPaise: integerField({ required: true, min: 1 }),
    positionVersion: integerField({ required: true, min: 1 }),
    reservationExpiresAt: Date,
    status: enumField(PaymentIntentStatus, {
      default: PaymentIntentStatus.PENDING,
    }),
    providerOrderId: String,
    paymentId: String,
    fixedFromInstallment: integerField({ min: 1, default: undefined }),
    fixedThroughInstallment: integerField({ min: 1, default: undefined }),
    version: versionField,
  },
  baseOptions,
);
paymentIntentSchema.index({
  tenantId: 1,
  schemeId: 1,
  targetCycle: 1,
  status: 1,
});
paymentIntentSchema.index({
  status: 1,
  reservationExpiresAt: 1,
  _id: 1,
});

const paymentRefundSchema = new mongoose.Schema(
  {
    _id: stringId("pref"),
    tenantId: tenantField,
    paymentId: { type: String, required: true, index: true },
    providerRefundId: String,
    providerEventId: String,
    amountPaise: integerField({ required: true, min: 1 }),
    status: enumField(GatewayRefundStatus, { default: GatewayRefundStatus.PENDING }),
    providerPayload: mongoose.Schema.Types.Mixed,
    completedAt: Date,
    failedAt: Date,
    requiresReview: { type: Boolean, default: false },
    reviewReason: String,
    idempotencyKey: String,
    reason: String,
    initiatedBy: String,
    providerInitiationAttempts: { type: Number, default: 0 },
    providerInitiationError: String,
    lastInitiationAt: Date,
    accountingClaimedAt: Date,
  },
  baseOptions,
);
paymentRefundSchema.index(
  { tenantId: 1, paymentId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: "string", $gt: "" },
    },
  },
);
paymentRefundSchema.index(
  { tenantId: 1, providerEventId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerEventId: { $type: "string", $gt: "" },
    },
  },
);
paymentRefundSchema.index(
  { tenantId: 1, providerRefundId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerRefundId: { $type: "string", $gt: "" },
    },
  },
);

export const Payment = mongoose.model("Payment", paymentSchema);
export const PaymentRefund = mongoose.model("PaymentRefund", paymentRefundSchema);
export const PaymentLink = mongoose.model("PaymentLink", paymentLinkSchema);
export const PaymentIntent = mongoose.model(
  "PaymentIntent",
  paymentIntentSchema,
);
