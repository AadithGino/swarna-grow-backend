import argon2 from "argon2";
import dayjs from "dayjs";
import { Branch, PasswordResetToken, Signup, SubscriptionPlan, Tenant, User } from "../models/index.js";
import { AppError, errors } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { deriveTenantCodeFromName, mapPublicPlans, signupStageFromStatus } from "../lib/platform-dto.js";
import { subscriptionPatchFromPlan } from "../lib/subscription-provision.js";
import { env } from "../config/env.js";
import { BillingCycle, PasswordTokenPurpose, PlanTier, SignupAvailabilityReason, SignupStatus, SubscriptionStatus, TenantRole, TenantStatus, UserStatus, UserType } from "../constants/enums.js";
import { ROLE_PERMISSIONS } from "../constants/permissions.js";
import { moneyRef, percentOfPaiseHalfUp } from "../lib/money.js";
import { withTransaction } from "../lib/transaction.js";
import { otpProvider } from "../integrations/otp.provider.js";
const GST_PERCENT = 18;
const RESEND_COOLDOWN_SECONDS = 30;
const SIGNUP_TOKEN_MINUTES = 60;

function maskMobile(mobile) {
  const digits = String(mobile).replace(/\D/g, "");
  if (digits.length < 4) return "XXXX";
  return `${digits.slice(0, 4)}XXXX${digits.slice(-2)}`;
}

async function ensureUniqueTenantCode(baseCode) {
  let code = baseCode;
  let suffix = 0;
  while (await Tenant.exists({ code })) {
    suffix += 1;
    code = `${baseCode.slice(0, Math.max(4, 12 - String(suffix).length))}${suffix}`;
  }
  return code;
}

export async function checkSignupAvailability(query) {
  if (query.mobile) {
    const taken = await Tenant.exists({ mobile: query.mobile });
    if (taken) return { available: false, reason: SignupAvailabilityReason.MOBILE_ALREADY_REGISTERED };
    return { available: true };
  }
  if (query.tenantCode) {
    const taken = await Tenant.exists({ code: String(query.tenantCode).trim().toUpperCase() });
    if (taken) return { available: false, reason: SignupAvailabilityReason.TENANT_CODE_TAKEN };
    return { available: true };
  }
  return { available: true };
}

export async function startSignup(body) {
  const mobileTaken = await Tenant.exists({ mobile: body.mobile });
  if (mobileTaken) throw new AppError("SIGNUP_ALREADY_EXISTS", "This mobile number is already registered.", 409);
  const tenantCode = await ensureUniqueTenantCode(deriveTenantCodeFromName(body.businessName));
  const signup = await Signup.create({
    _id: createId("signup"),
    businessName: body.businessName,
    ownerName: body.ownerName,
    mobile: body.mobile,
    email: body.email,
    city: body.city,
    tenantCode,
    status: SignupStatus.OTP_PENDING,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });
  const otpResult = await otpProvider.send({ tenantCode, mobile: body.mobile, purpose: "SIGNUP" });
  return {
    signupId: signup._id,
    otpSent: true,
    otpChannel: "WHATSAPP",
    maskedMobile: maskMobile(body.mobile),
    expiresInSeconds: otpResult.expiresIn ?? env.OTP_TTL_SECONDS,
    resendAvailableInSeconds: RESEND_COOLDOWN_SECONDS,
  };
}

export async function verifySignupOtp(signupId, otp) {
  const signup = await Signup.findById(signupId);
  if (!signup || signup.expiresAt < new Date()) throw new AppError("SIGNUP_EXPIRED", "This signup session has expired.", 410);
  if (!(await otpProvider.verify({ tenantCode: signup.tenantCode, mobile: signup.mobile, purpose: "SIGNUP", otp }))) {
    throw new AppError("OTP_INVALID", "The OTP is invalid or expired.", 401);
  }
  const signupToken = `${createId("signupToken")}_${randomToken(8)}`;
  signup.otpVerifiedAt = new Date();
  signup.status = SignupStatus.OTP_VERIFIED;
  signup.signupTokenHash = sha256(signupToken);
  signup.signupTokenExpiresAt = new Date(Date.now() + SIGNUP_TOKEN_MINUTES * 60_000);
  await signup.save();
  return { signupId: signup._id, verified: true, signupToken, nextStep: "SELECT_PLAN" };
}

export async function listPublicSignupPlans() {
  const plans = await SubscriptionPlan.find({ active: true }).sort({ sortOrder: 1, pricePaise: 1 }).lean();
  return mapPublicPlans(plans, { includeTenantCount: false });
}

function planAmountPaise(plan, billingCycle) {
  const monthly = plan.monthlyPricePaise ?? plan.pricePaise ?? 0;
  if (billingCycle === BillingCycle.ANNUAL && plan.yearlyPricePaise) return plan.yearlyPricePaise;
  return monthly;
}

export async function selectSignupPlan(signupId, body) {
  const signup = await Signup.findOne({ _id: signupId, status: SignupStatus.OTP_VERIFIED });
  if (!signup) throw errors.notFound("Signup session");
  const plan = await SubscriptionPlan.findById(body.subscriptionPlanId);
  if (!plan?.active) throw errors.notFound("Subscription plan");
  const billingCycle = body.billingCycle ?? BillingCycle.MONTHLY;
  const amountPaise = planAmountPaise(plan, billingCycle);
  const taxPaise = percentOfPaiseHalfUp(amountPaise, GST_PERCENT, { fieldName: "gstPercent" });
  signup.selectedPlanTier = plan.tier;
  signup.subscriptionPlanId = plan._id;
  signup.billingCycle = billingCycle;
  signup.status = SignupStatus.PLAN_SELECTED;
  await signup.save();
  return {
    selectedPlan: { tier: plan.tier, name: plan.name ?? plan.tier },
    amount: moneyRef(amountPaise),
    tax: moneyRef(taxPaise),
    total: moneyRef(amountPaise + taxPaise),
    trialDays: plan.trialDays ?? 0,
    nextStep: "PAYMENT",
  };
}

async function provisionFromSignup(signup) {
  if (signup.provisionedTenantId) return signup.provisionedTenantId;
  const plan = signup.subscriptionPlanId
    ? await SubscriptionPlan.findById(signup.subscriptionPlanId).lean()
    : await SubscriptionPlan.findOne({ tier: signup.selectedPlanTier ?? PlanTier.STARTER, active: true }).lean();
  const trialDays = plan?.trialDays ?? 14;
  const trialEndsAt = dayjs().add(trialDays, "day").toDate();
  const subscription = subscriptionPatchFromPlan(plan ?? { tier: PlanTier.STARTER }, {
    billingCycle: signup.billingCycle ?? BillingCycle.MONTHLY,
    trialEndsAt,
    status: SubscriptionStatus.TRIAL,
  });
  return withTransaction(async (session) => {
    const tenant = (await Tenant.create([{
      _id: createId("tenant"),
      code: signup.tenantCode,
      name: signup.businessName,
      displayName: signup.businessName,
      mobile: signup.mobile,
      email: signup.email,
      status: TenantStatus.PENDING_SETUP,
      address: signup.city ? { city: signup.city } : undefined,
      subscription,
    }], { session }))[0];
    const branch = (await Branch.create([{
      _id: createId("branch"),
      tenantId: tenant._id,
      code: "MAIN",
      name: "Main Showroom",
      isHeadOffice: true,
    }], { session }))[0];
    const tempPassword = randomToken(10);
    const owner = (await User.create([{
      _id: createId("user"),
      type: UserType.TENANT_USER,
      tenantId: tenant._id,
      branchId: branch._id,
      role: TenantRole.TENANT_OWNER,
      name: signup.ownerName ?? signup.businessName,
      mobile: signup.mobile,
      email: signup.email,
      passwordHash: await argon2.hash(tempPassword, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
      mustSetPassword: true,
      status: UserStatus.ACTIVE,
      permissions: ROLE_PERMISSIONS.TENANT_OWNER,
    }], { session }))[0];
    const setupTokenPlain = createId("setupPassword");
    const setupRecord = (await PasswordResetToken.create([{
      _id: createId("passwordReset"),
      userId: owner._id,
      tenantId: tenant._id,
      purpose: PasswordTokenPurpose.OWNER_SETUP,
      tokenHash: sha256(setupTokenPlain),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    }], { session }))[0];
    signup.provisionedTenantId = tenant._id;
    signup.ownerSetupTokenId = setupRecord._id;
    signup.ownerSetupTokenPlain = setupTokenPlain;
    signup.status = SignupStatus.PROVISIONED;
    await signup.save({ session });
    return { tenantId: tenant._id, setupTokenPlain, owner };
  });
}

export async function initiateSignupPayment(signupId, body) {
  const signup = await Signup.findOne({ _id: signupId, status: SignupStatus.PLAN_SELECTED });
  if (!signup) throw errors.notFound("Signup session");
  const paymentSessionId = createId("paymentSession");
  signup.paymentSessionId = paymentSessionId;
  signup.paymentRedirectUrl = body.redirectUrl;
  signup.paymentInitiatedAt = new Date();
  signup.status = SignupStatus.PAYMENT_PENDING;
  signup.paymentReference = `signup_${Date.now()}`;
  await signup.save();
  const redirectUrl = env.PROVIDER_MODE === "mock"
    ? `${body.redirectUrl}?signupId=${signupId}&sessionId=${paymentSessionId}&mock=success`
    : `https://mercury.phonepe.com/transact/pg?token=${paymentSessionId}`;
  return {
    paymentSessionId,
    redirectUrl,
    expiresAt: dayjs().add(15, "minute").toISOString(),
  };
}

export async function getSignupStatus(signupId) {
  let signup = await Signup.findById(signupId).select("+signupTokenHash +ownerSetupTokenPlain");
  if (!signup) throw errors.notFound("Signup session");
  const paymentProcessing = Boolean(signup.paymentInitiatedAt && signup.status === SignupStatus.PAYMENT_PENDING);
  if (paymentProcessing && env.PROVIDER_MODE === "mock" && !signup.provisionedTenantId) {
    await provisionFromSignup(signup);
    signup = await Signup.findById(signupId).select("+ownerSetupTokenPlain");
  }
  const stage = signupStageFromStatus(signup.status, paymentProcessing && !signup.provisionedTenantId);
  const data = {
    signupId: signup._id,
    stage,
    paymentStatus: signup.provisionedTenantId
      ? "SUCCESS"
      : signup.status === SignupStatus.EXPIRED
        ? "FAILED"
        : signup.paymentInitiatedAt
          ? "PENDING"
          : null,
  };
  if (signup.provisionedTenantId) {
    const tenant = await Tenant.findById(signup.provisionedTenantId).select("_id code status").lean();
    data.tenant = tenant ? { id: tenant._id, tenantCode: tenant.code, status: tenant.status } : null;
    const setupToken = signup.ownerSetupTokenPlain ?? null;
    if (setupToken) await Signup.updateOne({ _id: signupId }, { $unset: { ownerSetupTokenPlain: 1 } });
    data.ownerLogin = {
      mobile: signup.mobile,
      passwordSetRequired: true,
      ...(setupToken ? { setPasswordToken: setupToken } : {}),
    };
    data.message = "Your account is created. Our team is configuring WhatsApp and payments — you'll be notified within 24 hours.";
  }
  return data;
}
