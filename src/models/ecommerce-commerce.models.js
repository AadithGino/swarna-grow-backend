import mongoose from "mongoose";
import {
  EcommerceCheckoutTaxPresentation,
  EcommerceFulfilmentMode,
  EcommercePaymentMethod,
  EcommerceOrderEventType,
  EcommerceOrderPaymentExceptionStatus,
  EcommerceOrderStatus,
  EcommerceStockReleaseReason,
  EcommerceTaxSupplyCase,
  EcommercePaymentAttemptStatus,
  EcommercePaymentAttemptOperationalStatus,
  EcommercePaymentExceptionRefundStatus,
  EcommerceOrderRefundSource,
  EcommerceOrderCancellationRequestStatus,
  EcommerceOrderCancellationKind,
  EcommerceCancellationStockDisposition,
  EcommerceOrderReturnKind,
  EcommerceOrderReturnRequestStatus,
  EcommerceQuoteStatus,
  EcommerceStockPolicy,
  EcommerceCourierCodCollectionStatus,
  EcommerceCourierCodCollectionSource,
  EcommerceCourierCodRemittanceStatus,
  EcommerceCodRemittanceBatchStatus,
  EcommerceCodRemittanceLineStatus,
  EcommerceCodRemittanceReconciliationStatus,
  EcommerceCodRefundFundingSource,
  EcommerceCodRefundRemittanceContext,
  EcommerceFulfilmentHandoverMethod,
} from "../constants/enums.js";
import {
  baseOptions,
  enumField,
  integerField,
  optionalIntegerField,
  stringId,
  tenantField,
  versionField,
} from "./schema-helpers.js";

const addressSchema = new mongoose.Schema(
  {
    _id: stringId("eaddr"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    label: { type: String, trim: true, maxlength: 80, default: "Home" },
    recipientName: { type: String, trim: true, maxlength: 120 },
    mobile: { type: String, trim: true, maxlength: 16 },
    line1: { type: String, required: true, trim: true, maxlength: 200 },
    line2: { type: String, trim: true, maxlength: 200, default: "" },
    city: { type: String, required: true, trim: true, maxlength: 80 },
    state: { type: String, required: true, trim: true, maxlength: 80 },
    pincode: { type: String, required: true, trim: true, maxlength: 12 },
    isDefault: { type: Boolean, default: false },
    version: versionField,
  },
  baseOptions,
);
addressSchema.index({ tenantId: 1, customerId: 1, updatedAt: -1 });

const cartLineSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true },
    quantity: integerField({ min: 1, default: 1 }),
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const cartSchema = new mongoose.Schema(
  {
    _id: stringId("ecart"),
    tenantId: tenantField,
    customerId: { type: String, required: true },
    lines: { type: [cartLineSchema], default: [] },
    version: versionField,
  },
  baseOptions,
);
cartSchema.index({ tenantId: 1, customerId: 1 }, { unique: true });

const inventorySchema = new mongoose.Schema(
  {
    _id: stringId("einv"),
    tenantId: tenantField,
    productId: { type: String, required: true },
    stockPolicy: enumField(EcommerceStockPolicy, {
      default: EcommerceStockPolicy.MADE_TO_ORDER,
    }),
    quantityOnHand: optionalIntegerField({ min: 0 }),
    reservedQuantity: optionalIntegerField({ min: 0, default: 0 }),
    version: versionField,
  },
  baseOptions,
);
inventorySchema.index({ tenantId: 1, productId: 1 }, { unique: true });

const quoteLineSnapshotSchema = new mongoose.Schema(
  {
    productId: String,
    productVersion: Number,
    name: String,
    sku: String,
    quantity: integerField({ min: 1 }),
    unitPricePaise: integerField({ min: 0 }),
    lineTotalPaise: integerField({ min: 0 }),
    pricingSnapshot: mongoose.Schema.Types.Mixed,
  },
  { _id: false },
);

const quoteSchema = new mongoose.Schema(
  {
    _id: stringId("equote"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    status: enumField(EcommerceQuoteStatus, { default: EcommerceQuoteStatus.ACTIVE }),
    lines: { type: [quoteLineSnapshotSchema], default: [] },
    fulfilmentMode: enumField(EcommerceFulfilmentMode),
    pickupBranchId: String,
    addressSnapshot: mongoose.Schema.Types.Mixed,
    fulfilmentChargePaise: integerField({ min: 0, default: 0 }),
    financialSnapshot: mongoose.Schema.Types.Mixed,
    subtotalPaise: integerField({ min: 0, default: 0 }),
    taxPaise: integerField({ min: 0, default: 0 }),
    totalPaise: integerField({ min: 0, default: 0 }),
    taxConfigVersion: Number,
    paymentMethod: enumField(EcommercePaymentMethod, {
      default: EcommercePaymentMethod.ONLINE,
    }),
    codPincodeSnapshot: { type: String, trim: true, maxlength: 12 },
    expiresAt: { type: Date, required: true },
    idempotencyKey: { type: String, trim: true, maxlength: 80 },
    creationBodyHash: { type: String, trim: true, maxlength: 64 },
    orderId: String,
    /** Staff member who priced this quote at the counter (staff-placed orders only). */
    assistedByUserId: String,
    version: versionField,
  },
  baseOptions,
);
quoteSchema.index({ tenantId: 1, customerId: 1, status: 1, expiresAt: 1 });
quoteSchema.index(
  { tenantId: 1, customerId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
  },
);

const orderStockConsumptionEvidenceSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true },
    quantityDeducted: optionalIntegerField({ min: 0, default: 0 }),
    inventoryId: String,
    stockPolicyAtConsumption: enumField(EcommerceStockPolicy),
    consumedAt: Date,
  },
  { _id: false },
);

const orderDeliveryTrackingSchema = new mongoose.Schema(
  {
    carrierName: { type: String, trim: true, maxlength: 120, default: "" },
    trackingNumber: { type: String, trim: true, maxlength: 80, default: "" },
    trackingUrl: { type: String, trim: true, maxlength: 500, default: "" },
    dispatchedAt: Date,
    deliveredAt: Date,
  },
  { _id: false },
);

const orderStorePolicySnapshotSchema = new mongoose.Schema(
  {
    version: Number,
    publishedAt: Date,
  },
  { _id: false },
);

const orderLineSnapshotSchema = new mongoose.Schema(
  {
    productId: String,
    productVersion: Number,
    name: String,
    sku: String,
    quantity: integerField({ min: 1 }),
    unitPricePaise: integerField({ min: 0 }),
    lineTotalPaise: integerField({ min: 0 }),
    pricingSnapshot: mongoose.Schema.Types.Mixed,
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    _id: stringId("eord"),
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    orderNumber: { type: String, required: true, trim: true },
    status: enumField(EcommerceOrderStatus, {
      default: EcommerceOrderStatus.PENDING_PAYMENT,
    }),
    quoteId: String,
    lines: { type: [orderLineSnapshotSchema], default: [] },
    fulfilmentMode: enumField(EcommerceFulfilmentMode),
    addressSnapshot: mongoose.Schema.Types.Mixed,
    pickupBranchId: String,
    subtotalPaise: integerField({ min: 0, default: 0 }),
    taxPaise: integerField({ min: 0, default: 0 }),
    fulfilmentChargePaise: integerField({ min: 0, default: 0 }),
    totalPaise: integerField({ min: 0, default: 0 }),
    taxConfigVersion: Number,
    financialSnapshot: mongoose.Schema.Types.Mixed,
    idempotencyKey: { type: String, trim: true, maxlength: 80 },
    creationBodyHash: { type: String, trim: true, maxlength: 64 },
    expiresAt: Date,
    stockReleaseReason: enumField(EcommerceStockReleaseReason),
    stockReleasedAt: Date,
    stockConsumedAt: Date,
    stockConsumptionEvidence: { type: [orderStockConsumptionEvidenceSchema], default: [] },
    stockRestockedAt: Date,
    stockExceptionRecordedAt: Date,
    stockRestockIdempotencyKey: { type: String, trim: true, maxlength: 80 },
    paidAt: Date,
    successfulPaymentAttemptId: String,
    paymentExceptionStatus: enumField(EcommerceOrderPaymentExceptionStatus),
    paymentExceptionPayload: mongoose.Schema.Types.Mixed,
    paymentMethod: enumField(EcommercePaymentMethod, {
      default: EcommercePaymentMethod.ONLINE,
    }),
    codPincodeSnapshot: { type: String, trim: true, maxlength: 12 },
    courierCod: {
      providerId: { type: String, trim: true, maxlength: 64, default: "MANUAL" },
      trackingReference: { type: String, trim: true, maxlength: 120 },
      expectedAmountPaise: optionalIntegerField({ min: 0 }),
      collectionStatus: enumField(EcommerceCourierCodCollectionStatus, {
        default: EcommerceCourierCodCollectionStatus.NOT_APPLICABLE,
      }),
      collectionConfirmedAt: Date,
      collectionReference: { type: String, trim: true, maxlength: 160 },
      collectionSource: enumField(EcommerceCourierCodCollectionSource),
      collectionEvidenceNote: { type: String, trim: true, maxlength: 500 },
      collectionIdempotencyKey: { type: String, trim: true, maxlength: 80 },
      collectionBodyHash: { type: String, trim: true, maxlength: 64 },
      collectionRecordedByUserId: String,
      remittanceStatus: enumField(EcommerceCourierCodRemittanceStatus, {
        default: EcommerceCourierCodRemittanceStatus.NOT_APPLICABLE,
      }),
      activeRemittanceLineId: String,
      activeRemittanceBatchId: String,
      remittanceGrossPaise: optionalIntegerField({ min: 0 }),
      remittanceFeePaise: optionalIntegerField({ min: 0 }),
      remittanceNetPaise: optionalIntegerField({ min: 0 }),
      bankCreditReference: { type: String, trim: true, maxlength: 160 },
      bankCreditedAt: Date,
      reconciliationStatus: enumField(EcommerceCodRemittanceReconciliationStatus),
      reconciliationDiscrepancyPaise: optionalIntegerField(),
    },
    fulfilmentHandover: {
      method: enumField(EcommerceFulfilmentHandoverMethod),
      recipientName: { type: String, trim: true, maxlength: 120 },
      recordedAt: Date,
      recordedByUserId: String,
      deliveryProofReference: { type: String, trim: true, maxlength: 160 },
      pickupCodeHash: { type: String, trim: true, maxlength: 128 },
      pickupCodeExpiresAt: Date,
      pickupVerifiedAt: Date,
    },
    activeCancellationRequestId: String,
    /** Set when staff placed this order for the customer and took payment at the counter. */
    assisted: {
      channel: { type: String, trim: true, maxlength: 16 },
      byUserId: String,
      byRole: { type: String, trim: true, maxlength: 32 },
      branchId: String,
      paymentMode: { type: String, enum: ["CASH", "UPI", "CARD"] },
      paymentReference: { type: String, trim: true, maxlength: 120 },
      note: { type: String, trim: true, maxlength: 500 },
      cashAdjustmentId: String,
      recordedAt: Date,
    },
    deliveryTracking: { type: orderDeliveryTrackingSchema, default: () => ({}) },
    storePolicySnapshot: { type: orderStorePolicySnapshotSchema, default: () => ({}) },
    version: versionField,
  },
  baseOptions,
);
orderSchema.index({ tenantId: 1, orderNumber: 1 }, { unique: true });
orderSchema.index({ tenantId: 1, customerId: 1, createdAt: -1 });
orderSchema.index({ tenantId: 1, createdAt: -1, _id: -1 });
orderSchema.index({ status: 1, expiresAt: 1 });
orderSchema.index(
  { tenantId: 1, customerId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
  },
);
orderSchema.index(
  { tenantId: 1, "courierCod.collectionStatus": 1, "courierCod.collectionConfirmedAt": -1 },
  {
    partialFilterExpression: {
      "courierCod.collectionStatus": EcommerceCourierCodCollectionStatus.CONFIRMED,
    },
  },
);
orderSchema.index(
  { tenantId: 1, "courierCod.remittanceStatus": 1, "courierCod.bankCreditedAt": -1 },
  {
    partialFilterExpression: {
      "courierCod.remittanceStatus": EcommerceCourierCodRemittanceStatus.BANK_RECONCILED,
    },
  },
);

const orderEventSchema = new mongoose.Schema(
  {
    _id: stringId("eoev"),
    tenantId: tenantField,
    orderId: { type: String, required: true, index: true },
    type: enumField(EcommerceOrderEventType, { required: true }),
    actorType: { type: String, trim: true, maxlength: 32 },
    actorId: String,
    payload: mongoose.Schema.Types.Mixed,
    at: { type: Date, default: Date.now },
  },
  baseOptions,
);
orderEventSchema.index({ tenantId: 1, orderId: 1, at: 1 });

const paymentAttemptSchema = new mongoose.Schema(
  {
    _id: stringId("epay"),
    tenantId: tenantField,
    orderId: { type: String, required: true, index: true },
    customerId: { type: String, required: true },
    status: enumField(EcommercePaymentAttemptStatus, {
      default: EcommercePaymentAttemptStatus.PENDING,
    }),
    amountPaise: integerField({ min: 1 }),
    currency: { type: String, default: "INR", maxlength: 3 },
    provider: { type: String, trim: true, maxlength: 32 },
    providerOrderId: String,
    providerPaymentId: String,
    merchantOrderId: { type: String, trim: true, maxlength: 80 },
    sdkToken: { type: String, trim: true, maxlength: 512 },
    redirectUrl: { type: String, trim: true, maxlength: 2048 },
    creationBodyHash: { type: String, trim: true, maxlength: 64 },
    failureReason: { type: String, trim: true, maxlength: 120 },
    providerPayload: mongoose.Schema.Types.Mixed,
    initiationClaimToken: { type: String, trim: true, maxlength: 64 },
    initiationClaimExpiresAt: Date,
    idempotencyKey: { type: String, trim: true, maxlength: 80 },
    expiresAt: Date,
    operationalStatus: enumField(EcommercePaymentAttemptOperationalStatus, {
      default: EcommercePaymentAttemptOperationalStatus.NORMAL,
    }),
    gatewayReconcileLeaseOwner: String,
    gatewayReconcileLeaseExpiresAt: Date,
    gatewayReconcileAttempts: { type: Number, default: 0 },
    gatewayReconcileNextAt: Date,
    gatewayLastReconcileAt: Date,
    gatewayLastReconcileOutcome: { type: String, trim: true, maxlength: 64 },
    providerInitConfirmedAt: Date,
    version: versionField,
  },
  baseOptions,
);
paymentAttemptSchema.index({ tenantId: 1, orderId: 1, createdAt: -1 });
paymentAttemptSchema.index({
  status: 1,
  operationalStatus: 1,
  gatewayReconcileNextAt: 1,
  updatedAt: 1,
});
paymentAttemptSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
  },
);
paymentAttemptSchema.index(
  { tenantId: 1, orderId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["PENDING", "INITIATED"] },
    },
  },
);
paymentAttemptSchema.index(
  { tenantId: 1, providerOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerOrderId: { $type: "string", $gt: "" } },
  },
);

const paymentAttemptEventSchema = new mongoose.Schema(
  {
    _id: stringId("epayev"),
    tenantId: tenantField,
    orderId: { type: String, required: true, index: true },
    paymentAttemptId: { type: String, required: true, index: true },
    webhookEventId: String,
    direction: { type: String, trim: true, maxlength: 16 },
    outcome: { type: String, trim: true, maxlength: 64 },
    reason: { type: String, trim: true, maxlength: 500 },
    payload: mongoose.Schema.Types.Mixed,
    at: { type: Date, default: Date.now },
  },
  baseOptions,
);
paymentAttemptEventSchema.index({ tenantId: 1, paymentAttemptId: 1, at: 1 });

const paymentExceptionRefundSchema = new mongoose.Schema(
  {
    _id: stringId("epayref"),
    tenantId: tenantField,
    orderId: { type: String, required: true, index: true },
    paymentAttemptId: { type: String, required: true },
    amountPaise: integerField({ min: 1 }),
    currency: { type: String, default: "INR", maxlength: 3 },
    providerPaymentId: String,
    merchantOrderId: String,
    status: enumField(EcommercePaymentExceptionRefundStatus, {
      default: EcommercePaymentExceptionRefundStatus.ASSIGNED,
    }),
    providerRefundId: String,
    assignedUserId: String,
    failureReason: { type: String, trim: true, maxlength: 500 },
    providerPayload: mongoose.Schema.Types.Mixed,
    refundSource: enumField(EcommerceOrderRefundSource, {
      default: EcommerceOrderRefundSource.PAYMENT_EXCEPTION,
    }),
    cancellationRequestId: String,
    returnRequestId: String,
    version: versionField,
  },
  baseOptions,
);
paymentExceptionRefundSchema.index({ tenantId: 1, orderId: 1 }, { unique: true });
paymentExceptionRefundSchema.index(
  { tenantId: 1, providerRefundId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerRefundId: { $type: "string", $gt: "" } },
  },
);

const stockReservationSchema = new mongoose.Schema(
  {
    _id: stringId("ersv"),
    tenantId: tenantField,
    productId: { type: String, required: true },
    orderId: String,
    quoteId: String,
    quantity: integerField({ min: 1 }),
    expiresAt: { type: Date, required: true },
    releasedAt: Date,
    version: versionField,
  },
  baseOptions,
);
stockReservationSchema.index({ tenantId: 1, productId: 1, releasedAt: 1, expiresAt: 1 });

const checkoutTaxComponentLineSchema = new mongoose.Schema(
  {
    componentKey: { type: String, required: true, trim: true, maxlength: 32 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    rateBps: integerField({ min: 0, max: 10_000 }),
  },
  { _id: false },
);

const checkoutTaxComponentRuleSchema = new mongoose.Schema(
  {
    supplyCase: enumField(EcommerceTaxSupplyCase, { required: true }),
    componentLines: { type: [checkoutTaxComponentLineSchema], default: [] },
  },
  { _id: false },
);

const checkoutTaxConfigSchema = new mongoose.Schema(
  {
    presentation: enumField(EcommerceCheckoutTaxPresentation, {
      default: EcommerceCheckoutTaxPresentation.UNCONFIGURED,
    }),
    sellerLegalName: { type: String, trim: true, maxlength: 200, default: "" },
    sellerGstin: { type: String, trim: true, maxlength: 15, default: "" },
    registeredState: { type: String, trim: true, maxlength: 80, default: "" },
    defaultPlaceOfSupplyState: { type: String, trim: true, maxlength: 80, default: "" },
    defaultItemTaxClassification: { type: String, trim: true, maxlength: 64, default: "" },
    accountantSignOffReference: { type: String, trim: true, maxlength: 120, default: "" },
    accountantApprovedAt: Date,
    componentLines: { type: [checkoutTaxComponentLineSchema], default: [] },
    componentRules: { type: [checkoutTaxComponentRuleSchema], default: [] },
    supportedDestinationStates: { type: [String], default: [] },
  },
  { _id: false },
);

const fulfilmentSettingsSchema = new mongoose.Schema(
  {
    _id: stringId("eful"),
    tenantId: { type: String, required: true },
    pickupEnabled: { type: Boolean, default: false },
    pickupBranchIds: { type: [String], default: [] },
    deliveryEnabled: { type: Boolean, default: false },
    deliveryChargePaise: optionalIntegerField({ min: 0 }),
    serviceablePincodes: { type: [String], default: [] },
    maxCartLines: integerField({ min: 1, default: 50 }),
    maxQuantityPerLine: integerField({ min: 1, default: 99 }),
    pendingPaymentWindowMinutes: integerField({ min: 5, max: 120, default: 30 }),
    codEnabled: { type: Boolean, default: false },
    codPincodes: { type: [String], default: [] },
    codAcceptanceWindowMinutes: integerField({ min: 30, max: 2880, default: 120 }),
    requireCourierTrackingForShipped: { type: Boolean, default: false },
    storePolicies: {
      version: { type: Number, default: 0 },
      publishedAt: Date,
      shippingPolicyText: { type: String, trim: true, maxlength: 8000, default: "" },
      shippingPolicyApprovedAt: Date,
      returnsPolicyText: { type: String, trim: true, maxlength: 8000, default: "" },
      returnsPolicyApprovedAt: Date,
      cancellationPolicyText: { type: String, trim: true, maxlength: 8000, default: "" },
      cancellationPolicyApprovedAt: Date,
      refundContactPolicyText: { type: String, trim: true, maxlength: 4000, default: "" },
      refundContactPolicyApprovedAt: Date,
      returnEligibilityDays: integerField({ min: 0, max: 365, default: 0 }),
      returnExcludedCategoryIds: { type: [String], default: [] },
    },
    checkoutTaxConfig: { type: checkoutTaxConfigSchema, default: () => ({}) },
    version: versionField,
  },
  baseOptions,
);
fulfilmentSettingsSchema.index({ tenantId: 1 }, { unique: true });

const inventoryAdjustmentSchema = new mongoose.Schema(
  {
    _id: stringId("einvadj"),
    tenantId: tenantField,
    productId: { type: String, required: true, index: true },
    inventoryId: { type: String, required: true },
    deltaQuantity: integerField({ required: true }),
    quantityOnHandBefore: integerField({ min: 0 }),
    quantityOnHandAfter: integerField({ min: 0 }),
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    actorUserId: String,
  },
  baseOptions,
);
inventoryAdjustmentSchema.index({ tenantId: 1, productId: 1, createdAt: -1 });

const codManualRefundSchema = new mongoose.Schema(
  {
    amountPaise: integerField({ min: 1 }),
    recipient: { type: String, trim: true, maxlength: 200 },
    method: { type: String, trim: true, maxlength: 64 },
    reference: { type: String, trim: true, maxlength: 120 },
    proofNote: { type: String, trim: true, maxlength: 500 },
    recordedAt: Date,
    recordedByUserId: String,
    idempotencyKey: { type: String, trim: true, maxlength: 80 },
  },
  { _id: false },
);

const codRefundContextSchema = new mongoose.Schema(
  {
    remittanceContext: enumField(EcommerceCodRefundRemittanceContext),
    fundingSource: enumField(EcommerceCodRefundFundingSource),
    capturedAt: Date,
    note: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const orderCancellationRequestSchema = new mongoose.Schema(
  {
    _id: stringId("ecan"),
    tenantId: tenantField,
    orderId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    kind: enumField(EcommerceOrderCancellationKind, { required: true }),
    status: enumField(EcommerceOrderCancellationRequestStatus, {
      default: EcommerceOrderCancellationRequestStatus.PENDING_DECISION,
    }),
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    decisionReason: { type: String, trim: true, maxlength: 2000 },
    requesterType: { type: String, trim: true, maxlength: 32 },
    requesterId: String,
    decidedAt: Date,
    decidedByUserId: String,
    stockDisposition: enumField(EcommerceCancellationStockDisposition),
    stockDispositionAt: Date,
    stockDispositionByUserId: String,
    stockDispositionIdempotencyKey: { type: String, trim: true, maxlength: 80 },
    onlineRefundId: String,
    codManualRefund: codManualRefundSchema,
    codRefundContext: codRefundContextSchema,
    idempotencyKey: { type: String, trim: true, maxlength: 80 },
    creationBodyHash: { type: String, trim: true, maxlength: 64 },
    version: versionField,
  },
  baseOptions,
);
orderCancellationRequestSchema.index({ tenantId: 1, orderId: 1, createdAt: -1 });
orderCancellationRequestSchema.index(
  { tenantId: 1, orderId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: {
        $in: [
          EcommerceOrderCancellationRequestStatus.PENDING_DECISION,
          EcommerceOrderCancellationRequestStatus.APPROVED_PROCESSING,
        ],
      },
    },
    name: "ecommerce_order_active_cancellation_unique",
  },
);
orderCancellationRequestSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
    name: "ecommerce_cancellation_idempotency_tenant_key",
  },
);

const orderReturnRequestSchema = new mongoose.Schema(
  {
    _id: stringId("eret"),
    tenantId: tenantField,
    orderId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    kind: enumField(EcommerceOrderReturnKind, { required: true }),
    status: enumField(EcommerceOrderReturnRequestStatus, {
      default: EcommerceOrderReturnRequestStatus.PENDING_REVIEW,
    }),
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    evidenceNote: { type: String, trim: true, maxlength: 1000 },
    policySnapshotVersion: Number,
    decisionReason: { type: String, trim: true, maxlength: 2000 },
    inspectionNote: { type: String, trim: true, maxlength: 2000 },
    inspectionOutcome: { type: String, trim: true, maxlength: 64 },
    onlineRefundId: String,
    manualRefundRecordedAt: Date,
    manualRefundProof: {
      amountPaise: Number,
      recipient: String,
      method: String,
      reference: String,
      proofNote: String,
      recordedByUserId: String,
      idempotencyKey: String,
    },
    replacementOrderId: String,
    resolutionNote: { type: String, trim: true, maxlength: 2000 },
    manualSettlementNote: { type: String, trim: true, maxlength: 2000 },
    stockRestockedAt: Date,
    statusHistory: [
      {
        status: String,
        at: Date,
        actorType: String,
        actorId: String,
        note: { type: String, trim: true, maxlength: 2000 },
      },
    ],
    idempotencyKey: { type: String, trim: true, maxlength: 80 },
    creationBodyHash: { type: String, trim: true, maxlength: 64 },
    version: versionField,
  },
  baseOptions,
);
orderReturnRequestSchema.index({ tenantId: 1, orderId: 1, createdAt: -1 });
orderReturnRequestSchema.index(
  { tenantId: 1, orderId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: {
        $in: [
          EcommerceOrderReturnRequestStatus.PENDING_REVIEW,
          EcommerceOrderReturnRequestStatus.APPROVED,
          EcommerceOrderReturnRequestStatus.RECEIVED,
          EcommerceOrderReturnRequestStatus.INSPECTED,
        ],
      },
    },
    name: "ecommerce_order_active_return_unique",
  },
);
orderReturnRequestSchema.index(
  { tenantId: 1, replacementOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: { replacementOrderId: { $type: "string", $gt: "" } },
    name: "ecommerce_return_replacement_order_unique",
  },
);

const codRemittanceBatchSchema = new mongoose.Schema(
  {
    _id: stringId("ecrb"),
    tenantId: tenantField,
    providerId: { type: String, trim: true, maxlength: 64, default: "MANUAL" },
    statementReference: { type: String, trim: true, maxlength: 160, default: "" },
    status: enumField(EcommerceCodRemittanceBatchStatus, {
      default: EcommerceCodRemittanceBatchStatus.DRAFT,
    }),
    grossTotalPaise: optionalIntegerField({ min: 0 }),
    feeTotalPaise: optionalIntegerField({ min: 0 }),
    deductionTotalPaise: optionalIntegerField({ min: 0 }),
    netExpectedPaise: optionalIntegerField({ min: 0 }),
    bankCreditReference: { type: String, trim: true, maxlength: 160 },
    bankCreditedAt: Date,
    reconciliationStatus: enumField(EcommerceCodRemittanceReconciliationStatus, {
      default: EcommerceCodRemittanceReconciliationStatus.PENDING,
    }),
    reconciliationNote: { type: String, trim: true, maxlength: 500 },
    importSource: { type: String, trim: true, maxlength: 32, default: "MANUAL" },
    idempotencyKey: { type: String, trim: true, maxlength: 80 },
    creationBodyHash: { type: String, trim: true, maxlength: 64 },
    reconcileIdempotencyKey: { type: String, trim: true, maxlength: 80 },
    reconcileBodyHash: { type: String, trim: true, maxlength: 64 },
    bankCreditPaise: optionalIntegerField({ min: 0 }),
    createdByUserId: String,
    finalizedAt: Date,
    version: versionField,
  },
  baseOptions,
);
codRemittanceBatchSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
codRemittanceBatchSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
  },
);
codRemittanceBatchSchema.index(
  { tenantId: 1, providerId: 1, bankCreditReference: 1 },
  {
    unique: true,
    partialFilterExpression: {
      bankCreditReference: { $type: "string", $gt: "" },
      status: { $in: [EcommerceCodRemittanceBatchStatus.BANK_RECONCILED, EcommerceCodRemittanceBatchStatus.DISCREPANCY] },
    },
    name: "ecommerce_cod_remittance_bank_credit_unique",
  },
);

const codRemittanceLineSchema = new mongoose.Schema(
  {
    _id: stringId("ecrl"),
    tenantId: tenantField,
    batchId: { type: String, required: true, index: true },
    orderId: { type: String, required: true, index: true },
    grossPaise: integerField({ min: 1 }),
    feePaise: optionalIntegerField({ min: 0 }),
    netPaise: optionalIntegerField({ min: 0 }),
    status: enumField(EcommerceCodRemittanceLineStatus, {
      default: EcommerceCodRemittanceLineStatus.ACTIVE,
    }),
    idempotencyKey: { type: String, trim: true, maxlength: 80 },
    creationBodyHash: { type: String, trim: true, maxlength: 64 },
    version: versionField,
  },
  baseOptions,
);
codRemittanceLineSchema.index({ tenantId: 1, batchId: 1, orderId: 1 }, { unique: true });
codRemittanceLineSchema.index(
  { tenantId: 1, batchId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
  },
);
codRemittanceLineSchema.index(
  { tenantId: 1, orderId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: EcommerceCodRemittanceLineStatus.ACTIVE,
    },
    name: "ecommerce_cod_remittance_active_order_unique",
  },
);

export const EcommerceCustomerAddress = mongoose.model(
  "EcommerceCustomerAddress",
  addressSchema,
);
export const EcommerceCart = mongoose.model("EcommerceCart", cartSchema);
export const EcommerceInventory = mongoose.model("EcommerceInventory", inventorySchema);
export const EcommercePriceQuote = mongoose.model("EcommercePriceQuote", quoteSchema);
export const EcommerceOrder = mongoose.model("EcommerceOrder", orderSchema);
export const EcommerceOrderEvent = mongoose.model("EcommerceOrderEvent", orderEventSchema);
export const EcommercePaymentAttempt = mongoose.model(
  "EcommercePaymentAttempt",
  paymentAttemptSchema,
);
export const EcommercePaymentAttemptEvent = mongoose.model(
  "EcommercePaymentAttemptEvent",
  paymentAttemptEventSchema,
);
export const EcommercePaymentExceptionRefund = mongoose.model(
  "EcommercePaymentExceptionRefund",
  paymentExceptionRefundSchema,
);
export const EcommerceOrderCancellationRequest = mongoose.model(
  "EcommerceOrderCancellationRequest",
  orderCancellationRequestSchema,
);
export const EcommerceOrderReturnRequest = mongoose.model(
  "EcommerceOrderReturnRequest",
  orderReturnRequestSchema,
);
export const EcommerceStockReservation = mongoose.model(
  "EcommerceStockReservation",
  stockReservationSchema,
);
export const EcommerceFulfilmentSettings = mongoose.model(
  "EcommerceFulfilmentSettings",
  fulfilmentSettingsSchema,
);
export const EcommerceInventoryAdjustment = mongoose.model(
  "EcommerceInventoryAdjustment",
  inventoryAdjustmentSchema,
);
export const EcommerceCodRemittanceBatch = mongoose.model(
  "EcommerceCodRemittanceBatch",
  codRemittanceBatchSchema,
);
export const EcommerceCodRemittanceLine = mongoose.model(
  "EcommerceCodRemittanceLine",
  codRemittanceLineSchema,
);
