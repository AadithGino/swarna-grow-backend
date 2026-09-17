import mongoose from "mongoose";
import {
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
    targetCycle: String,
    isLateSuccess: { type: Boolean, default: false },
    lateSuccessDetectedVia: enumField(LateSuccessDetection),
    gatewayCompletedAt: Date,
    delayMinutes: integerField(),
    requiresReview: { type: Boolean, default: false },
    reviewReason: String,
  },
  baseOptions,
);
paymentSchema.index({ tenantId: 1, receiptNumber: 1 }, { unique: true });
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

export const Payment = mongoose.model("Payment", paymentSchema);
export const PaymentLink = mongoose.model("PaymentLink", paymentLinkSchema);
export const PaymentIntent = mongoose.model(
  "PaymentIntent",
  paymentIntentSchema,
);
