import argon2 from "argon2";
import { Branch, Customer, PasswordResetToken, Session, Tenant, User } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { appErrorFromDuplicateKey } from "../lib/mongo-duplicate.js";
import { canonicalMobile, mobileLookupVariants, mobileTenDigitSuffix } from "../lib/mobile.js";
import {
  isCustomerProfileComplete,
  tenantBrandingDto,
  tenantPortalCapabilitiesDto,
} from "../lib/customer-app-dto.js";
import { nextSequence } from "./sequence.service.js";
import { CustomerStatus } from "../constants/enums.js";
import { errors, AppError } from "../lib/app-error.js";
import { issueSession, rotateSession } from "./token.service.js";
import { otpProvider } from "../integrations/otp.provider.js";
import { ROLE_PERMISSIONS, agentCapabilities, collectionAgentPermissions } from "../constants/permissions.js";
import { CustomerLoginMode, PlatformRole, UserType } from "../constants/enums.js";
import { env } from "../config/env.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { withTransaction } from "../lib/transaction.js";
import { ttlToSeconds } from "../lib/jwt-ttl.js";
import { assertWithinLimit } from "../lib/tenant-limits.js";

const toSubject = (record, type, mobileClient = false) => ({ id: record._id, type, tenantId: record.tenantId, branchId: record.branchId, role: record.role, permissions: [...new Set([...(ROLE_PERMISSIONS[record.role] ?? []), ...(record.permissions ?? []), ...(record.permissionOverrides ?? [])])], mobileClient, securityVersion: record.securityVersion ?? 0 });
function sessionPayload(tokens, mobileClient = false) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: ttlToSeconds(mobileClient ? env.JWT_MOBILE_TTL : env.JWT_WEB_TTL),
    tokenType: "Bearer",
  };
}

/** Tenant staff profile for login / auth/me / staff profile (includes branch + tenant labels). */
export async function tenantUserAuthDto(user) {
  if (!user) return user;
  const id = user._id ?? user.id;
  const [tenant, branch] = await Promise.all([
    user.tenantId ? Tenant.findById(user.tenantId).select("code name branding operations").lean() : null,
    user.branchId ? Branch.findById(user.branchId).select("name code").lean() : null,
  ]);
  const isAgent = user.role === "COLLECTION_AGENT";
  return {
    id,
    name: user.name,
    mobile: user.mobile,
    role: user.role,
    tenantId: user.tenantId,
    branchId: user.branchId,
    tenantCode: tenant?.code ?? undefined,
    tenantName: tenant?.branding?.displayName ?? tenant?.name ?? undefined,
    branchName: branch?.name ?? undefined,
    branchCode: branch?.code ?? undefined,
    permissions: isAgent ? collectionAgentPermissions(tenant) : user.permissions,
    ...(isAgent ? { agentCapabilities: agentCapabilities(tenant) } : {}),
    mustSetPassword: user.mustSetPassword ?? false,
  };
}

export async function login({ body, request, platform = false }) {
  if (platform) {
    const user = await User.findOne({ type: UserType.PLATFORM_USER, email: body.email?.toLowerCase?.() ?? body.email }).select("+passwordHash");
    if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, body.password))) throw errors.unauthenticated("Email or password is incorrect.");
    const device = { deviceId: body.deviceId ?? "platform-console", platform: body.platform ?? "web", appVersion: body.appVersion };
    const subject = toSubject(user.toObject(), UserType.PLATFORM_USER, false);
    subject.type = UserType.PLATFORM_USER;
    delete subject.tenantId;
    delete subject.branchId;
    const tokens = await issueSession(subject, device, request);
    await User.updateOne({ _id: user._id }, { $set: { lastSeenAt: new Date() } });
    return {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role ?? PlatformRole.SUPER_ADMIN,
        permissions: subject.permissions,
      },
      ...sessionPayload(tokens, false),
    };
  }
  const query = { type: UserType.TENANT_USER, mobile: body.mobile };
  if (body.tenantCode) {
    const tenant = await Tenant.findOne({ code: body.tenantCode }).lean();
    if (!tenant) throw errors.unauthenticated("Mobile number or password is incorrect.");
    query.tenantId = tenant._id;
  } else {
    const matches = await User.find(query).select("tenantId").lean();
    const tenantIds = [...new Set(matches.map((row) => row.tenantId).filter(Boolean))];
    if (tenantIds.length > 1) {
      const tenants = await Tenant.find({ _id: { $in: tenantIds } }).select("code name branding").lean();
      throw new AppError("TENANT_SELECTION_REQUIRED", "Select a jewellery to continue.", 409, {
        tenants: tenants.map((tenant) => ({
          tenantCode: tenant.code,
          displayName: tenant.branding?.displayName ?? tenant.name,
          logoUrl: tenant.branding?.logoUploadId ?? null,
        })),
      });
    }
    if (tenantIds.length === 1) query.tenantId = tenantIds[0];
  }
  const user = await User.findOne(query).select("+passwordHash");
  if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, body.password))) throw errors.unauthenticated("Mobile number or password is incorrect.");
  const subject = toSubject(user.toObject(), UserType.TENANT_USER, body.platform !== "web");
  const tokens = await issueSession(subject, body, request); await User.updateOne({ _id: user._id }, { $set: { lastSeenAt: new Date() } });
  return {
    user: await tenantUserAuthDto({
      ...user.toObject(),
      permissions: subject.permissions,
    }),
    ...sessionPayload(tokens, body.platform !== "web"),
  };
}
export async function refresh(refreshToken) {
  const rotated = await rotateSession(refreshToken, async (session) => {
    const record = session.customerId ? await Customer.findById(session.customerId).lean() : await User.findById(session.userId).lean();
    if (!record) return null;
    return session.customerId ? { id: record._id, type: UserType.CUSTOMER, tenantId: record.tenantId, branchId: record.branchId, role: "CUSTOMER", permissions: [], securityVersion: record.securityVersion ?? 0 } : toSubject(record, record.type, session.platform !== "web");
  });
  return { ...sessionPayload(rotated, rotated.mobileClient), ...rotated };
}
export async function logout(auth, refreshToken) { if (refreshToken) await Session.updateOne({ refreshTokenHash: sha256(refreshToken), tenantId: auth.tenantId ?? null, $or: [{ userId: auth.id }, { customerId: auth.id }] }, { $set: { revokedAt: new Date() } }); }
export async function logoutAll(auth) { await Session.updateMany({ tenantId: auth.tenantId ?? null, $or: [{ userId: auth.id }, { customerId: auth.id }] }, { $set: { revokedAt: new Date() } }); }
export async function revokeSessionsForUser(userId) { await Session.updateMany({ userId }, { $set: { revokedAt: new Date() } }); }
export async function requestOtp(body) {
  const tenant = await Tenant.findOne({ code: body.tenantCode }).lean();
  if (!tenant) throw errors.notFound("Jewellery");
  if (
    customerLoginMode(tenant) === CustomerLoginMode.PASSWORD_ONLY &&
    ["LOGIN", "SIGNUP"].includes(body.purpose)
  ) {
    throw new AppError(
      "CUSTOMER_AUTH_MODE_PASSWORD_ONLY",
      "This jeweller uses mobile number and password sign-in.",
      403,
    );
  }
  if (
    body.purpose === "SIGNUP" &&
    tenant.operations?.customerSelfRegistrationEnabled === false
  ) {
    throw new AppError(
      "SELF_REGISTRATION_DISABLED",
      "Online registration is not available for this jeweller. Contact your branch.",
      403,
    );
  }
  const mobile = canonicalMobile(body.mobile);
  const isRegistered = Boolean(await findCustomerByTenantMobile(tenant._id, mobile));
  if (body.purpose === "LOGIN" && !isRegistered) {
    throw new AppError("CUSTOMER_NOT_REGISTERED", "No account found for this mobile. Sign up to continue.", 404);
  }
  const sent = await otpProvider.send({ ...body, mobile, tenantId: tenant._id });
  return { ...sent, isRegistered };
}
export async function forgotPassword(body) {
  const response = { accepted: true, expiresIn: env.OTP_TTL_SECONDS };
  const tenant = await Tenant.findOne({ code: body.tenantCode }).lean();
  if (!tenant) return response;
  const user = await User.findOne({ type: UserType.TENANT_USER, tenantId: tenant._id, mobile: body.mobile }).lean();
  if (!user) return response;
  await otpProvider.send({ tenantId: tenant._id, tenantCode: body.tenantCode, mobile: body.mobile, purpose: "PASSWORD_RESET", deviceId: body.deviceId });
  return response;
}
function tenantCapabilities(tenant) {
  return tenantPortalCapabilitiesDto(tenant);
}

function customerLoginMode(tenant) {
  return tenant?.operations?.customerLoginMode ?? CustomerLoginMode.OTP_ONLY;
}

async function findCustomerByTenantMobile(tenantId, mobile) {
  const canonical = canonicalMobile(mobile);
  const variants = mobileLookupVariants(canonical);
  let customer = await Customer.findOne({ tenantId, mobile: { $in: variants } }).lean();
  if (customer) return customer;
  const suffix = mobileTenDigitSuffix(canonical);
  if (!suffix) return null;
  return Customer.findOne({ tenantId, mobile: { $regex: `${suffix}$` } }).lean();
}

async function ensureCustomerAfterOtp(tenant, mobile, purpose) {
  let customer = await findCustomerByTenantMobile(tenant._id, mobile);
  let isNewCustomer = false;
  if (!customer) {
    if (purpose !== "SIGNUP") throw errors.notFound("Customer");
    if (tenant.operations?.customerSelfRegistrationEnabled === false) {
      throw errors.business("SELF_REGISTRATION_DISABLED", "Customer self-registration is disabled for this jewellery.");
    }
    const used = await Customer.countDocuments({ tenantId: tenant._id, status: CustomerStatus.ACTIVE });
    await assertWithinLimit({ tenant, limitKey: "activeCustomers", used, errorCode: "LIMIT_CUSTOMERS", label: "active customers" });
    const branch =
      (await Branch.findOne({ tenantId: tenant._id, isHeadOffice: true, active: true }).lean()) ??
      (await Branch.findOne({ tenantId: tenant._id, active: true }).lean());
    if (!branch) throw errors.business("BRANCH_NOT_CONFIGURED", "No branch is available for registration.");
    const number = await nextSequence(tenant._id, "customer");
    const canonical = canonicalMobile(mobile);
    try {
      customer = (
        await Customer.create({
          _id: createId("customer"),
          tenantId: tenant._id,
          branchId: branch._id,
          customerNumber: `C${String(number).padStart(4, "0")}`,
          name: "Customer",
          mobile: canonical,
          status: CustomerStatus.ACTIVE,
        })
      ).toObject();
      isNewCustomer = true;
    } catch (error) {
      if (error?.code === 11000) {
        customer = await findCustomerByTenantMobile(tenant._id, mobile);
        if (customer) return { customer, isNewCustomer: false };
        const indexName = String(error.message ?? "");
        if (indexName.includes("passbookNumber")) {
          throw new AppError(
            "CUSTOMER_PASSBOOK_INDEX",
            "New customer registration is temporarily blocked by passbook settings. Please contact your jeweller.",
            409,
          );
        }
        throw appErrorFromDuplicateKey(error);
      }
      throw error;
    }
  }
  return { customer, isNewCustomer };
}

export async function verifyCustomerOtp(body, request) {
  if (body.purpose === "PASSWORD_RESET") return verifyPasswordResetOtp(body);
  const tenant = await Tenant.findOne({ code: body.tenantCode }).lean();
  if (!tenant) throw errors.notFound("Jewellery");
  if (
    customerLoginMode(tenant) === CustomerLoginMode.PASSWORD_ONLY &&
    ["LOGIN", "SIGNUP"].includes(body.purpose)
  ) {
    throw new AppError(
      "CUSTOMER_AUTH_MODE_PASSWORD_ONLY",
      "This jeweller uses mobile number and password sign-in.",
      403,
    );
  }
  if (
    body.purpose === "SIGNUP" &&
    tenant.operations?.customerSelfRegistrationEnabled === false
  ) {
    throw new AppError(
      "SELF_REGISTRATION_DISABLED",
      "Online registration is not available for this jeweller. Contact your branch.",
      403,
    );
  }
  const device = body.deviceInfo ?? {
    deviceId: body.deviceId,
    platform: body.deviceInfo?.platform ?? request.headers["x-platform"] ?? "android",
    appVersion: body.deviceInfo?.appVersion ?? request.headers["x-app-version"],
    osVersion: body.deviceInfo?.osVersion,
    deviceModel: body.deviceInfo?.deviceModel,
  };
  const mobile = canonicalMobile(body.mobile);
  const otpContext = { tenantId: tenant._id, tenantCode: body.tenantCode, mobile, purpose: body.purpose };
  const verified = await otpProvider.validate({ ...otpContext, otp: body.otp, otpId: body.otpId });
  if (!verified) {
    const issuedFor = await otpProvider.findMatchingPurpose({
      ...otpContext,
      otpId: body.otpId,
    });
    if (issuedFor === "LOGIN") {
      throw new AppError(
        "OTP_PURPOSE_MISMATCH",
        "This OTP was sent for sign in. Switch to Sign in or request a new OTP on Create account.",
        401,
      );
    }
    if (issuedFor === "SIGNUP") {
      throw new AppError(
        "OTP_PURPOSE_MISMATCH",
        "This OTP was sent to create an account. Switch to Create account or request a new OTP on Sign in.",
        401,
      );
    }
    throw new AppError("OTP_INVALID", "The OTP is invalid or expired.", 401);
  }
  const { customer, isNewCustomer } = await ensureCustomerAfterOtp(tenant, body.mobile, body.purpose);
  const branch = customer.branchId
    ? await Branch.findOne({ _id: customer.branchId }).select("_id name code passbookPrefix").lean()
    : null;
  const tokens = await issueSession(
    {
      id: customer._id,
      type: UserType.CUSTOMER,
      tenantId: customer.tenantId,
      branchId: customer.branchId,
      role: "CUSTOMER",
      permissions: [],
      mobileClient: true,
    },
    device,
    request,
  );
  await otpProvider.consume(otpContext);
  return {
    isNewCustomer,
    profileComplete: isCustomerProfileComplete(customer),
    customer: {
      id: customer._id,
      name: customer.name,
      mobile: customer.mobile,
      branchId: customer.branchId,
      passbookNumber: customer.passbookNumber ?? null,
      branch: branch ? { id: branch._id, name: branch.name, code: branch.code } : null,
      profileComplete: isCustomerProfileComplete(customer),
    },
    tenant: tenantBrandingDto(tenant),
    tenantCapabilities: tenantCapabilities(tenant),
    ...sessionPayload(tokens, tokens.mobileClient),
  };
}
export async function verifyPasswordResetOtp(body) {
  const tenant = await Tenant.findOne({ code: body.tenantCode }).lean();
  if (!(await otpProvider.verify({ ...body, tenantId: tenant?._id, purpose: "PASSWORD_RESET" }))) throw new AppError("OTP_INVALID", "The OTP is invalid or expired.", 401);
  const user = await User.findOne({ type: UserType.TENANT_USER, tenantId: tenant?._id, mobile: body.mobile }).lean();
  if (!user) throw new AppError("OTP_INVALID", "The OTP is invalid or expired.", 401);
  const resetToken = randomToken(32);
  await PasswordResetToken.create({ _id: createId("passwordReset"), userId: user._id, tenantId: user.tenantId, tokenHash: sha256(resetToken), expiresAt: new Date(Date.now() + 30 * 60_000) });
  return { resetToken };
}
export async function loginCustomerPassword(body, request) {
  const tenant = await Tenant.findOne({ code: body.tenantCode }).lean();
  if (!tenant) throw errors.notFound("Jewellery");
  if (customerLoginMode(tenant) !== CustomerLoginMode.PASSWORD_ONLY) {
    throw new AppError(
      "CUSTOMER_AUTH_MODE_OTP_ONLY",
      "This jeweller uses OTP-based sign-in.",
      403,
    );
  }
  const customer = await findCustomerByTenantMobile(tenant._id, body.mobile);
  if (!customer) throw errors.unauthenticated("Mobile number or password is incorrect.");
  if (customer.status !== CustomerStatus.ACTIVE) {
    throw errors.unauthenticated("Mobile number or password is incorrect.");
  }
  const customerAuth = await Customer.findById(customer._id).select("+passwordHash").lean();
  if (!customerAuth?.passwordHash) {
    throw new AppError(
      "CUSTOMER_PASSWORD_NOT_SET",
      "Set a password using the forgot-password flow before signing in with password.",
      403,
    );
  }
  if (!(await argon2.verify(customerAuth.passwordHash, body.password))) {
    throw errors.unauthenticated("Mobile number or password is incorrect.");
  }
  const branch = customer.branchId
    ? await Branch.findOne({ _id: customer.branchId }).select("_id name code").lean()
    : null;
  const tokens = await issueSession(
    {
      id: customer._id,
      type: UserType.CUSTOMER,
      tenantId: customer.tenantId,
      branchId: customer.branchId,
      role: "CUSTOMER",
      permissions: [],
      mobileClient: true,
    },
    {
      deviceId: body.deviceId ?? "customer-web-password",
      platform: request.headers["x-platform"] ?? "web",
      appVersion: request.headers["x-app-version"],
    },
    request,
  );
  return {
    isNewCustomer: false,
    profileComplete: isCustomerProfileComplete(customer),
    customer: {
      id: customer._id,
      name: customer.name,
      mobile: customer.mobile,
      branchId: customer.branchId,
      passbookNumber: customer.passbookNumber ?? null,
      branch: branch ? { id: branch._id, name: branch.name, code: branch.code } : null,
      profileComplete: isCustomerProfileComplete(customer),
    },
    tenant: tenantBrandingDto(tenant),
    tenantCapabilities: tenantCapabilities(tenant),
    ...sessionPayload(tokens, tokens.mobileClient),
  };
}
export async function setPassword({ auth, resetToken, token, password, confirmPassword, request }) {
  if (confirmPassword != null && password !== confirmPassword) throw new AppError("VALIDATION_FAILED", "Password and confirm password must match.", 422);
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const plainToken = token ?? resetToken;

  return withTransaction(async (session) => {
    let userId;
    if (auth?.id) {
      userId = auth.id;
    } else {
      if (!plainToken) throw errors.unauthenticated();
      const record = await PasswordResetToken.findOneAndUpdate(
        {
          tokenHash: sha256(plainToken),
          consumedAt: null,
          expiresAt: { $gt: new Date() },
        },
        { $set: { consumedAt: new Date() } },
        { new: true, session },
      );
      if (!record) throw errors.unauthenticated("The setup token is invalid or expired.");
      userId = record.userId;
    }
    const user = await User.findOneAndUpdate(
      { _id: userId },
      { $set: { passwordHash: hash, mustSetPassword: false }, $inc: { securityVersion: 1 } },
      { new: true, session },
    );
    if (!user) throw errors.notFound("User");
    if (user.type === UserType.TENANT_USER && request && plainToken) {
      const subject = toSubject(user.toObject(), UserType.TENANT_USER, false);
      const tokens = await issueSession(subject, { deviceId: "owner-setup", platform: "web" }, request);
      return {
        passwordSet: true,
        mustChangePassword: false,
        user: { id: user._id, name: user.name, role: user.role, tenantId: user.tenantId, branchId: user.branchId },
        ...sessionPayload(tokens),
      };
    }
    return { id: user._id, passwordSet: true };
  });
}
export async function changePassword(auth, body) {
  const user = await User.findById(auth.id).select("+passwordHash");
  if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, body.currentPassword))) throw new AppError("CURRENT_PASSWORD_INVALID", "The current password is incorrect.", 422);
  if (body.currentPassword === body.newPassword) throw new AppError("PASSWORD_REUSED", "The new password must be different from the current password.", 422);
  user.passwordHash = await argon2.hash(body.newPassword, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  user.mustSetPassword = false;
  user.securityVersion = (user.securityVersion ?? 0) + 1;
  await user.save();
  await logoutAll(auth);
  return { passwordChanged: true, sessionsRevoked: true };
}
