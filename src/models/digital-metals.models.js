import mongoose from "mongoose";
import {
  baseOptions,
  enumField,
  immutablePlugin,
  integerField,
  stringId,
  tenantField,
  versionField,
} from "./schema-helpers.js";

export const DigitalMetalKind = { GOLD: "GOLD", SILVER: "SILVER" };

/** Published customer rate validity window unless overridden per asset in settings. */
export const DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS = 86_400;

const feeRuleSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["NONE", "FLAT_INR", "PERCENT"], default: "NONE" },
    amountPaise: integerField({ min: 0 }),
    percent: { type: Number, min: 0, max: 100 },
    minPaise: integerField({ min: 0 }),
    maxPaise: integerField({ min: 0 }),
  },
  { _id: false },
);

const taxLineSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, maxlength: 32 },
    label: { type: String, trim: true, maxlength: 120 },
    base: {
      type: String,
      enum: ["METAL_SUBTOTAL", "FEE", "MINTING", "DELIVERY", "TOTAL_EXGST"],
      default: "METAL_SUBTOTAL",
    },
    ratePercent: { type: Number, required: true, min: 0, max: 100 },
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

const digitalMetalSettingsVersionSchema = new mongoose.Schema(
  {
    _id: stringId("dmsv"),
    tenantId: tenantField,
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true, min: 1 }),
    version: versionField,
    buyFee: { type: feeRuleSchema, default: () => ({ type: "NONE" }) },
    sellFee: { type: feeRuleSchema, default: () => ({ type: "NONE" }) },
    taxLines: { type: [taxLineSchema], default: [] },
    quoteTtlSeconds: { type: Number, default: 900, min: 60, max: 86_400 },
    sellQuoteTtlSeconds: { type: Number, default: 900, min: 60, max: 86_400 },
    sellApprovalTtlSeconds: { type: Number, default: 1800, min: 60, max: 86_400 },
    rateMaxAgeSeconds: {
      type: Number,
      default: DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS,
      min: 60,
      max: 86_400,
    },
    /** Not enforced in v1 — rejected on patch if set. */
    exposureCapPaise: { type: Number, default: null },
    holdingPeriodDays: { type: Number, default: 0, min: 0, max: 3650 },
    enteredBy: String,
  },
  baseOptions,
);
digitalMetalSettingsVersionSchema.plugin(immutablePlugin);
digitalMetalSettingsVersionSchema.index(
  { tenantId: 1, metal: 1, finenessPpm: 1, version: -1 },
  { unique: true },
);

const digitalMetalRateVersionSchema = new mongoose.Schema(
  {
    _id: stringId("dmrv"),
    tenantId: tenantField,
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true, min: 1 }),
    customerBuyRatePerGramPaise: integerField({ required: true, min: 1 }),
    customerSellRatePerGramPaise: integerField({ required: true, min: 1 }),
    effectiveAt: { type: Date, required: true },
    publishedAt: { type: Date, required: true },
    sequence: integerField({ required: true, min: 1 }),
    source: { type: String, default: "MANUAL" },
    enteredBy: String,
  },
  baseOptions,
);
digitalMetalRateVersionSchema.plugin(immutablePlugin);
digitalMetalRateVersionSchema.index({ tenantId: 1, metal: 1, finenessPpm: 1, effectiveAt: -1, createdAt: -1 });
digitalMetalRateVersionSchema.index(
  { tenantId: 1, metal: 1, finenessPpm: 1, sequence: 1 },
  { unique: true },
);

const digitalMetalQuoteSchema = new mongoose.Schema(
  {
    _id: stringId("dmq"),
    tenantId: tenantField,
    side: { type: String, enum: ["BUY", "SELL", "REDEMPTION"], required: true },
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true }),
    inputMode: { type: String, enum: ["BUDGET_INR", "QUANTITY_UG"] },
    snapshot: mongoose.Schema.Types.Mixed,
    expiresAt: { type: Date, required: true },
    settingsVersionId: String,
    rateVersionId: String,
    termsVersion: String,
    calculationVersion: String,
    createdBySubject: String,
    customerId: { type: String, default: null, index: true },
    quoteSource: {
      type: String,
      enum: ["ADMIN_PREVIEW", "CUSTOMER"],
      default: "ADMIN_PREVIEW",
    },
    taxProfileFingerprint: { type: String, default: "" },
    termsContentHash: { type: String, default: "" },
    consumedAt: { type: Date, default: null },
    consumedByOrderId: { type: String, default: null },
  },
  baseOptions,
);
digitalMetalQuoteSchema.index({ tenantId: 1, createdAt: -1 });
digitalMetalQuoteSchema.index({ tenantId: 1, customerId: 1, createdAt: -1 });

const digitalMetalTermsPublicationSchema = new mongoose.Schema(
  {
    _id: stringId("dmtp"),
    tenantId: tenantField,
    termsVersion: { type: String, required: true, trim: true, maxlength: 64 },
    contentHash: { type: String, required: true, maxlength: 128 },
    /** Immutable terms body snapshot (server-stored); hash is derived from this + version. */
    contentSnapshot: { type: String, required: true, maxlength: 65_536 },
    contentRef: { type: String, default: "", maxlength: 512 },
    publishedAt: { type: Date, required: true },
    publishedBy: String,
    active: { type: Boolean, default: true },
  },
  baseOptions,
);
digitalMetalTermsPublicationSchema.plugin(immutablePlugin);
digitalMetalTermsPublicationSchema.index({ tenantId: 1, termsVersion: 1 }, { unique: true });

const digitalMetalWalletSchema = new mongoose.Schema(
  {
    _id: stringId("dmw"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    branchId: { type: String, default: null, index: true },
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true, min: 1 }),
    heldUg: integerField({ default: 0, min: 0 }),
    reservedUg: integerField({ default: 0, min: 0 }),
    pendingBuyUg: integerField({ default: 0, min: 0 }),
    journalSequence: integerField({ default: 0, min: 0 }),
    projectionVersion: integerField({ default: 1, min: 1 }),
  },
  baseOptions,
);
digitalMetalWalletSchema.index(
  { tenantId: 1, customerId: 1, metal: 1, finenessPpm: 1 },
  { unique: true },
);

const digitalMetalLotSchema = new mongoose.Schema(
  {
    _id: stringId("dmlot"),
    tenantId: tenantField,
    walletId: { type: String, required: true, index: true },
    quantityUg: integerField({ required: true, min: 1 }),
    remainingUg: integerField({ required: true, min: 0 }),
    acquiredAt: { type: Date, required: true },
    costBasisPaisePerGram: integerField({ min: 0 }),
    sourceJournalId: String,
  },
  baseOptions,
);
digitalMetalLotSchema.index({ tenantId: 1, walletId: 1, acquiredAt: 1 });

const digitalMetalJournalSchema = new mongoose.Schema(
  {
    _id: stringId("dmj"),
    tenantId: tenantField,
    walletId: { type: String, required: true, index: true },
    sequence: integerField({ required: true, min: 1 }),
    entryType: {
      type: String,
      enum: ["CREDIT", "DEBIT", "RESERVE", "RELEASE", "REVERSAL"],
      required: true,
    },
    quantityUgDelta: integerField({ required: true }),
    reservedUgDelta: integerField({ default: 0 }),
    idempotencyKey: { type: String, required: true, trim: true },
    referenceType: String,
    referenceId: String,
    reversalOfJournalId: String,
    metadata: mongoose.Schema.Types.Mixed,
  },
  baseOptions,
);
digitalMetalJournalSchema.plugin(immutablePlugin);
digitalMetalJournalSchema.index({ tenantId: 1, walletId: 1, sequence: 1 }, { unique: true });
digitalMetalJournalSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });

const digitalMetalReservationSchema = new mongoose.Schema(
  {
    _id: stringId("dmrsv"),
    tenantId: tenantField,
    walletId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true }),
    purpose: { type: String, enum: ["SELL", "REDEMPTION"], required: true },
    status: {
      type: String,
      enum: ["ACTIVE", "COMMITTED", "RELEASED", "CANCELLED"],
      default: "ACTIVE",
    },
    quantityUg: integerField({ required: true, min: 1 }),
    lotAllocations: [
      {
        lotId: String,
        quantityUg: integerField({ min: 1 }),
      },
    ],
    idempotencyKey: { type: String, required: true, trim: true },
  },
  baseOptions,
);
digitalMetalReservationSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
digitalMetalReservationSchema.index({ tenantId: 1, walletId: 1, status: 1 });

/** Phase 1 marker: customer has holdings/settlement/fulfilment history (Phase 3+ writers). */
const digitalMetalAccessMarkerSchema = new mongoose.Schema(
  {
    _id: stringId("dmam"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    kinds: { type: [String], default: [] },
  },
  baseOptions,
);
digitalMetalAccessMarkerSchema.index({ tenantId: 1, customerId: 1 }, { unique: true });

export const DigitalMetalAccessMarker = mongoose.model(
  "DigitalMetalAccessMarker",
  digitalMetalAccessMarkerSchema,
);

export const DigitalMetalSettingsVersion = mongoose.model(
  "DigitalMetalSettingsVersion",
  digitalMetalSettingsVersionSchema,
);

export const DigitalMetalRateVersion = mongoose.model(
  "DigitalMetalRateVersion",
  digitalMetalRateVersionSchema,
);

export const DigitalMetalQuote = mongoose.model(
  "DigitalMetalQuote",
  digitalMetalQuoteSchema,
);

export const DigitalMetalTermsPublication = mongoose.model(
  "DigitalMetalTermsPublication",
  digitalMetalTermsPublicationSchema,
);

export const DigitalMetalWallet = mongoose.model("DigitalMetalWallet", digitalMetalWalletSchema);
export const DigitalMetalLot = mongoose.model("DigitalMetalLot", digitalMetalLotSchema);
export const DigitalMetalJournal = mongoose.model("DigitalMetalJournal", digitalMetalJournalSchema);
export const DigitalMetalReservation = mongoose.model(
  "DigitalMetalReservation",
  digitalMetalReservationSchema,
);

const digitalMetalBuyOrderSchema = new mongoose.Schema(
  {
    _id: stringId("dmbo"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    branchId: { type: String, default: null, index: true },
    quoteId: { type: String, required: true },
    status: {
      type: String,
      enum: [
        "QUOTE_ACCEPTED",
        "PAYMENT_PENDING",
        "PAYMENT_VERIFIED",
        "CREDITED",
        "EXPIRED",
        "PAYMENT_FAILED",
        "REFUND_REVIEW",
        "REFUNDED",
      ],
      default: "QUOTE_ACCEPTED",
    },
    snapshot: mongoose.Schema.Types.Mixed,
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true }),
    quantityUg: integerField({ required: true, min: 1 }),
    totalPayablePaise: integerField({ required: true, min: 1 }),
    quoteExpiresAt: { type: Date, required: true },
    paymentAcceptanceExpiresAt: { type: Date, required: true },
    termsVersion: String,
    termsContentHash: String,
    taxProfileFingerprint: String,
    termsAcceptedAt: { type: Date, required: true },
    successfulPaymentAttemptId: { type: String, default: null },
    creditJournalId: { type: String, default: null },
    creditedAt: { type: Date, default: null },
    purchaseCreditedNoticeEnqueuedAt: { type: Date, default: null },
    invoiceStatus: { type: String, enum: ["PENDING", "READY", "FAILED"], default: "PENDING" },
    invoiceUploadId: { type: String, default: null },
    invoiceReadyAt: { type: Date, default: null },
    paymentExceptionStatus: { type: String, default: null },
    paymentExceptionPayload: mongoose.Schema.Types.Mixed,
    idempotencyKey: { type: String, required: true, trim: true },
    creationBodyHash: { type: String, default: null, trim: true, maxlength: 64 },
    version: versionField,
  },
  baseOptions,
);
digitalMetalBuyOrderSchema.index({ tenantId: 1, customerId: 1, createdAt: -1 });
digitalMetalBuyOrderSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
digitalMetalBuyOrderSchema.index({ tenantId: 1, quoteId: 1 }, { unique: true });

const digitalMetalBuyPaymentAttemptSchema = new mongoose.Schema(
  {
    _id: stringId("dmpay"),
    tenantId: tenantField,
    orderId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["PENDING", "INITIATED", "SUCCEEDED", "FAILED"],
      default: "PENDING",
    },
    amountPaise: integerField({ required: true, min: 1 }),
    currency: { type: String, default: "INR" },
    provider: { type: String, default: "PHONEPE" },
    checkoutMode: {
      type: String,
      enum: ["LIVE", "MOCK_PROVIDER", "DIGITAL_METALS_DEMO", null],
      default: null,
    },
    merchantOrderId: { type: String, required: true },
    providerOrderId: { type: String, default: null },
    sdkToken: { type: String, default: null },
    redirectUrl: { type: String, default: null },
    providerPaymentId: { type: String, default: null },
    providerPayload: mongoose.Schema.Types.Mixed,
    failureReason: { type: String, default: null },
    idempotencyKey: { type: String, required: true, trim: true },
    creationBodyHash: { type: String, default: null },
    initiationClaimToken: { type: String, default: null },
    initiationClaimExpiresAt: { type: Date, default: null },
    gatewayReconcileNextAt: { type: Date, default: null },
    gatewayReconcileLeaseOwner: { type: String, default: null },
    gatewayReconcileLeaseExpiresAt: { type: Date, default: null },
    gatewayReconcileAttempts: { type: Number, default: 0 },
    version: versionField,
  },
  baseOptions,
);
digitalMetalBuyPaymentAttemptSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
digitalMetalBuyPaymentAttemptSchema.index({ tenantId: 1, orderId: 1, status: 1 });

const digitalMetalOutboxEventSchema = new mongoose.Schema(
  {
    _id: stringId("dmobx"),
    tenantId: tenantField,
    topic: { type: String, required: true },
    key: { type: String, required: true },
    payload: mongoose.Schema.Types.Mixed,
    status: { type: String, enum: ["PENDING", "PROCESSING", "PROCESSED", "FAILED"], default: "PENDING" },
    processedAt: { type: Date, default: null },
    dispatchLeaseOwner: { type: String, default: null },
    dispatchLeaseExpiresAt: { type: Date, default: null },
    dispatchAttempts: { type: Number, default: 0 },
    availableAt: { type: Date, default: Date.now },
    lastError: { type: String, default: null },
    processedOutcome: { type: String, default: null },
    processedDisposition: {
      type: String,
      enum: ["COMPLETED", "SKIPPED", "RETRYABLE", "TERMINAL", null],
      default: null,
    },
    processedSkipReason: { type: String, default: null },
  },
  baseOptions,
);
digitalMetalOutboxEventSchema.index({ tenantId: 1, topic: 1, status: 1 });
digitalMetalOutboxEventSchema.index({ status: 1, availableAt: 1, dispatchLeaseExpiresAt: 1 });
digitalMetalOutboxEventSchema.index({ tenantId: 1, topic: 1, key: 1 }, { unique: true });

/** Advancing scan cursors for missing notification-intent repair (global worker). */
const digitalMetalNotificationIntentRepairCursorSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    sortAt: { type: Date, default: () => new Date(0) },
    tieId: { type: String, default: "" },
    version: { type: Number, default: 0 },
  },
  baseOptions,
);

const digitalMetalPaymentExceptionRefundSchema = new mongoose.Schema(
  {
    _id: stringId("dmref"),
    tenantId: tenantField,
    orderId: { type: String, required: true, index: true },
    paymentAttemptId: { type: String, required: true },
    merchantOrderId: { type: String, required: true },
    amountPaise: integerField({ required: true, min: 1 }),
    exceptionType: {
      type: String,
      enum: ["LATE_SUCCESS", "DUPLICATE_PAYMENT", "CHARGEBACK", "MANUAL"],
      required: true,
    },
    status: {
      type: String,
      enum: ["ASSIGNED", "INITIATED", "PROVIDER_PENDING", "SUCCEEDED", "FAILED", "MANUAL_RECORDED"],
      default: "ASSIGNED",
    },
    providerRefundId: { type: String, default: null },
    providerPayload: mongoose.Schema.Types.Mixed,
    assignedUserId: { type: String, default: null },
    version: versionField,
  },
  baseOptions,
);
digitalMetalPaymentExceptionRefundSchema.index({ tenantId: 1, orderId: 1 }, { unique: true });
digitalMetalPaymentExceptionRefundSchema.index({ tenantId: 1, providerRefundId: 1 }, { sparse: true });

export const DigitalMetalBuyOrder = mongoose.model(
  "DigitalMetalBuyOrder",
  digitalMetalBuyOrderSchema,
);
export const DigitalMetalBuyPaymentAttempt = mongoose.model(
  "DigitalMetalBuyPaymentAttempt",
  digitalMetalBuyPaymentAttemptSchema,
);
export const DigitalMetalOutboxEvent = mongoose.model(
  "DigitalMetalOutboxEvent",
  digitalMetalOutboxEventSchema,
);
export const DigitalMetalNotificationIntentRepairCursor = mongoose.model(
  "DigitalMetalNotificationIntentRepairCursor",
  digitalMetalNotificationIntentRepairCursorSchema,
);
export const DigitalMetalPaymentExceptionRefund = mongoose.model(
  "DigitalMetalPaymentExceptionRefund",
  digitalMetalPaymentExceptionRefundSchema,
);

const digitalMetalDocumentArtifactSchema = new mongoose.Schema(
  {
    _id: stringId("dmdoc"),
    tenantId: tenantField,
    docType: {
      type: String,
      enum: [
        "REDEMPTION_CHARGE_RECEIPT",
        "HANDOVER_RECEIPT",
        "SELL_ACKNOWLEDGEMENT",
        "PAYOUT_RECEIPT",
        "METAL_STATEMENT",
      ],
      required: true,
    },
    subjectKey: { type: String, required: true, trim: true },
    customerId: { type: String, default: null },
    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "READY", "FAILED"],
      default: "PENDING",
    },
    documentNumber: { type: String, default: null },
    uploadId: { type: String, default: null },
    sourceSnapshot: mongoose.Schema.Types.Mixed,
    idempotencyKey: { type: String, required: true, trim: true },
    requestedByUserId: { type: String, default: null },
    requestedByType: { type: String, enum: ["CUSTOMER", "TENANT_USER"], default: null },
    processingLeaseOwner: { type: String, default: null },
    processingLeaseExpiresAt: { type: Date, default: null },
    processingAttempts: { type: Number, default: 0 },
    availableAt: { type: Date, default: Date.now },
    lastError: { type: String, default: null },
    customerReadyNoticeEnqueuedAt: { type: Date, default: null },
    version: versionField,
  },
  baseOptions,
);
digitalMetalDocumentArtifactSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
digitalMetalDocumentArtifactSchema.index({ tenantId: 1, docType: 1, subjectKey: 1, createdAt: -1 });
digitalMetalDocumentArtifactSchema.index(
  { tenantId: 1, documentNumber: 1 },
  { unique: true, partialFilterExpression: { documentNumber: { $type: "string" } } },
);
digitalMetalDocumentArtifactSchema.index({
  status: 1,
  availableAt: 1,
  processingLeaseExpiresAt: 1,
});

const bankDestinationSnapshotSchema = new mongoose.Schema(
  {
    destinationId: String,
    accountHolderName: String,
    accountLast4: String,
    ifsc: String,
    bankName: String,
    verificationStatus: String,
    verifiedAt: Date,
  },
  { _id: false },
);

const digitalMetalBankDestinationSchema = new mongoose.Schema(
  {
    _id: stringId("dmbd"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    accountHolderName: { type: String, required: true, trim: true, maxlength: 120 },
    accountNumberSealed: { type: String, required: true },
    accountLast4: { type: String, required: true, maxlength: 4 },
    ifsc: { type: String, required: true, trim: true, uppercase: true, maxlength: 11 },
    bankName: { type: String, default: "", trim: true, maxlength: 120 },
    status: {
      type: String,
      enum: ["PENDING_VERIFICATION", "ACTIVE", "DISABLED"],
      default: "PENDING_VERIFICATION",
    },
    manualVerificationNote: { type: String, default: "", maxlength: 2000 },
    verifiedByUserId: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    verificationEvidenceUploadIds: { type: [String], default: [] },
    disabledAt: { type: Date, default: null },
    version: versionField,
  },
  baseOptions,
);
digitalMetalBankDestinationSchema.index({ tenantId: 1, customerId: 1, status: 1 });

const digitalMetalSellOrderSchema = new mongoose.Schema(
  {
    _id: stringId("dmso"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    branchId: { type: String, default: null, index: true },
    quoteId: { type: String, required: true },
    reservationId: { type: String, required: true },
    bankDestinationId: { type: String, default: null },
    status: {
      type: String,
      enum: [
        "RESERVED",
        "PENDING_APPROVAL",
        "EXECUTED",
        "PAYABLE_OPEN",
        "CANCELLED",
        "EXPIRED",
      ],
      default: "RESERVED",
    },
    snapshot: mongoose.Schema.Types.Mixed,
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true }),
    quantityUg: integerField({ required: true, min: 1 }),
    settlementPaise: integerField({ required: true, min: 1 }),
    quoteExpiresAt: { type: Date, required: true },
    approvalExpiresAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    executedAt: { type: Date, default: null },
    sellExecutedNoticeEnqueuedAt: { type: Date, default: null },
    approvedByUserId: { type: String, default: null },
    payableId: { type: String, default: null },
    debitJournalId: { type: String, default: null },
    termsVersion: String,
    termsContentHash: String,
    termsAcceptedAt: { type: Date, required: true },
    idempotencyKey: { type: String, required: true, trim: true },
    creationBodyHash: { type: String, default: null, trim: true, maxlength: 64 },
    version: versionField,
  },
  baseOptions,
);
digitalMetalSellOrderSchema.index({ tenantId: 1, customerId: 1, createdAt: -1 });
digitalMetalSellOrderSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
digitalMetalSellOrderSchema.index({ tenantId: 1, quoteId: 1 }, { unique: true });
digitalMetalSellOrderSchema.index({ tenantId: 1, status: 1, approvalExpiresAt: 1 });

const digitalMetalPayableSchema = new mongoose.Schema(
  {
    _id: stringId("dmpaybl"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    sellOrderId: { type: String, required: true, unique: true },
    amountPaise: integerField({ required: true, min: 1 }),
    outstandingPaise: integerField({ required: true, min: 0 }),
    status: { type: String, enum: ["OPEN", "SETTLED"], default: "OPEN" },
    settledAt: { type: Date, default: null },
    version: versionField,
  },
  baseOptions,
);
digitalMetalPayableSchema.index({ tenantId: 1, customerId: 1, status: 1 });

const digitalMetalPayoutSchema = new mongoose.Schema(
  {
    _id: stringId("dmpos"),
    tenantId: tenantField,
    payableId: { type: String, required: true, index: true },
    sellOrderId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    amountPaise: integerField({ required: true, min: 1 }),
    status: {
      type: String,
      enum: [
        "PENDING_APPROVAL",
        "APPROVED",
        "SUBMITTED",
        "SETTLED",
        "FAILED",
        "UNKNOWN",
      ],
      default: "PENDING_APPROVAL",
    },
    destinationSnapshot: bankDestinationSnapshotSchema,
    makerUserId: { type: String, required: true },
    approverUserId: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    submittedByUserId: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    bankReference: { type: String, default: "", maxlength: 128 },
    settlementDate: { type: String, default: null, maxlength: 32 },
    settlementEvidenceUploadIds: { type: [String], default: [] },
    settledByUserId: { type: String, default: null },
    settledAt: { type: Date, default: null },
    failureReason: { type: String, default: "", maxlength: 500 },
    failureEvidenceUploadIds: { type: [String], default: [] },
    unknownResolvedAt: { type: Date, default: null },
    unknownResolutionNote: { type: String, default: "", maxlength: 2000 },
    unknownResolutionEvidenceUploadIds: { type: [String], default: [] },
    unknownResolvedByUserId: { type: String, default: null },
    settlementVerification: {
      type: String,
      enum: ["STAFF_ATTESTED"],
      default: null,
    },
    statusHistory: {
      type: [
        {
          at: { type: Date, required: true },
          status: { type: String, required: true },
          actorUserId: { type: String, default: null },
          note: { type: String, default: "", maxlength: 500 },
        },
      ],
      default: [],
    },
    idempotencyKey: { type: String, required: true, trim: true },
    settlementIdempotencyKey: { type: String, default: null },
    version: versionField,
  },
  baseOptions,
);
digitalMetalPayoutSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
digitalMetalPayoutSchema.index({ tenantId: 1, payableId: 1, status: 1 });

const digitalMetalCustomerRiskHoldSchema = new mongoose.Schema(
  {
    _id: stringId("dmrh"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    status: { type: String, enum: ["ACTIVE", "RESOLVED"], default: "ACTIVE" },
    reasonCode: {
      type: String,
      enum: ["CHARGEBACK", "REFUND_EXPOSURE", "MANUAL"],
      required: true,
    },
    holdScope: {
      type: String,
      enum: ["REFUND_CASE", "TRADING"],
      default: "TRADING",
    },
    blocksSell: { type: Boolean, default: true },
    blocksRedemption: { type: Boolean, default: true },
    exposurePaise: integerField({ required: true, min: 0 }),
    unrecoverableMetalUg: integerField({ default: 0, min: 0 }),
    relatedBuyOrderId: { type: String, default: null },
    relatedRefundCaseId: { type: String, default: null },
    note: { type: String, default: "", maxlength: 2000 },
    createdByUserId: { type: String, default: null },
    resolvedByUserId: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: "", maxlength: 2000 },
    version: versionField,
  },
  baseOptions,
);
digitalMetalCustomerRiskHoldSchema.index(
  { tenantId: 1, customerId: 1, status: 1 },
  { partialFilterExpression: { status: "ACTIVE" } },
);
digitalMetalCustomerRiskHoldSchema.index(
  { tenantId: 1, relatedRefundCaseId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "ACTIVE", relatedRefundCaseId: { $type: "string" } },
  },
);

const digitalMetalRedemptionCatalogItemSchema = new mongoose.Schema(
  {
    _id: stringId("dmrci"),
    tenantId: tenantField,
    sku: { type: String, required: true, trim: true, maxlength: 64 },
    label: { type: String, required: true, trim: true, maxlength: 160 },
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true, min: 1 }),
    unitQuantityUg: integerField({ required: true, min: 1 }),
    mintingRule: { type: feeRuleSchema, default: () => ({ type: "FLAT_INR", amountPaise: 0 }) },
    mintingPercentBase: {
      type: String,
      enum: ["FIXED_DENOMINATION", "METAL_VALUE_AT_BUY_RATE"],
      default: "FIXED_DENOMINATION",
    },
    deliveryFlatPaise: integerField({ default: 0, min: 0 }),
    deliveryWaiveAboveTotalChargePaise: integerField({ default: null, min: 0 }),
    packagingPaise: integerField({ default: 0, min: 0 }),
    taxLines: { type: [taxLineSchema], default: [] },
    leadTimeDays: { type: Number, default: 3, min: 0, max: 365 },
    pickupEnabled: { type: Boolean, default: true },
    deliveryEnabled: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
    imageUploadIds: { type: [String], default: [] },
    version: versionField,
  },
  baseOptions,
);
digitalMetalRedemptionCatalogItemSchema.index({ tenantId: 1, sku: 1 }, { unique: true });
digitalMetalRedemptionCatalogItemSchema.index({ tenantId: 1, active: 1, metal: 1 });

const digitalMetalRedemptionOrderSchema = new mongoose.Schema(
  {
    _id: stringId("dmro"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    branchId: { type: String, default: null, index: true },
    quoteId: { type: String, required: true },
    catalogueItemId: { type: String, required: true },
    catalogueVersion: integerField({ required: true, min: 1 }),
    reservationId: { type: String, required: true },
    status: {
      type: String,
      enum: [
        "RESERVED",
        "CHARGE_PENDING",
        "CHARGE_PAID",
        "REFUND_REVIEW",
        "CANCELLED",
        "EXPIRED",
        "FULFILMENT_ACCEPTED",
        "PACKING",
        "DISPATCHED",
        "PICKUP_READY",
        "INVESTIGATION",
        "COMPLETED",
      ],
      default: "RESERVED",
    },
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true }),
    quantityUg: integerField({ required: true, min: 1 }),
    unitCount: integerField({ required: true, min: 1 }),
    chargeTotalPaise: integerField({ required: true, min: 0 }),
    snapshot: mongoose.Schema.Types.Mixed,
    fulfilmentMode: { type: String, enum: ["PICKUP", "DELIVERY"], required: true },
    pickupBranchId: { type: String, default: null },
    deliveryAddressSnapshot: mongoose.Schema.Types.Mixed,
    quoteExpiresAt: { type: Date, required: true },
    chargePaymentExpiresAt: { type: Date, required: true },
    termsVersion: String,
    termsContentHash: String,
    termsAcceptedAt: { type: Date, required: true },
    successfulChargeAttemptId: { type: String, default: null },
    chargePaidAt: { type: Date, default: null },
    chargePaidCustomerNoticeEnqueuedAt: { type: Date, default: null },
    paymentExceptionStatus: { type: String, default: null },
    paymentExceptionPayload: mongoose.Schema.Types.Mixed,
    fulfilmentBranchId: { type: String, default: null },
    leadTimeDays: { type: Number, default: null },
    delayNote: { type: String, default: "" },
    delayEvidenceUploadIds: { type: [String], default: [] },
    pickupCodeHash: { type: String, default: null },
    pickupCodeSealed: { type: String, default: null },
    pickupCodeExpiresAt: { type: Date, default: null },
    pickupCodeAttempts: { type: Number, default: 0 },
    pickupCodeMaxAttempts: { type: Number, default: 5 },
    carrier: { type: String, default: "" },
    trackingReference: { type: String, default: "" },
    trackingSource: { type: String, enum: ["MANUAL", "CARRIER", null], default: null },
    dispatchEvidenceUploadIds: { type: [String], default: [] },
    dispatchedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    completionAttestation: { type: Boolean, default: false },
    completionEvidenceUploadIds: { type: [String], default: [] },
    physicalOutEventId: { type: String, default: null },
    replacementOfOrderId: { type: String, default: null },
    investigationReason: { type: String, default: "" },
    statusHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
    shipmentHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
    chargeRefundPolicySnapshot: mongoose.Schema.Types.Mixed,
    idempotencyKey: { type: String, required: true, trim: true },
    creationBodyHash: { type: String, default: null, trim: true, maxlength: 64 },
    version: versionField,
  },
  baseOptions,
);
digitalMetalRedemptionOrderSchema.index({ tenantId: 1, customerId: 1, createdAt: -1 });
digitalMetalRedemptionOrderSchema.index({ tenantId: 1, status: 1, updatedAt: -1 });
digitalMetalRedemptionOrderSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });

const digitalMetalRedemptionPaymentAttemptSchema = new mongoose.Schema(
  {
    _id: stringId("dmrpay"),
    tenantId: tenantField,
    orderId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["PENDING", "INITIATED", "SUCCEEDED", "FAILED"],
      default: "PENDING",
    },
    amountPaise: integerField({ required: true, min: 0 }),
    currency: { type: String, default: "INR" },
    provider: { type: String, default: "PHONEPE" },
    checkoutMode: {
      type: String,
      enum: ["LIVE", "MOCK_PROVIDER", "DIGITAL_METALS_DEMO", null],
      default: null,
    },
    merchantOrderId: { type: String, required: true },
    providerOrderId: { type: String, default: null },
    sdkToken: { type: String, default: null },
    redirectUrl: { type: String, default: null },
    providerPaymentId: { type: String, default: null },
    providerPayload: mongoose.Schema.Types.Mixed,
    failureReason: { type: String, default: null },
    idempotencyKey: { type: String, required: true, trim: true },
    gatewayReconcileNextAt: { type: Date, default: null },
    gatewayReconcileLeaseOwner: { type: String, default: null },
    gatewayReconcileLeaseExpiresAt: { type: Date, default: null },
    gatewayReconcileAttempts: { type: Number, default: 0 },
    gatewayLastReconcileAt: { type: Date, default: null },
    gatewayLastReconcileOutcome: { type: String, default: null },
    version: versionField,
  },
  baseOptions,
);
digitalMetalRedemptionPaymentAttemptSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });

const digitalMetalRedemptionChargeRefundCaseSchema = new mongoose.Schema(
  {
    _id: stringId("dmrref"),
    tenantId: tenantField,
    redemptionOrderId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    paymentAttemptId: { type: String, required: true },
    merchantOrderId: { type: String, required: true },
    amountPaise: integerField({ required: true, min: 0 }),
    exceptionType: {
      type: String,
      enum: ["LATE_SUCCESS", "DUPLICATE_PAYMENT", "ADDITIONAL_CAPTURE", "PRE_DISPATCH_CANCEL"],
      required: true,
    },
    resolvedByUserId: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["ASSIGNED", "REFUND_INITIATED", "SUCCEEDED", "MANUAL_RECORDED", "FAILED"],
      default: "ASSIGNED",
    },
    resolutionNote: { type: String, default: "" },
    evidenceUploadIds: { type: [String], default: [] },
    providerRefundId: { type: String, default: null },
    version: versionField,
  },
  baseOptions,
);
digitalMetalRedemptionChargeRefundCaseSchema.index({ tenantId: 1, redemptionOrderId: 1, paymentAttemptId: 1 }, { unique: true });

const digitalMetalPhysicalOutEventSchema = new mongoose.Schema(
  {
    _id: stringId("dmphy"),
    tenantId: tenantField,
    redemptionOrderId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true }),
    quantityUg: integerField({ required: true, min: 1 }),
    reservationId: { type: String, required: true },
    businessDate: { type: String, required: true },
    fulfilmentMode: { type: String, enum: ["PICKUP", "DELIVERY"], required: true },
    locationCode: { type: String, default: "PRIMARY" },
    idempotencyKey: { type: String, required: true, trim: true },
    version: versionField,
  },
  baseOptions,
);
digitalMetalPhysicalOutEventSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
digitalMetalPhysicalOutEventSchema.index({ tenantId: 1, redemptionOrderId: 1 }, { unique: true });

const digitalMetalProcurementEntrySchema = new mongoose.Schema(
  {
    _id: stringId("dmpce"),
    tenantId: tenantField,
    entryType: {
      type: String,
      enum: ["OPENING_POSITION", "COMMITMENT", "RECEIPT", "DISPOSAL", "REVERSAL"],
      required: true,
    },
    status: {
      type: String,
      enum: ["PENDING_APPROVAL", "APPROVED", "REJECTED"],
      default: "PENDING_APPROVAL",
    },
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true }),
    quantityUg: integerField({ required: true, min: 1 }),
    obligationQuantityUg: integerField({ min: 0, default: null }),
    amountPaise: integerField({ min: 0, default: 0 }),
    supplierRef: { type: String, default: "" },
    billRef: { type: String, default: "" },
    locationCode: { type: String, default: "PRIMARY" },
    effectiveDate: { type: String, required: true },
    recordedAt: { type: Date, default: Date.now },
    commitmentEntryId: { type: String, default: null },
    reversesEntryId: { type: String, default: null },
    evidenceUploadIds: { type: [String], default: [] },
    reasonNote: { type: String, default: "" },
    createdByUserId: { type: String, required: true },
    approvedByUserId: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    idempotencyKey: { type: String, required: true, trim: true },
    overReceiptApproved: { type: Boolean, default: false },
    overReceiptApprovalNote: { type: String, default: "" },
    /** Denormalized on COMMITMENT rows — approved receipt quantity booked against commitment. */
    receivedQuantityUg: integerField({ min: 0, default: 0 }),
    version: versionField,
  },
  baseOptions,
);
digitalMetalProcurementEntrySchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
digitalMetalProcurementEntrySchema.index({ tenantId: 1, metal: 1, finenessPpm: 1, effectiveDate: 1 });
digitalMetalProcurementEntrySchema.index({ tenantId: 1, commitmentEntryId: 1 });

const digitalMetalHedgeSnapshotSchema = new mongoose.Schema(
  {
    _id: stringId("dmhs"),
    tenantId: tenantField,
    businessDate: { type: String, required: true },
    metal: enumField(DigitalMetalKind, { required: true }),
    finenessPpm: integerField({ required: true }),
    snapshotVersion: integerField({ required: true, min: 1 }),
    status: { type: String, enum: ["CLOSED", "SUPERSEDED", "INVALIDATED"], default: "CLOSED" },
    supersededByVersion: { type: Number, default: null },
    invalidatedAt: { type: Date, default: null },
    invalidatedBySnapshotId: { type: String, default: null },
    invalidationReason: { type: String, default: "" },
    coverageIncomplete: { type: Boolean, default: false },
    openingObligationUg: integerField({ required: true, min: 0 }),
    closingObligationUg: integerField({ required: true, min: 0 }),
    openingHedgePositionUg: integerField({ required: true, min: 0 }),
    closingHedgePositionUg: integerField({ required: true, min: 0 }),
    uncoveredUg: integerField({ required: true }),
    openCommitmentsUg: integerField({ default: 0, min: 0 }),
    reservedInTransitUg: integerField({ default: 0, min: 0 }),
    outstandingPayablesPaise: integerField({ default: 0, min: 0 }),
    completedBuyUg: integerField({ default: 0, min: 0 }),
    executedSellUg: integerField({ default: 0, min: 0 }),
    physicalHandoverUg: integerField({ default: 0, min: 0 }),
    procurementReceiptUg: integerField({ default: 0, min: 0 }),
    supplierDisposalUg: integerField({ default: 0, min: 0 }),
    obligationAdjustmentUg: integerField({ default: 0 }),
    hedgeAdjustmentUg: integerField({ default: 0 }),
    walletHeldUg: integerField({ default: 0, min: 0 }),
    walletReservedUg: integerField({ default: 0, min: 0 }),
    walletReconcileDeltaUg: integerField({ default: 0 }),
    eventCutoffAt: { type: Date, required: true },
    closedByUserId: { type: String, required: true },
    closedAt: { type: Date, default: Date.now },
    revisionReason: { type: String, default: "" },
    sourceBreakdown: { type: [mongoose.Schema.Types.Mixed], default: [] },
    downstreamInvalidatedBusinessDates: { type: [String], default: [] },
    version: versionField,
  },
  baseOptions,
);
digitalMetalHedgeSnapshotSchema.index(
  { tenantId: 1, businessDate: 1, metal: 1, finenessPpm: 1, snapshotVersion: 1 },
  { unique: true },
);

const digitalMetalHedgeIncludedSourceSchema = new mongoose.Schema(
  {
    _id: stringId("dmhis"),
    tenantId: tenantField,
    sourceType: {
      type: String,
      enum: ["BUY_CREDIT", "SELL_EXECUTE", "PHYSICAL_OUT", "PROCUREMENT", "ADJUSTMENT"],
      required: true,
    },
    sourceId: { type: String, required: true },
    businessDate: { type: String, required: true },
    quantityUg: integerField({ required: true }),
    includedInSnapshotId: { type: String, required: true },
  },
  baseOptions,
);
digitalMetalHedgeIncludedSourceSchema.index({ tenantId: 1, sourceType: 1, sourceId: 1 }, { unique: true });

export const DigitalMetalBankDestination = mongoose.model(
  "DigitalMetalBankDestination",
  digitalMetalBankDestinationSchema,
);
export const DigitalMetalSellOrder = mongoose.model(
  "DigitalMetalSellOrder",
  digitalMetalSellOrderSchema,
);
export const DigitalMetalPayable = mongoose.model("DigitalMetalPayable", digitalMetalPayableSchema);
export const DigitalMetalPayout = mongoose.model("DigitalMetalPayout", digitalMetalPayoutSchema);
export const DigitalMetalCustomerRiskHold = mongoose.model(
  "DigitalMetalCustomerRiskHold",
  digitalMetalCustomerRiskHoldSchema,
);
export const DigitalMetalRedemptionCatalogItem = mongoose.model(
  "DigitalMetalRedemptionCatalogItem",
  digitalMetalRedemptionCatalogItemSchema,
);
export const DigitalMetalRedemptionOrder = mongoose.model(
  "DigitalMetalRedemptionOrder",
  digitalMetalRedemptionOrderSchema,
);
export const DigitalMetalRedemptionPaymentAttempt = mongoose.model(
  "DigitalMetalRedemptionPaymentAttempt",
  digitalMetalRedemptionPaymentAttemptSchema,
);
export const DigitalMetalRedemptionChargeRefundCase = mongoose.model(
  "DigitalMetalRedemptionChargeRefundCase",
  digitalMetalRedemptionChargeRefundCaseSchema,
);
export const DigitalMetalPhysicalOutEvent = mongoose.model(
  "DigitalMetalPhysicalOutEvent",
  digitalMetalPhysicalOutEventSchema,
);
export const DigitalMetalProcurementEntry = mongoose.model(
  "DigitalMetalProcurementEntry",
  digitalMetalProcurementEntrySchema,
);
export const DigitalMetalHedgeSnapshot = mongoose.model(
  "DigitalMetalHedgeSnapshot",
  digitalMetalHedgeSnapshotSchema,
);
export const DigitalMetalHedgeIncludedSource = mongoose.model(
  "DigitalMetalHedgeIncludedSource",
  digitalMetalHedgeIncludedSourceSchema,
);
export const DigitalMetalDocumentArtifact = mongoose.model(
  "DigitalMetalDocumentArtifact",
  digitalMetalDocumentArtifactSchema,
);
