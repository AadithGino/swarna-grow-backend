import mongoose from "mongoose";
import { CustomerLoginMode, PlanTier, SignupStatus, SubscriptionStatus, TenantStatus, UserStatus, UserType } from "../constants/enums.js";
import { baseOptions, branchField, enumField, integerField, stringId, tenantField, versionField } from "./schema-helpers.js";

const subscriptionSchema = new mongoose.Schema({
  tier: enumField(PlanTier, { default: PlanTier.STARTER }), status: enumField(SubscriptionStatus, { default: SubscriptionStatus.TRIAL }),
  planId: String, billingCycle: String,
  startsAt: Date, renewsAt: Date, trialEndsAt: Date, graceEndsAt: Date,
  limits: { activeCustomers: Number, branches: Number, staff: Number, schemePlans: Number, whatsappMessages: Number },
  limitOverrides: mongoose.Schema.Types.Mixed,
  featureOverrides: mongoose.Schema.Types.Mixed,
  features: { type: [String], default: [] },
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
  whatsapp: { provider: String, phoneNumberId: String, businessAccountId: String, accessToken: String, appSecret: String, verifyToken: String, environment: String, callbackUrlOverride: String, verifiedAt: Date, verificationStatus: String },
  fcm: {
    projectId: String,
    serviceAccountJsonSealed: { type: String, select: false },
    credentialVersion: { type: Number, default: 1 },
    updatedAt: Date,
  },
}, { _id: false });

const tenantAddressSchema = new mongoose.Schema(
  { line1: String, city: String, state: String, pincode: String },
  { _id: false },
);

const tenantOperationsSchema = new mongoose.Schema(
  {
    multiSchemePerCustomer: { type: Boolean, default: true },
    kycMandatory: { type: Boolean, default: false },
    kycAllowedTypes: { type: [String], default: ["AADHAAR", "PAN"] },
    customerSelfEnrolEnabled: { type: Boolean, default: true },
    customerSelfRegistrationEnabled: { type: Boolean, default: true },
    customerLoginMode: enumField(CustomerLoginMode, { default: CustomerLoginMode.OTP_ONLY }),
    customerAppWriteEnabled: { type: Boolean, default: true },
    customerAppPaymentsEnabled: { type: Boolean, default: true },
    receiptPrefix: { type: String, default: "" },
    receiptNumberFormat: { type: String, default: "{prefix}/{branchCode}/{year}/{seq:6}" },
    passbookNumberFormat: { type: String, default: "{branchCode}/{year}/{seq:5}" },
    schemeNumberFormat: { type: String, default: "{branchCode}/{planCode}/{year}/{seq:5}" },
    goldPurity: { type: String, default: "22K" },
    weightRoundingMode: { type: String, default: "HALF_UP" },
    paymentReversalWindowHours: { type: Number, default: 48 },
    redemptionApprovalRequired: { type: Boolean, default: true },
    termsAndConditions: { type: String, default: "" },
  },
  { _id: false },
);

const tenantSchema = new mongoose.Schema({
  _id: stringId("tnt"), code: { type: String, required: true, uppercase: true, trim: true }, name: { type: String, required: true, trim: true },
  status: enumField(TenantStatus, { default: TenantStatus.PENDING_SETUP }), mobile: { type: String, required: true }, email: String, gstin: String,
  displayName: String, supportNumber: String,
  address: { type: tenantAddressSchema, default: undefined },
  branding: { logoUploadId: String, primaryColor: String, accentColor: String, displayName: String },
  settings: {
    timezone: { type: String, default: "Asia/Kolkata" },
    currency: { type: String, default: "INR" },
    requireKycForEnrolment: { type: Boolean, default: false },
    requireKycForRedemption: { type: Boolean, default: true },
    oneActiveSchemePerCustomer: { type: Boolean, default: false },
    customerAppMaintenance: { type: Boolean, default: false },
    reminderConfig: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  operations: { type: tenantOperationsSchema, default: () => ({}) },
  subscription: { type: subscriptionSchema, default: () => ({}) }, featureFlags: { type: Map, of: Boolean, default: {} },
  integrationSecrets: { type: integrationSecretsSchema, select: false },
  goLiveAt: Date,
  version: versionField,
}, baseOptions);
tenantSchema.index({ code: 1 }, { unique: true }); tenantSchema.index({ mobile: 1 }, { unique: true });

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
}, baseOptions);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

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
