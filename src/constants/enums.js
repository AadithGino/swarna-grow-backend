const makeEnum = (...values) => Object.freeze(Object.fromEntries(values.map((value) => [value, value])));

export const TenantStatus = makeEnum("PENDING_SETUP", "ACTIVE", "SUSPENDED", "CANCELLED");
export const SubscriptionStatus = makeEnum("TRIAL", "ACTIVE", "PAST_DUE", "GRACE", "SUSPENDED", "CANCELLED");
export const PlanTier = makeEnum("STARTER", "GROWTH", "PRO", "CUSTOM");
export const UserType = makeEnum("PLATFORM_USER", "TENANT_USER", "CUSTOMER");
export const PlatformRole = makeEnum("SUPER_ADMIN");
export const TenantRole = makeEnum("TENANT_OWNER", "TENANT_ADMIN", "BRANCH_MANAGER", "BRANCH_STAFF", "COLLECTION_AGENT");
export const SignupAvailabilityReason = makeEnum("MOBILE_ALREADY_REGISTERED", "TENANT_CODE_TAKEN");
export const PasswordTokenPurpose = makeEnum("PASSWORD_RESET", "OWNER_SETUP");
export const UserStatus = makeEnum("ACTIVE", "INACTIVE");
export const CustomerStatus = makeEnum("ACTIVE", "BLOCKED", "INACTIVE");
export const CustomerLoginMode = makeEnum("OTP_ONLY", "PASSWORD_ONLY");
export const KycType = makeEnum("AADHAAR", "PAN");
export const KycStatus = makeEnum("NOT_SUBMITTED", "SUBMITTED", "VERIFIED", "REJECTED");
export const ValueBasis = makeEnum("CASH", "GOLD_WEIGHT");
export const PaymentPattern = makeEnum("FIXED", "FLEXIBLE");
export const AmountMode = makeEnum("JEWELLER_FIXED", "JEWELLER_SLABS", "CUSTOMER_CHOSEN");
export const DueDateRule = makeEnum("FIXED_DAY_OF_MONTH", "JOIN_ANNIVERSARY");
export const FirstInstallmentMode = makeEnum("COLLECT_NOW", "START_NEXT_CYCLE");
export const FirstInstallmentAction = makeEnum("RECORD_MANUAL_PAYMENT", "CREATE_PAYMENT_LINK");
export const BenefitType = makeEnum("FIXED_BONUS_AMOUNT", "ONE_FREE_INSTALLMENT", "TEXT_ONLY");
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
export const SchemeDisplayMode = makeEnum("FIXED", "FLEXIBLE_FREE_WINDOW", "FLEXIBLE_LOCK_WINDOW");
export const FlexiblePhase = makeEnum("FLEXIBLE", "CAPPED");
export const CycleStatus = makeEnum("UPCOMING", "PARTIALLY_PAID", "PAID", "EXPIRED");
export const InstallmentStatus = makeEnum("PENDING", "DUE", "PARTIALLY_PAID", "PAID", "OVERDUE", "WAIVED");
export const PaymentMode = makeEnum("CASH", "CARD", "UPI", "BANK_TRANSFER", "CHEQUE", "ONLINE_GATEWAY", "LEGACY_ONLINE");
export const ManualPaymentMode = makeEnum("CASH", "CARD", "UPI", "BANK_TRANSFER", "CHEQUE");
export const PaymentIntentStatus = makeEnum("PENDING", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED");
export const PaymentStatus = makeEnum("PENDING", "SUCCESS", "FAILED", "AMOUNT_MISMATCH_PENDING_REVIEW", "UNALLOCATED_PENDING_REVIEW", "REVERSED");
export const PaymentSource = makeEnum("PORTAL", "STAFF_APP", "CUSTOMER_APP", "WEBHOOK", "SYSTEM");
export const LinkStatus = makeEnum("CREATED", "SENT", "OPENED", "PAID", "EXPIRED", "CANCELLED");
export const LedgerEntryType = makeEnum("INSTALLMENT_PAYMENT", "FREE_WINDOW_PAYMENT", "UNALLOCATED_PAYMENT", "BENEFIT_CREDIT", "REVERSAL", "CLOSURE_PENALTY", "REDEMPTION_DEBIT", "ADJUSTMENT");
export const LateSuccessDetection = makeEnum("WEBHOOK", "RECONCILIATION_JOB");
export const GatewayRefundStatus = makeEnum("PENDING", "ACCEPTED", "COMPLETED", "FAILED");
export const RedemptionMode = makeEnum("CASH", "GOLD_HANDOVER", "PURCHASE_ADJUSTMENT");
export const RedemptionStatus = makeEnum("REQUESTED", "PENDING_APPROVAL", "APPROVED", "COMPLETED", "REJECTED");
export const ClosureType = makeEnum("MATURITY_REDEMPTION", "PREMATURE_CLOSURE");
export const MessageType = makeEnum("OTP", "SCHEME_JOINED", "PAYMENT_DUE", "PAYMENT_OVERDUE", "PAYMENT_SUCCESS", "FLEXI_LOCK_APPLIED", "SCHEME_MATURED", "SCHEME_CLOSED", "CUSTOMER_STATEMENT", "MANUAL_PUSH");
export const MessageTemplateKey = makeEnum("PAYMENT_SUCCESS_MEDIA", "PAYMENT_SUCCESS_TEXT_FALLBACK");
export const MessageStatus = makeEnum("QUEUED", "SENT", "DELIVERED", "READ", "FAILED");
export const CashHandoverStatus = makeEnum("PENDING", "ACCEPTED", "DISCREPANCY", "REJECTED", "CANCELLED");
export const HandoverInitiator = makeEnum("STAFF", "ADMIN");
export const ExportStatus = makeEnum("QUEUED", "PROCESSING", "READY", "FAILED", "EXPIRED");
export const NomineeRelationship = makeEnum("SPOUSE", "PARENT", "CHILD", "SIBLING", "RELATIVE", "FRIEND", "OTHER");
export const GrievanceCategory = makeEnum("PAYMENT", "RECEIPT", "SCHEME_RULE", "GOLD_CREDIT", "MATURITY", "REDEMPTION", "KYC", "WHATSAPP", "STAFF_SERVICE", "OTHER");
export const GrievancePriority = makeEnum("LOW", "NORMAL", "HIGH", "URGENT");
export const GrievanceStatus = makeEnum("OPEN", "IN_PROGRESS", "WAITING_FOR_CUSTOMER", "RESOLVED", "CLOSED");
export const GrievanceMessageType = makeEnum("PUBLIC_REPLY", "INTERNAL_NOTE", "SYSTEM_EVENT");
export const AuditActorType = makeEnum("USER", "CUSTOMER", "SYSTEM", "WEBHOOK");
export const AuditEntityType = makeEnum("TENANT", "CUSTOMER", "SCHEME", "PAYMENT", "PAYMENT_LINK", "PAYMENT_INTENT", "GRIEVANCE", "CASH_HANDOVER", "REDEMPTION", "MESSAGE", "GOLD_RATE", "STAFF", "BRANCH", "PLAN", "SUBSCRIPTION", "INVOICE", "TEMPLATE");
export const PhaseMode = makeEnum("SINGLE", "FLEXIBLE_THEN_CAPPED");
export const CapMode = makeEnum("NONE", "FLEXIBLE_PHASE_AVERAGE");
export const CarryForwardMode = makeEnum("NONE");
export const ExportType = makeEnum("DUE", "OVERDUE", "DEFAULTER", "MATURITY", "COLLECTION", "OUTSTANDING", "GOLD_ACCRUAL", "STAFF_PERFORMANCE", "CUSTOMER", "SCHEME", "AUDIT");
export const UploadPurpose = makeEnum("TENANT_LOGO", "KYC_DOCUMENT", "GRIEVANCE_ATTACHMENT", "PUSH_BROADCAST_IMAGE");
export const WebhookProvider = makeEnum("PHONEPE", "WHATSAPP");
export const JobStatus = makeEnum("QUEUED", "PROCESSING", "COMPLETED", "FAILED", "SIGNATURE_FAILED", "DEAD_LETTER");
/** Queue dispatch lifecycle (messages, outbox, webhooks) — separate from worker JobStatus. */
export const DispatchState = makeEnum("PENDING", "DISPATCHING", "DISPATCHED");
export const BillingCycle = makeEnum("MONTHLY", "ANNUAL");
export const SubscriptionExtensionType = makeEnum("SUBSCRIPTION", "GRACE");
export const InvoiceStatus = makeEnum("DRAFT", "ISSUED", "PAID", "VOID");
export const SignupStatus = makeEnum("OTP_PENDING", "OTP_VERIFIED", "PLAN_SELECTED", "PAYMENT_PENDING", "PROVISIONED", "EXPIRED");
export const MessageChannel = makeEnum("WHATSAPP", "SMS", "PUSH", "EMAIL");
export const DevicePrincipalType = makeEnum("CUSTOMER", "USER");
export const DeviceRegistrationStatus = makeEnum("ACTIVE", "INVALIDATED", "REVOKED");
export const PushDeviceDeliveryStatus = makeEnum(
  "QUEUED",
  "PROCESSING",
  "SUCCEEDED",
  "PERMANENT_FAILED",
  "RETRYABLE_FAILED",
  "DEAD_LETTER",
);
export const UploadStatus = makeEnum("PENDING", "UPLOADED", "ATTACHED", "EXPIRED");
export const IdempotencyState = makeEnum("PROCESSING", "COMPLETED");
export const GrievanceRelatedEntityType = makeEnum("PAYMENT", "SCHEME", "REDEMPTION");
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
export const AlertType = makeEnum("MISSING_GOLD_RATE", "GATEWAY_AMOUNT_MISMATCH", "GATEWAY_WEBHOOK_UNMATCHED", "WEBHOOK_FAILURE", "MESSAGE_FAILURE", "PAYMENT_REVIEW", "SYSTEM_ERROR");
export const CashAdjustmentDirection = makeEnum("CREDIT", "DEBIT");

export const enumValues = (enumeration) => Object.values(enumeration);
export const isEnumValue = (enumeration, value) => enumValues(enumeration).includes(value);

export const PAYMENT_MODE_ORDER = Object.freeze([
  PaymentMode.CASH,
  PaymentMode.CARD,
  PaymentMode.UPI,
  PaymentMode.BANK_TRANSFER,
  PaymentMode.CHEQUE,
  PaymentMode.ONLINE_GATEWAY,
  PaymentMode.LEGACY_ONLINE,
]);

export const PAYMENT_MODE_LABELS = Object.freeze({
  CASH: "Cash",
  CARD: "Card / POS",
  UPI: "UPI",
  BANK_TRANSFER: "Bank transfer",
  CHEQUE: "Cheque",
  ONLINE_GATEWAY: "Online payment",
  LEGACY_ONLINE: "Legacy online",
});
