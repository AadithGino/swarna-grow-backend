import argon2 from "argon2";
import { Customer, PasswordResetToken, Session, Tenant, User } from "../models/index.js";
import { errors, AppError } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { issueSession, rotateSession } from "./token.service.js";
import { otpProvider } from "../integrations/otp.provider.js";
import { ROLE_PERMISSIONS } from "../constants/permissions.js";
import { PlatformRole, UserType } from "../constants/enums.js";
import { env } from "../config/env.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { ttlToSeconds } from "../lib/jwt-ttl.js";

const toSubject = (record, type, mobileClient = false) => ({ id: record._id, type, tenantId: record.tenantId, branchId: record.branchId, role: record.role, permissions: [...new Set([...(ROLE_PERMISSIONS[record.role] ?? []), ...(record.permissions ?? []), ...(record.permissionOverrides ?? [])])], mobileClient });
function sessionPayload(tokens) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: ttlToSeconds(env.JWT_WEB_TTL),
    tokenType: "Bearer",
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
      ...sessionPayload(tokens),
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
    user: { id: user._id, name: user.name, role: user.role, tenantId: user.tenantId, branchId: user.branchId, permissions: subject.permissions, mustSetPassword: user.mustSetPassword },
    ...sessionPayload(tokens),
  };
}
export async function refresh(refreshToken) {
  const rotated = await rotateSession(refreshToken, async (session) => {
    const record = session.customerId ? await Customer.findById(session.customerId).lean() : await User.findById(session.userId).lean();
    if (!record) return null;
    return session.customerId ? { id: record._id, type: UserType.CUSTOMER, tenantId: record.tenantId, branchId: record.branchId, role: "CUSTOMER", permissions: [] } : toSubject(record, record.type, session.platform !== "web");
  });
  return { ...sessionPayload(rotated), ...rotated };
}
export async function logout(auth, refreshToken) { if (refreshToken) await Session.updateOne({ refreshTokenHash: sha256(refreshToken), $or: [{ userId: auth.id }, { customerId: auth.id }] }, { $set: { revokedAt: new Date() } }); }
export async function logoutAll(auth) { await Session.updateMany({ $or: [{ userId: auth.id }, { customerId: auth.id }] }, { $set: { revokedAt: new Date() } }); }
export async function requestOtp(body) { const tenant = await Tenant.findOne({ code: body.tenantCode }).lean(); if (!tenant) throw errors.notFound("Jewellery"); return otpProvider.send({ ...body, tenantId: tenant._id }); }
export async function forgotPassword(body) {
  const response = { accepted: true, expiresIn: env.OTP_TTL_SECONDS };
  const tenant = await Tenant.findOne({ code: body.tenantCode }).lean();
  if (!tenant) return response;
  const user = await User.findOne({ type: UserType.TENANT_USER, tenantId: tenant._id, mobile: body.mobile }).lean();
  if (!user) return response;
  await otpProvider.send({ tenantId: tenant._id, tenantCode: body.tenantCode, mobile: body.mobile, purpose: "PASSWORD_RESET", deviceId: body.deviceId });
  return response;
}
export async function verifyCustomerOtp(body, request) {
  if (body.purpose === "PASSWORD_RESET") return verifyPasswordResetOtp(body);
  const tenant = await Tenant.findOne({ code: body.tenantCode }).lean();
  if (!(await otpProvider.verify({ ...body, tenantId: tenant?._id }))) throw new AppError("OTP_INVALID", "The OTP is invalid or expired.", 401);
  const customer = await Customer.findOne({ tenantId: tenant?._id, mobile: body.mobile }).lean();
  if (!customer) throw errors.notFound("Customer");
  const tokens = await issueSession({ id: customer._id, type: UserType.CUSTOMER, tenantId: customer.tenantId, branchId: customer.branchId, role: "CUSTOMER", permissions: [], mobileClient: true }, { deviceId: body.deviceId, platform: request.headers["x-platform"], appVersion: request.headers["x-app-version"] }, request);
  return { customer: { id: customer._id, name: customer.name, profileComplete: Boolean(customer.profileCompletedAt) }, ...tokens };
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
export async function setPassword({ auth, resetToken, token, password, confirmPassword, request }) {
  if (confirmPassword != null && password !== confirmPassword) throw new AppError("VALIDATION_FAILED", "Password and confirm password must match.", 422);
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  let userId = null;
  if (auth?.id) userId = auth.id;
  else {
    const plain = token ?? resetToken;
    if (!plain) throw errors.unauthenticated();
    const record = await PasswordResetToken.findOne({ tokenHash: sha256(plain) });
    if (!record || record.consumedAt || record.expiresAt.getTime() < Date.now()) throw errors.unauthenticated("The setup token is invalid or expired.");
    record.consumedAt = new Date();
    await record.save();
    userId = record.userId;
  }
  const user = await User.findOneAndUpdate({ _id: userId }, { $set: { passwordHash: hash, mustSetPassword: false } }, { new: true });
  if (!user) throw errors.notFound("User");
  if (user.type === UserType.TENANT_USER && request && (token ?? resetToken)) {
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
}
export async function changePassword(auth, body) {
  const user = await User.findById(auth.id).select("+passwordHash");
  if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, body.currentPassword))) throw new AppError("CURRENT_PASSWORD_INVALID", "The current password is incorrect.", 422);
  if (body.currentPassword === body.newPassword) throw new AppError("PASSWORD_REUSED", "The new password must be different from the current password.", 422);
  user.passwordHash = await argon2.hash(body.newPassword, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  user.mustSetPassword = false; await user.save(); await logoutAll(auth); return { passwordChanged: true, sessionsRevoked: true };
}
