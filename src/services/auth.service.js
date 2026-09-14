import argon2 from "argon2";
import { Customer, PasswordResetToken, Session, Signup, Tenant, User } from "../models/index.js";
import { errors, AppError } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { issueSession, rotateSession } from "./token.service.js";
import { otpProvider } from "../integrations/otp.provider.js";
import { ROLE_PERMISSIONS } from "../constants/permissions.js";
import { UserType } from "../constants/enums.js";
import { env } from "../config/env.js";
import { randomToken, sha256 } from "../lib/crypto.js";

const toSubject = (record, type, mobileClient = false) => ({ id: record._id, type, tenantId: record.tenantId, branchId: record.branchId, role: record.role, permissions: [...new Set([...(ROLE_PERMISSIONS[record.role] ?? []), ...(record.permissions ?? []), ...(record.permissionOverrides ?? [])])], mobileClient });
export async function login({ body, request, platform = false }) {
  const query = platform ? { type: UserType.PLATFORM_USER, mobile: body.mobile } : { type: UserType.TENANT_USER, mobile: body.mobile };
  if (body.tenantCode) { const tenant = await Tenant.findOne({ code: body.tenantCode }).lean(); if (!tenant) throw errors.unauthenticated("Mobile number or password is incorrect."); query.tenantId = tenant._id; }
  const user = await User.findOne(query).select("+passwordHash");
  if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, body.password))) throw errors.unauthenticated("Mobile number or password is incorrect.");
  const subject = toSubject(user.toObject(), UserType.TENANT_USER, body.platform !== "web");
  if (platform) { subject.type = UserType.PLATFORM_USER; delete subject.tenantId; }
  const tokens = await issueSession(subject, body, request); await User.updateOne({ _id: user._id }, { $set: { lastSeenAt: new Date() } });
  return { user: { id: user._id, name: user.name, role: user.role, tenantId: user.tenantId, branchId: user.branchId, permissions: subject.permissions, mustSetPassword: user.mustSetPassword }, ...tokens };
}
export async function refresh(refreshToken) {
  return rotateSession(refreshToken, async (session) => {
    const record = session.customerId ? await Customer.findById(session.customerId).lean() : await User.findById(session.userId).lean();
    if (!record) return null;
    return session.customerId ? { id: record._id, type: UserType.CUSTOMER, tenantId: record.tenantId, branchId: record.branchId, role: "CUSTOMER", permissions: [] } : toSubject(record, record.type, session.platform !== "web");
  });
}
export async function logout(auth, refreshToken) { if (refreshToken) await Session.updateOne({ refreshTokenHash: sha256(refreshToken), $or: [{ userId: auth.id }, { customerId: auth.id }] }, { $set: { revokedAt: new Date() } }); }
export async function logoutAll(auth) { await Session.updateMany({ $or: [{ userId: auth.id }, { customerId: auth.id }] }, { $set: { revokedAt: new Date() } }); }
export async function requestOtp(body) { const tenant = await Tenant.findOne({ code: body.tenantCode }).lean(); if (!tenant) throw errors.notFound("Jewellery"); return otpProvider.send(body); }
export async function forgotPassword(body) {
  const response = { accepted: true, expiresIn: env.OTP_TTL_SECONDS };
  const tenant = await Tenant.findOne({ code: body.tenantCode }).lean();
  if (!tenant) return response;
  const user = await User.findOne({ type: UserType.TENANT_USER, tenantId: tenant._id, mobile: body.mobile }).lean();
  if (!user) return response;
  await otpProvider.send({ tenantCode: body.tenantCode, mobile: body.mobile, purpose: "PASSWORD_RESET", deviceId: body.deviceId });
  return response;
}
export async function verifyCustomerOtp(body, request) {
  if (body.purpose === "PASSWORD_RESET") return verifyPasswordResetOtp(body);
  if (!(await otpProvider.verify(body))) throw new AppError("OTP_INVALID", "The OTP is invalid or expired.", 401);
  const tenant = await Tenant.findOne({ code: body.tenantCode }).lean(); const customer = await Customer.findOne({ tenantId: tenant?._id, mobile: body.mobile }).lean();
  if (!customer) throw errors.notFound("Customer");
  const tokens = await issueSession({ id: customer._id, type: UserType.CUSTOMER, tenantId: customer.tenantId, branchId: customer.branchId, role: "CUSTOMER", permissions: [], mobileClient: true }, { deviceId: body.deviceId, platform: request.headers["x-platform"], appVersion: request.headers["x-app-version"] }, request);
  return { customer: { id: customer._id, name: customer.name, profileComplete: Boolean(customer.profileCompletedAt) }, ...tokens };
}
export async function verifyPasswordResetOtp(body) {
  if (!(await otpProvider.verify({ ...body, purpose: "PASSWORD_RESET" }))) throw new AppError("OTP_INVALID", "The OTP is invalid or expired.", 401);
  const tenant = await Tenant.findOne({ code: body.tenantCode }).lean();
  const user = await User.findOne({ type: UserType.TENANT_USER, tenantId: tenant?._id, mobile: body.mobile }).lean();
  if (!user) throw new AppError("OTP_INVALID", "The OTP is invalid or expired.", 401);
  const resetToken = randomToken(32);
  await PasswordResetToken.create({ _id: createId("passwordReset"), userId: user._id, tenantId: user.tenantId, tokenHash: sha256(resetToken), expiresAt: new Date(Date.now() + 30 * 60_000) });
  return { resetToken };
}
export async function startSignup(body) {
  if (await Tenant.exists({ $or: [{ mobile: body.mobile }, { code: body.tenantCode }] })) throw new AppError("SIGNUP_ALREADY_EXISTS", "This mobile number or tenant code is already registered.", 409);
  const signup = await Signup.create({ _id: createId("signup"), ...body, expiresAt: new Date(Date.now() + 30 * 60_000) });
  await otpProvider.send({ tenantCode: body.tenantCode, mobile: body.mobile, purpose: "SIGNUP" }); return { signupId: signup._id, expiresAt: signup.expiresAt };
}
export async function verifySignupOtp(signupId, otp) {
  const signup = await Signup.findById(signupId); if (!signup || signup.expiresAt < new Date()) throw new AppError("SIGNUP_EXPIRED", "This signup session has expired.", 410);
  if (!(await otpProvider.verify({ tenantCode: signup.tenantCode, mobile: signup.mobile, purpose: "SIGNUP", otp }))) throw new AppError("OTP_INVALID", "The OTP is invalid or expired.", 401);
  signup.otpVerifiedAt = new Date(); signup.status = "OTP_VERIFIED"; await signup.save(); return { signupId, status: signup.status };
}
export async function setPassword({ auth, resetToken, password }) {
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  let userId = null;
  if (auth?.id) userId = auth.id;
  else if (resetToken) {
    const record = await PasswordResetToken.findOne({ tokenHash: sha256(resetToken) });
    if (!record || record.consumedAt || record.expiresAt.getTime() < Date.now()) throw errors.unauthenticated("The reset token is invalid or expired.");
    record.consumedAt = new Date();
    await record.save();
    userId = record.userId;
  } else throw errors.unauthenticated();
  const user = await User.findOneAndUpdate({ _id: userId }, { $set: { passwordHash: hash, mustSetPassword: false } }, { new: true });
  if (!user) throw errors.notFound("User");
  return { id: user._id, passwordSet: true };
}
export async function changePassword(auth, body) {
  const user = await User.findById(auth.id).select("+passwordHash");
  if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, body.currentPassword))) throw new AppError("CURRENT_PASSWORD_INVALID", "The current password is incorrect.", 422);
  if (body.currentPassword === body.newPassword) throw new AppError("PASSWORD_REUSED", "The new password must be different from the current password.", 422);
  user.passwordHash = await argon2.hash(body.newPassword, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  user.mustSetPassword = false; await user.save(); await logoutAll(auth); return { passwordChanged: true, sessionsRevoked: true };
}
