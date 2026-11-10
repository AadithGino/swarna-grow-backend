import mongoose from "mongoose";
import { CustomerLoginMode, KycType, PlanTier, SignupStatus, SubscriptionStatus, TenantStatus, UserStatus, UserType } from "../constants/enums.js";
import { baseOptions, branchField, enumField, integerField, stringId, tenantField, versionField } from "./schema-helpers.js";

const subscriptionSchema = new mongoose.Schema({
  tier: enumField(PlanTier, { default: PlanTier.STARTER }), status: enumField(SubscriptionStatus, { default: SubscriptionStatus.TRIAL }),
  planId: String, billingCycle: String,
  startsAt: Date, renewsAt: Date, trialEndsAt: Date, graceEndsAt: Date,
  limits: { activeCustomers: Number, branches: Number, staff: Number, schemePlans: Number, whatsappMessages: Number },
  limitOverrides: mongoose.Schema.Types.Mixed,
  featureOverrides: mongoose.Schema.Types.Mixed,
  features: { type: [String], default: [] },
  planFeaturesSnapshot: mongoose.Schema.Types.Mixed,
  extensionReason: String, cancelReason: String,
}, { _id: false });
const integrationSecretsSchema = new mongoose.Schema({
  phonepe: {
    provider: String,
    clientId: String,
    clientSecret: String,
    clientVersion: Number,
    credentialVersion: { type: Number, default: 1 },
    webhookUsername: String,
    webhookPassword: String,
    environment: String,
    verifiedAt: Date,
    verificationStatus: String,
  },
  fcm: {
    projectId: String,
    serviceAccountJsonSealed: { type: String, select: false },
    credentialVersion: { type: Number, default: 1 },
    updatedAt: Date,
  },
  messageCentral: {
    provider: String,
    customerId: String,
    keySealed: String,
    /** Pre-issued VerifyNow auth JWT when no password key is supplied. */
    authTokenSealed: String,
    email: String,
    countryCode: { type: String, default: "91" },
    flowType: { type: String, default: "SMS" },
    otpLength: { type: Number, default: 6 },
    credentialVersion: { type: Number, default: 1 },
    verifiedAt: Date,
    verificationStatus: String,
  },
}, { _id: false });

const tenantAddressSchema = new mongoose.Schema(
  { line1: String, city: String, state: String, pincode: String },
  { _id: false },
);

const tenantOperationsSchema = new mongoose.Schema(
  {
    multiSchemePerCustomer: { type: Boolean },
    kycMandatory: { type: Boolean },
    requireKycForRedemption: { type: Boolean },
    kycAllowedTypes: {
      type: [String],
      default: ["AADHAAR", "PAN"],
      validate: {
        validator(values) {
          if (!Array.isArray(values) || values.length === 0) return false;
          const allowed = new Set(Object.values(KycType));
          if (values.length !== new Set(values).size) return false;
          return values.every((value) => allowed.has(value));
        },
        message: "kycAllowedTypes must be unique enum-backed KYC types",
      },
    },
    customerSelfEnrolEnabled: { type: Boolean, default: true },
    customerSelfRegistrationEnabled: { type: Boolean, default: true },
    customerLoginMode: enumField(CustomerLoginMode, { default: CustomerLoginMode.OTP_ONLY }),
    customerAppWriteEnabled: { type: Boolean, default: true },
    customerAppPaymentsEnabled: { type: Boolean, default: true },
    agentCanRegisterCustomers: { type: Boolean, default: false },
    agentCanEnrolSchemes: { type: Boolean, default: false },
    receiptPrefix: { type: String, default: "" },
    receiptNumberFormat: { type: String, default: "{prefix}/{branchCode}/{year}/{seq:6}" },
    passbookNumberFormat: { type: String, default: "{branchCode}/{year}/{seq:5}" },
    schemeNumberFormat: { type: String, default: "{branchCode}/{planCode}/{year}/{seq:5}" },
    goldPurity: { type: String, enum: ["22K"], default: "22K" },
    weightRoundingMode: { type: String, default: "HALF_UP" },
    paymentReversalWindowHours: { type: Number, default: 48 },
    redemptionApprovalRequired: { type: Boolean, default: true },
    termsAndConditions: { type: String, default: "" },
    ecommerceEnabled: { type: Boolean, default: false },
    /** Tenant opt-in for live ecommerce PhonePe checkout (with platform ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED). */
    ecommercePaymentsRolloutEnabled: { type: Boolean, default: false },
    digitalMetalsEnabled: { type: Boolean, default: false },
    digitalMetalsPaused: { type: Boolean, default: false },
    digitalMetalsPauseReason: { type: String, default: "" },
    digitalMetalsPausedAt: Date,
    digitalMetalsPausedBy: String,
    /** Platform-only emergency pause (tenant cannot clear via settings). */
    digitalMetalsPlatformPaused: { type: Boolean, default: false },
    digitalMetalsPlatformPauseReason: { type: String, default: "" },
    /** U1 — platform approval bound to tax profile fingerprint (invalidates on settings/tax change). */
    digitalMetalsTaxProfileApprovedAt: Date,
    digitalMetalsTaxProfileFingerprint: { type: String, default: "" },
    /** U2 — published terms version + immutable content hash (see DigitalMetalTermsPublication). */
    digitalMetalsTermsVersion: { type: String, default: "" },
    digitalMetalsTermsContentHash: { type: String, default: "" },
  },
  { _id: false },
);

const tenantSchema = new mongoose.Schema({
  _id: stringId("tnt"), code: { type: String, required: true, uppercase: true, trim: true }, name: { type: String, required: true, trim: true },
  status: enumField(TenantStatus, { default: TenantStatus.PENDING_SETUP }),
  // Demo tenants never have a real mobile (it would collide with the global unique index
  // below and is meaningless for a tenant nobody signs into as an owner). Live tenants are
  // unaffected. See docs/demo-builder-phase-1-2-foundation.md for the two-phase index rollout.
  mobile: { type: String, required: function requiredTenantMobile() { return !this.isDemo; } },
  email: String, gstin: String,
  displayName: String, supportNumber: String,
  address: { type: tenantAddressSchema, default: undefined },
  branding: {
    logoUploadId: String, primaryColor: String, accentColor: String, displayName: String,
    // Demo Builder splash config (plan section 4.1). Unused by live tenants.
    splashBackgroundColor: String, splashTagline: String,
    splashEnabled: { type: Boolean, default: true },
    /** Bumped on any branding change so clients can invalidate cached branding/CSS vars. */
    revision: integerField({ min: 0, default: 1 }),
  },
  // --- Demo Builder (plan section 4.1) ---
  /** True only for a tenant created by Demo Builder provisioning. Never settable through any public/customer/ordinary tenant update schema — only controlled platform provisioning sets this. */
  isDemo: { type: Boolean, default: false },
  demoInstanceId: { type: String, default: null },
  demoGenerationId: { type: String, default: null },
  demoTemplateVersionId: { type: String, default: null },
  /** Prospect's own contact number for Platform Manager display. Never used as a demo customer login identity. */
  prospectContactMobile: { type: String, default: null },
  settings: {
    timezone: { type: String, default: "Asia/Kolkata" },
    currency: { type: String, default: "INR" },
    requireKycForEnrolment: { type: Boolean, default: false },
    requireKycForRedemption: { type: Boolean, default: false },
    oneActiveSchemePerCustomer: { type: Boolean, default: false },
    customerAppMaintenance: { type: Boolean, default: false },
    reminderConfig: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  operations: { type: tenantOperationsSchema, default: () => ({}) },
  subscription: { type: subscriptionSchema, default: () => ({}) },
  usageCounters: {
    activeCustomers: { type: Number, default: null },
    activeCustomersSeededAt: Date,
  },
  featureFlags: { type: Map, of: Boolean, default: {} },
  integrationSecrets: { type: integrationSecretsSchema, select: false },
  goLiveAt: Date,
  suspendReason: String,
  version: versionField,
}, baseOptions);
tenantSchema.index({ code: 1 }, { unique: true });
// Target state (plan section 4.1): mobile is unique only among live tenants. This partial
// index is declared now but is NOT yet the live index — scripts/sync-indexes.js is the only
// thing that applies it, and only after scripts/migrate-tenant-demo-mobile-index.mjs has
// backfilled isDemo:false on every existing tenant and an operator has audited that no live
// tenant is missing a mobile. The old unconditional unique index below must keep running
// until that rollout is verified; dropping it is a separate, explicit --confirm-drop step.
tenantSchema.index(
  { mobile: 1 },
  {
    name: "mobile_1_live_only",
    unique: true,
    partialFilterExpression: { isDemo: false, mobile: { $type: "string" } },
  },
);
// TODO(demo-builder-rollout): remove this line once mobile_1_live_only is live and this
// old unconditional unique index has been dropped via scripts/sync-indexes.js --apply-drops
// --confirm-drop mobile_1.
tenantSchema.index({ mobile: 1 }, { name: "mobile_1", unique: true });
tenantSchema.index({ isDemo: 1, status: 1, demoInstanceId: 1 });

const branchAddressSchema = new mongoose.Schema(
  { line1: String, city: String, pincode: String },
  { _id: false },
);

const branchSchema = new mongoose.Schema({
  _id: stringId("brn"), tenantId: tenantField, code: { type: String, required: true, uppercase: true }, name: { type: String, required: true },
  mobile: String, email: String, address: { type: branchAddressSchema, default: undefined }, contactNumber: String, isHeadOffice: { type: Boolean, default: false }, active: { type: Boolean, default: true }, version: versionField,
}, baseOptions);
branchSchema.index({ tenantId: 1, code: 1 }, { unique: true });

const userSchema = new mongoose.Schema({
  _id: stringId("usr"), type: enumField(UserType, { required: true }), tenantId: { type: String, default: null, index: true }, branchId: branchField,
  role: { type: String, required: true }, name: { type: String, required: true },
  mobile: { type: String, required: function requiredMobile() { return this.type !== UserType.PLATFORM_USER; } },
  email: String,
  passwordHash: { type: String, select: false }, status: enumField(UserStatus, { default: UserStatus.ACTIVE }), permissions: { type: [String], default: [] }, permissionOverrides: { type: [String], default: [] },
  mustSetPassword: { type: Boolean, default: false }, mfaEnabled: { type: Boolean, default: false }, fcmTokens: { type: [{ tokenHash: String, tokenSealed: { type: String, select: false }, deviceId: String, platform: String, updatedAt: Date }], select: false, default: [] }, lastSeenAt: Date, securityVersion: integerField({ min: 0 }), version: versionField,
}, baseOptions);
userSchema.index({ tenantId: 1, mobile: 1, type: 1 }, { unique: true });

const sessionSchema = new mongoose.Schema({
  _id: stringId("ses"), userId: { type: String, index: true }, customerId: { type: String, index: true }, tenantId: { type: String, index: true },
  deviceId: { type: String, required: true }, familyId: { type: String, required: true, index: true }, refreshTokenHash: { type: String, required: true, unique: true, select: false },
  platform: String, appVersion: String, userAgent: String, ip: String, expiresAt: { type: Date, required: true }, consumedAt: Date, revokedAt: Date, lastUsedAt: Date,
  // --- Demo Builder (plan section 4.1 / 6.1) ---
  // NOT YET ENFORCED: authenticate()/refresh() in auth.middleware.js and token.service.js do
  // not read these fields yet. They exist so a future session/token change has a stable shape
  // to write into; see docs/demo-builder-phase-1-2-foundation.md for exactly what phase 3/5
  // still needs to wire up (signed-claim scope, generation-change rejection, link-version checks).
  demoSession: { type: Boolean, default: false },
  demoInstanceId: { type: String, default: null },
  demoGenerationId: { type: String, default: null },
  demoLinkVersion: { type: Number, default: null },
}, baseOptions);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ demoInstanceId: 1, demoSession: 1 });

const signupSchema = new mongoose.Schema({
  _id: stringId("sgn"), mobile: { type: String, required: true }, businessName: String, ownerName: String, email: String, city: String,
  tenantCode: { type: String, uppercase: true }, otpHash: String, otpExpiresAt: Date, otpVerifiedAt: Date,
  selectedPlanTier: enumField(PlanTier), subscriptionPlanId: String, billingCycle: String,
  signupTokenHash: { type: String, select: false }, signupTokenExpiresAt: Date,
  paymentSessionId: String, paymentRedirectUrl: String, paymentReference: String, paymentInitiatedAt: Date,
  provisionedTenantId: String, ownerSetupTokenId: String, ownerSetupTokenPlain: { type: String, select: false },
  status: enumField(SignupStatus, { default: SignupStatus.OTP_PENDING }), expiresAt: Date,
}, baseOptions);
signupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const passwordResetTokenSchema = new mongoose.Schema({
  _id: stringId("prt"), userId: { type: String, required: true, index: true }, tenantId: { type: String, index: true },
  purpose: { type: String, default: "PASSWORD_RESET" },
  tokenHash: { type: String, required: true, unique: true }, expiresAt: { type: Date, required: true }, consumedAt: Date,
}, baseOptions);
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Tenant = mongoose.model("Tenant", tenantSchema);
export const Branch = mongoose.model("Branch", branchSchema);
export const User = mongoose.model("User", userSchema);
export const Session = mongoose.model("Session", sessionSchema);
export const Signup = mongoose.model("Signup", signupSchema);
export const PasswordResetToken = mongoose.model("PasswordResetToken", passwordResetTokenSchema);
