const makeEnum = (...values) =>
  Object.freeze(Object.fromEntries(values.map((value) => [value, value])));

export const TenantStatus = makeEnum(
  "PENDING_SETUP",
  "ACTIVE",
  "SUSPENDED",
  "CANCELLED",
);
export const SubscriptionStatus = makeEnum(
  "TRIAL",
  "ACTIVE",
  "PAST_DUE",
  "GRACE",
  "SUSPENDED",
  "CANCELLED",
);
export const PlanTier = makeEnum("STARTER", "GROWTH", "PRO", "CUSTOM");
export const UserType = makeEnum("PLATFORM_USER", "TENANT_USER", "CUSTOMER");
export const PlatformRole = makeEnum("SUPER_ADMIN");
export const TenantRole = makeEnum(
  "TENANT_OWNER",
  "TENANT_ADMIN",
  "BRANCH_MANAGER",
  "BRANCH_STAFF",
  "COLLECTION_AGENT",
);
export const SignupAvailabilityReason = makeEnum(
  "MOBILE_ALREADY_REGISTERED",
  "TENANT_CODE_TAKEN",
);
export const PasswordTokenPurpose = makeEnum("PASSWORD_RESET", "OWNER_SETUP");
export const UserStatus = makeEnum("ACTIVE", "INACTIVE");
export const CustomerStatus = makeEnum("ACTIVE", "BLOCKED", "INACTIVE");
export const CustomerLoginMode = makeEnum("OTP_ONLY", "PASSWORD_ONLY");
export const KycType = makeEnum("AADHAAR", "PAN");
export const KycStatus = makeEnum(
  "NOT_SUBMITTED",
  "SUBMITTED",
  "VERIFIED",
  "REJECTED",
);
export const ValueBasis = makeEnum("CASH", "GOLD_WEIGHT");
export const PaymentPattern = makeEnum("FIXED", "FLEXIBLE");
export const AmountMode = makeEnum(
  "JEWELLER_FIXED",
  "JEWELLER_SLABS",
  "CUSTOMER_CHOSEN",
);
export const DueDateRule = makeEnum("FIXED_DAY_OF_MONTH", "JOIN_ANNIVERSARY");
export const FirstInstallmentMode = makeEnum("COLLECT_NOW", "START_NEXT_CYCLE");
export const FirstInstallmentAction = makeEnum(
  "RECORD_MANUAL_PAYMENT",
  "CREATE_PAYMENT_LINK",
);
export const BenefitType = makeEnum(
  "FIXED_BONUS_AMOUNT",
  "ONE_FREE_INSTALLMENT",
  "TEXT_ONLY",
);
export const BonusBasis = makeEnum("FLAT", "PERCENT_OF_PAID");
export const SchemePlanStatus = makeEnum("DRAFT", "ACTIVE", "INACTIVE");
export const SchemeStatus = makeEnum(
  "PENDING_PAYMENT",
  "ENROLMENT_EXPIRED",
  "ACTIVE",
  "LOCKED",
  "DEFAULTED",
  "MATURED",
  "REDEEMED",
  "CLOSED_PREMATURE",
);
export const SchemeDisplayMode = makeEnum(
  "FIXED",
  "FLEXIBLE_FREE_WINDOW",
  "FLEXIBLE_LOCK_WINDOW",
);
export const FlexiblePhase = makeEnum("FLEXIBLE", "CAPPED");
export const CycleStatus = makeEnum(
  "UPCOMING",
  "PARTIALLY_PAID",
  "PAID",
  "EXPIRED",
);
export const InstallmentStatus = makeEnum(
  "PENDING",
  "DUE",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "WAIVED",
);
export const PaymentMode = makeEnum(
  "CASH",
  "CARD",
  "UPI",
  "BANK_TRANSFER",
  "ONLINE_GATEWAY",
  "LEGACY_ONLINE",
);
export const ManualPaymentMode = makeEnum(
  "CASH",
  "CARD",
  "UPI",
  "BANK_TRANSFER",
);
export const PaymentIntentStatus = makeEnum(
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
);
export const PaymentStatus = makeEnum(
  "PENDING",
  "SUCCESS",
  "FAILED",
  "AMOUNT_MISMATCH_PENDING_REVIEW",
  "UNALLOCATED_PENDING_REVIEW",
  "PARTIALLY_REFUNDED",
  "REVERSED",
);
export const PaymentSource = makeEnum(
  "PORTAL",
  "STAFF_APP",
  "CUSTOMER_APP",
  "WEBHOOK",
  "SYSTEM",
);
export const LinkStatus = makeEnum(
  "CREATED",
  "SENT",
  "OPENED",
  "PAID",
  "EXPIRED",
  "CANCELLED",
);
export const LedgerEntryType = makeEnum(
  "INSTALLMENT_PAYMENT",
  "FREE_WINDOW_PAYMENT",
  "UNALLOCATED_PAYMENT",
  "BENEFIT_CREDIT",
  "REVERSAL",
  "CLOSURE_PENALTY",
  "REDEMPTION_DEBIT",
  "ADJUSTMENT",
);
export const LateSuccessDetection = makeEnum("WEBHOOK", "RECONCILIATION_JOB");
export const GatewayRefundStatus = makeEnum(
  "PENDING",
  "PENDING_RECONCILIATION",
  "ACCEPTED",
  "COMPLETED",
  "FAILED",
);
export const RedemptionMode = makeEnum(
  "CASH",
  "GOLD_HANDOVER",
  "PURCHASE_ADJUSTMENT",
);
/** Gold-weight plan cash payout valuation (frozen in enrollment planSnapshot). */
export const CashSettlementBasis = makeEnum("GOLD_VALUE", "PAID_AMOUNT");
/** Monetary benefit inclusion when cashSettlementBasis is PAID_AMOUNT. */
export const PaidAmountBenefitTreatment = makeEnum("EXCLUDE", "INCLUDE_MONETARY");
export const RedemptionStatus = makeEnum(
  "REQUESTED",
  "PENDING_APPROVAL",
  "APPROVED",
  "COMPLETED",
  "REJECTED",
);
export const ClosureType = makeEnum("MATURITY_REDEMPTION", "PREMATURE_CLOSURE");
export const MessageType = makeEnum(
  "OTP",
  "SCHEME_JOINED",
  "PAYMENT_DUE",
  "PAYMENT_OVERDUE",
  "PAYMENT_SUCCESS",
  "FLEXI_LOCK_APPLIED",
  "SCHEME_MATURED",
  "SCHEME_CLOSED",
  "CUSTOMER_STATEMENT",
  "MANUAL_PUSH",
  "ECOMMERCE_ORDER_CONFIRMED",
  "ECOMMERCE_PAYMENT_FAILED",
  "ECOMMERCE_PAYMENT_EXPIRED",
  "ECOMMERCE_REFUND_COMPLETED",
  "ECOMMERCE_FULFILMENT_UPDATE",
  "ECOMMERCE_CANCELLATION_UPDATE",
  "ECOMMERCE_COD_UPDATE",
);
export const MessageTemplateKey = makeEnum(
  "PAYMENT_SUCCESS_MEDIA",
  "PAYMENT_SUCCESS_TEXT_FALLBACK",
);
export const MessageStatus = makeEnum(
  "QUEUED",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
);
export const CashHandoverStatus = makeEnum(
  "PENDING",
  "ACCEPTED",
  "DISCREPANCY",
  "REJECTED",
  "CANCELLED",
);
export const HandoverInitiator = makeEnum("STAFF", "ADMIN");
export const ExportStatus = makeEnum(
  "QUEUED",
  "PROCESSING",
  "READY",
  "FAILED",
  "EXPIRED",
);
export const NomineeRelationship = makeEnum(
  "SPOUSE",
  "PARENT",
  "CHILD",
  "SIBLING",
  "RELATIVE",
  "FRIEND",
  "OTHER",
);
export const GrievanceCategory = makeEnum(
  "PAYMENT",
  "RECEIPT",
  "SCHEME_RULE",
  "GOLD_CREDIT",
  "MATURITY",
  "REDEMPTION",
  "KYC",
  "WHATSAPP",
  "STAFF_SERVICE",
  "OTHER",
);
export const GrievancePriority = makeEnum("LOW", "NORMAL", "HIGH", "URGENT");
export const GrievanceStatus = makeEnum(
  "OPEN",
  "IN_PROGRESS",
  "WAITING_FOR_CUSTOMER",
  "RESOLVED",
  "CLOSED",
);
export const GrievanceMessageType = makeEnum(
  "PUBLIC_REPLY",
  "INTERNAL_NOTE",
  "SYSTEM_EVENT",
);
export const AuditActorType = makeEnum("USER", "CUSTOMER", "SYSTEM", "WEBHOOK");
export const AuditEntityType = makeEnum(
  "TENANT",
  "CUSTOMER",
  "SCHEME",
  "PAYMENT",
  "PAYMENT_LINK",
  "PAYMENT_INTENT",
  "GRIEVANCE",
  "CASH_HANDOVER",
  "REDEMPTION",
  "MESSAGE",
  "GOLD_RATE",
  "STAFF",
  "BRANCH",
  "PLAN",
  "SUBSCRIPTION",
  "INVOICE",
  "TEMPLATE",
  "ECOMMERCE_CATEGORY",
  "ECOMMERCE_BANNER",
  "ECOMMERCE_PRODUCT",
  "ECOMMERCE_GOLD_RATE",
  "ECOMMERCE_TAX_SETTINGS",
  "ECOMMERCE_INVENTORY",
  "ECOMMERCE_FULFILMENT_SETTINGS",
);
export const EcommerceProductStatus = makeEnum("DRAFT", "PUBLISHED", "ARCHIVED");
export const EcommerceBannerStatus = makeEnum("DRAFT", "PUBLISHED", "ARCHIVED");
export const EcommerceBannerPlacement = makeEnum("HOME", "SHOP", "BOTH");
export const EcommerceBannerDestination = makeEnum(
  "NONE",
  "HOME",
  "SHOP",
  "CATEGORY",
  "PRODUCT",
  "SCHEMES",
  "ORDERS",
);
export const EcommercePriceMode = makeEnum("FIXED", "GOLD_RATE_BASED");
export const EcommerceGoldPurity = makeEnum("18K", "22K", "24K");
export const EcommerceMakingChargeMode = makeEnum(
  "FIXED_PAISE",
  "PER_GRAM_PAISE",
  "PERCENT_OF_GOLD",
);
export const EcommerceOfferType = makeEnum("FIXED_PAISE_OFF", "PERCENT_OFF");
/** Inventory: tracked SKU quantity vs made-to-order (no stock field). */
export const EcommerceStockPolicy = makeEnum("QUANTITY_TRACKED", "MADE_TO_ORDER");
/** Accountant-entered component lines; platform does not infer CGST/SGST/IGST. */
export const EcommerceCheckoutTaxPresentation = makeEnum(
  "UNCONFIGURED",
  "SINGLE_ESTIMATE_ONLY",
  "ACCOUNTANT_COMPONENT_APPROVED",
);
export const EcommerceFulfilmentMode = makeEnum("BRANCH_PICKUP", "DELIVERY");
export const EcommercePaymentMethod = makeEnum("ONLINE", "COD");
export const EcommerceQuoteStatus = makeEnum(
  "ACTIVE",
  "EXPIRED",
  "CONSUMED",
  "CANCELLED",
);
export const EcommerceOrderStatus = makeEnum(
  "PENDING_PAYMENT",
  "PAYMENT_EXPIRED",
  "PAYMENT_FAILED",
  "COD_PENDING_ACCEPTANCE",
  "PAID",
  "PROCESSING",
  "READY_FOR_PICKUP",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "REFUND_PENDING",
  "REFUNDED",
);
/** Courier-reported COD collection on delivery (manual or integration). */
export const EcommerceCourierCodCollectionStatus = makeEnum(
  "NOT_APPLICABLE",
  "PENDING",
  "CONFIRMED",
  "NEEDS_REVIEW",
);
export const EcommerceCourierCodCollectionSource = makeEnum(
  "MANUAL_OPERATOR",
  "COURIER_INTEGRATION",
);
export const EcommerceCourierCodRemittanceStatus = makeEnum(
  "NOT_APPLICABLE",
  "NOT_DUE",
  "OWED",
  "BATCH_PENDING",
  "BANK_RECONCILED",
  "DISCREPANCY",
);
export const EcommerceCodRemittanceBatchStatus = makeEnum(
  "DRAFT",
  "FINALIZED",
  "BANK_RECONCILED",
  "DISCREPANCY",
  "VOID",
);
export const EcommerceCodRemittanceLineStatus = makeEnum(
  "ACTIVE",
  "RECONCILED",
  "REMOVED",
  "VOID",
);
export const EcommerceCodRemittanceReconciliationStatus = makeEnum(
  "PENDING",
  "MATCHED",
  "SHORT",
  "OVER",
  "NEEDS_REVIEW",
);
export const EcommerceCodRefundRemittanceContext = makeEnum(
  "NOT_COLLECTED",
  "COLLECTED_REMITTANCE_PENDING",
  "COLLECTED_REMITTANCE_RECONCILED",
  "COLLECTED_REMITTANCE_UNKNOWN",
);
export const EcommerceCodRefundFundingSource = makeEnum(
  "NOT_FUNDED",
  "JEWELLER_OUT_OF_POCKET",
  "REMITTANCE_ADJUSTMENT",
  "COURIER_CLAWBACK",
  "UNDETERMINED",
);
export const EcommerceStockReleaseReason = makeEnum(
  "CUSTOMER_CANCEL",
  "PAYMENT_WINDOW_EXPIRED",
  "COD_ACCEPTANCE_EXPIRED",
  "COD_REJECTED",
  "ORDER_SUPERSEDED",
  "CANCELLATION_RESTOCK",
  "CANCELLATION_STOCK_EXCEPTION",
);
export const EcommerceTaxSupplyCase = makeEnum("INTRA_STATE", "INTER_STATE");
export const EcommerceHsnSacType = makeEnum("HSN", "SAC");
export const EcommerceOrderEventType = makeEnum(
  "ORDER_CREATED",
  "QUOTE_ATTACHED",
  "PAYMENT_INITIATED",
  "PAYMENT_SUCCEEDED",
  "PAYMENT_FAILED",
  "PAYMENT_TIMEOUT",
  "PAYMENT_EXPIRED",
  "STOCK_RESERVED",
  "STOCK_RELEASED",
  "FULFILMENT_UPDATED",
  "CANCELLED",
  "REFUND_INITIATED",
  "REFUND_CONFIRMED",
  "REFUND_FAILED",
  "PAYMENT_LATE_SUCCESS_EXCEPTION",
  "PAYMENT_DUPLICATE_SUCCESS_EXCEPTION",
  "PAYMENT_RECONCILED",
  "COD_ORDER_PLACED",
  "COD_ACCEPTED",
  "COD_REJECTED",
  "COD_ACCEPTANCE_EXPIRED",
  "COD_COLLECTION_RECORDED",
  "COURIER_COD_COLLECTION_CONFIRMED",
  "COD_REMITTANCE_BATCH_CREATED",
  "COD_REMITTANCE_LINE_ADDED",
  "COD_REMITTANCE_BATCH_RECONCILED",
  "COD_CUSTODY_HANDOVER_INITIATED",
  "COD_CUSTODY_HANDOVER_ACCEPTED",
  "COD_CUSTODY_BANK_DEPOSIT_RECORDED",
  "COD_CUSTODY_ADJUSTMENT",
  "FULFILMENT_HANDOVER_RECORDED",
  "PICKUP_CODE_ISSUED",
  "COD_MANUAL_REFUND_RECORDED",
  "CANCELLATION_REQUESTED",
  "CANCELLATION_APPROVED",
  "CANCELLATION_REJECTED",
  "CANCELLATION_STOCK_DISPOSITION",
  "CANCELLATION_COMPLETED",
);
export const EcommerceOrderCancellationRequestStatus = makeEnum(
  "PENDING_DECISION",
  "APPROVED_PROCESSING",
  "REJECTED",
  "COMPLETED",
  "WITHDRAWN",
);
export const EcommerceOrderCancellationKind = makeEnum(
  "CUSTOMER_DIRECT",
  "CUSTOMER_REQUEST",
  "ADMIN_INITIATED",
);
export const EcommerceCancellationStockDisposition = makeEnum(
  "RESTOCK_CONFIRMED",
  "STOCK_EXCEPTION",
);
export const EcommerceOrderReturnRequestStatus = makeEnum(
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
  "RECEIVED",
  "INSPECTED",
  "RESOLVED",
  "CLOSED",
);
export const EcommerceOrderReturnKind = makeEnum("RETURN", "EXCHANGE");
export const EcommercePaymentAttemptStatus = makeEnum(
  "PENDING",
  "INITIATED",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
);
export const EcommercePaymentAttemptOperationalStatus = makeEnum(
  "NORMAL",
  "AWAITING_PROVIDER",
  "INITIATION_UNCERTAIN",
  "STUCK_RECONCILE",
);
export const EcommerceOrderPaymentExceptionStatus = makeEnum(
  "LATE_SUCCESS_REFUND_REQUIRED",
  "DUPLICATE_PAYMENT_REFUND_REQUIRED",
);
export const EcommercePaymentExceptionRefundStatus = makeEnum(
  "ASSIGNED",
  "INITIATED",
  "PROVIDER_PENDING",
  "SUCCEEDED",
  "FAILED",
  "MANUAL_RECORDED",
);
export const EcommerceOrderRefundSource = makeEnum(
  "PAYMENT_EXCEPTION",
  "ORDER_CANCELLATION",
  "ORDER_RETURN",
);
export const EcommerceOrderReturnInspectionOutcome = makeEnum(
  "APPROVED_FOR_RESALE",
  "REJECTED_NOT_RESALABLE",
);
export const PhaseMode = makeEnum("SINGLE", "FLEXIBLE_THEN_CAPPED");
export const CapMode = makeEnum("NONE", "FLEXIBLE_PHASE_AVERAGE");
export const CarryForwardMode = makeEnum("NONE");
export const ExportType = makeEnum(
  "DUE",
  "OVERDUE",
  "DEFAULTER",
  "MATURITY",
  "COLLECTION",
  "OUTSTANDING",
  "GOLD_ACCRUAL",
  "STAFF_PERFORMANCE",
  "CUSTOMER",
  "SCHEME",
  "AUDIT",
  "ECOMMERCE_SALES",
  "ECOMMERCE_ORDERS_FULFILMENT",
  "ECOMMERCE_PRODUCTS",
);
export const UploadPurpose = makeEnum(
  "TENANT_LOGO",
  "KYC_DOCUMENT",
  "GRIEVANCE_ATTACHMENT",
  "PUSH_BROADCAST_IMAGE",
  "ECOMMERCE_CATEGORY_IMAGE",
  "ECOMMERCE_PRODUCT_IMAGE",
  "ECOMMERCE_BANNER_IMAGE",
);
export const WebhookProvider = makeEnum("PHONEPE", "WHATSAPP");
export const JobStatus = makeEnum(
  "QUEUED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "SIGNATURE_FAILED",
  "DEAD_LETTER",
  "UNSUPPORTED",
);
/** Queue dispatch lifecycle (messages, outbox, webhooks) — separate from worker JobStatus. */
export const DispatchState = makeEnum("PENDING", "DISPATCHING", "DISPATCHED");
export const BillingCycle = makeEnum("MONTHLY", "ANNUAL");
export const SubscriptionExtensionType = makeEnum("SUBSCRIPTION", "GRACE");
export const InvoiceStatus = makeEnum("DRAFT", "ISSUED", "PAID", "VOID");
export const SignupStatus = makeEnum(
  "OTP_PENDING",
  "OTP_VERIFIED",
  "PLAN_SELECTED",
  "PAYMENT_PENDING",
  "PROVISIONED",
  "EXPIRED",
);
export const MessageChannel = makeEnum("WHATSAPP", "SMS", "PUSH", "EMAIL");
export const DevicePrincipalType = makeEnum("CUSTOMER", "USER");
export const DeviceRegistrationStatus = makeEnum(
  "ACTIVE",
  "INVALIDATED",
  "REVOKED",
);
export const PushDeviceDeliveryStatus = makeEnum(
  "QUEUED",
  "PROCESSING",
  "SUCCEEDED",
  "PERMANENT_FAILED",
  "RETRYABLE_FAILED",
  "DEAD_LETTER",
);
export const UploadStatus = makeEnum(
  "PENDING",
  "UPLOADED",
  "ATTACHED",
  "EXPIRED",
);
export const IdempotencyState = makeEnum("PROCESSING", "COMPLETED");
export const GrievanceRelatedEntityType = makeEnum(
  "PAYMENT",
  "SCHEME",
  "REDEMPTION",
  "ORDER",
);
export const EcommerceFulfilmentHandoverMethod = makeEnum(
  "PICKUP_CODE",
  "DELIVERY_PROOF",
);
export const PrematurePenaltyMode = makeEnum("NONE", "FLAT", "PERCENT_OF_PAID");
export const BenefitTreatment = makeEnum("FORFEIT", "FULL");
export const FlexibleFrequencyMode = makeEnum("MULTIPLE");
export const CapFormula = makeEnum(
  "FLEXIBLE_PHASE_TOTAL_DIV_AVERAGING_DIVISOR",
  "FLEXIBLE_PHASE_TOTAL_DIV_PAYMENT_COUNT",
);
export const CapRoundingMode = makeEnum("ROUND_UP");
export const ZeroFlexibleTotalAction = makeEnum("CLOSE_SCHEME", "USE_MINIMUM");
export const BelowMinimumTotalAction = makeEnum("USE_MINIMUM", "CLOSE_SCHEME");
export const GoldRateSource = makeEnum("TENANT_DAILY_RATE");
export const WeightRoundingMode = makeEnum("HALF_UP", "ROUND_DOWN", "ROUND_UP");
export const AlertSeverity = makeEnum("INFO", "WARNING", "CRITICAL");
export const AlertStatus = makeEnum("OPEN", "DISMISSED", "RESOLVED");
export const AlertType = makeEnum(
  "MISSING_GOLD_RATE",
  "GATEWAY_AMOUNT_MISMATCH",
  "GATEWAY_WEBHOOK_UNMATCHED",
  "GATEWAY_WEBHOOK_INVALID_COMPLETED",
  "GATEWAY_REFUND_PARTIAL",
  "GATEWAY_REFUND_INVALID",
  "GATEWAY_REFUND_UNMATCHED",
  "GATEWAY_REFUND_CURRENCY_MISMATCH",
  "GATEWAY_REFUND_NON_SUCCESS_PAYMENT",
  "GATEWAY_REFUND_DUPLICATE_CONFLICT",
  "GATEWAY_RECONCILE_EXHAUSTED",
  "GATEWAY_UNSUPPORTED_CALLBACK",
  "GATEWAY_SETTLEMENT_MISMATCH",
  "GATEWAY_SETTLEMENT_MISSING",
  "GATEWAY_SETTLEMENT_FAILURE",
  "GATEWAY_SETTLEMENT_MISMATCH_RESOLVED",
  "GATEWAY_REFUND_INITIATION_EXHAUSTED",
  "GATEWAY_REFUND_AMOUNT_UNRESOLVED",
  "WEBHOOK_FAILURE",
  "MESSAGE_FAILURE",
  "PAYMENT_REVIEW",
  "FLEX_SETTLEMENT_REQUIRED",
  "FCM_DELIVERY_EXHAUSTED",
  "SYSTEM_ERROR",
);
export const PostSettlementRefundCaseStatus = makeEnum(
  "PENDING_RESOLUTION",
  "RESOLVED",
);
export const PostSettlementRefundDisposition = makeEnum(
  "RECOVERABLE",
  "WRITE_OFF",
  "OTHER",
);
export const CashAdjustmentDirection = makeEnum("CREDIT", "DEBIT");

export const enumValues = (enumeration) => Object.values(enumeration);
export const isEnumValue = (enumeration, value) =>
  enumValues(enumeration).includes(value);

export const PAYMENT_MODE_ORDER = Object.freeze([
  PaymentMode.CASH,
  PaymentMode.CARD,
  PaymentMode.UPI,
  PaymentMode.BANK_TRANSFER,
  PaymentMode.ONLINE_GATEWAY,
  PaymentMode.LEGACY_ONLINE,
]);

export const PAYMENT_MODE_LABELS = Object.freeze({
  CASH: "Cash",
  CARD: "Card / POS",
  UPI: "UPI",
  BANK_TRANSFER: "Bank transfer",
  ONLINE_GATEWAY: "Online payment",
  LEGACY_ONLINE: "Legacy online",
});
