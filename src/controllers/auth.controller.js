import { sendSuccess } from "../lib/response.js";
import { errors } from "../lib/app-error.js";
import * as auth from "../services/auth.service.js";
import { Customer, Session, Tenant, User } from "../models/index.js";
import * as signup from "../services/signup.service.js";

export const login = (platform = false) => async (req, res) => sendSuccess(res, await auth.login({ body: req.body, request: req, platform }));
export const refresh = async (req, res) => sendSuccess(res, await auth.refresh(req.body.refreshToken));
export const me = async (req, res) => {
  if (req.auth.type === "CUSTOMER") {
    const { getAppProfile } = await import("../services/customer-app.service.js");
    const tenant = await Tenant.findById(req.auth.tenantId).lean();
    return sendSuccess(res, await getAppProfile(req.auth, tenant));
  }
  const record = await User.findById(req.auth.id).select("-passwordHash").lean();
  sendSuccess(res, await auth.tenantUserAuthDto(record));
};
export const logout = async (req, res) => { await auth.logout(req.auth, req.body.refreshToken); sendSuccess(res, { loggedOut: true }); };
export const logoutAll = async (req, res) => { await auth.logoutAll(req.auth); sendSuccess(res, { loggedOut: true }); };
export const devices = async (req, res) => sendSuccess(res, await Session.find({ $or: [{ userId: req.auth.id }, { customerId: req.auth.id }], revokedAt: null }).select("deviceId platform appVersion lastUsedAt createdAt expiresAt").lean());
export const revokeDevice = async (req, res) => { await Session.updateMany({ $or: [{ userId: req.auth.id }, { customerId: req.auth.id }], deviceId: req.params.deviceId }, { $set: { revokedAt: new Date() } }); sendSuccess(res, { revoked: true }); };
export const requestOtp = async (req, res) => sendSuccess(res, await auth.requestOtp(req.body), {}, 202);
export const forgotPassword = async (req, res) => sendSuccess(res, await auth.forgotPassword(req.body), {}, 202);
export const verifyOtp = async (req, res) => sendSuccess(res, await auth.verifyCustomerOtp(req.body, req));
export const signupStart = async (req, res) => sendSuccess(res, await signup.startSignup(req.body), {}, 201);
export const signupVerify = async (req, res) => sendSuccess(res, await signup.verifySignupOtp(req.body.signupId, req.body.otp));
export const signupPlans = async (_req, res) => sendSuccess(res, await signup.listPublicSignupPlans());
export const selectSignupPlan = async (req, res) => sendSuccess(res, await signup.selectSignupPlan(req.params.signupId, req.body));
export const signupPayment = async (req, res) => sendSuccess(res, await signup.initiateSignupPayment(req.params.signupId, req.body));
export const signupStatus = async (req, res) => sendSuccess(res, await signup.getSignupStatus(req.params.signupId));
export const checkAvailability = async (req, res) => sendSuccess(res, await signup.checkSignupAvailability(req.query));
export const resolveTenant = async (req, res) => {
  const { resolveTenants } = await import("../services/customer-app.service.js");
  sendSuccess(res, await resolveTenants(req.query));
};
export const setPassword = async (req, res) => sendSuccess(res, await auth.setPassword({
  auth: req.auth,
  resetToken: req.body.resetToken,
  token: req.body.token,
  password: req.body.password,
  confirmPassword: req.body.confirmPassword,
  request: req,
}));
export const changePassword = async (req, res) => sendSuccess(res, await auth.changePassword(req.auth, req.body));
