import { sendSuccess } from "../lib/response.js";
import { errors } from "../lib/app-error.js";
import * as auth from "../services/auth.service.js";
import { Customer, Session, Signup, SubscriptionPlan, Tenant, User } from "../models/index.js";

export const login = (platform = false) => async (req, res) => sendSuccess(res, await auth.login({ body: req.body, request: req, platform }));
export const refresh = async (req, res) => sendSuccess(res, await auth.refresh(req.body.refreshToken));
export const me = async (req, res) => { const model = req.auth.type === "CUSTOMER" ? Customer : User; const record = await model.findById(req.auth.id).select(req.auth.type === "CUSTOMER" ? "-fcmTokens" : "-passwordHash").lean(); sendSuccess(res, record); };
export const logout = async (req, res) => { await auth.logout(req.auth, req.body.refreshToken); sendSuccess(res, { loggedOut: true }); };
export const logoutAll = async (req, res) => { await auth.logoutAll(req.auth); sendSuccess(res, { loggedOut: true }); };
export const devices = async (req, res) => sendSuccess(res, await Session.find({ $or: [{ userId: req.auth.id }, { customerId: req.auth.id }], revokedAt: null }).select("deviceId platform appVersion lastUsedAt createdAt expiresAt").lean());
export const revokeDevice = async (req, res) => { await Session.updateMany({ $or: [{ userId: req.auth.id }, { customerId: req.auth.id }], deviceId: req.params.deviceId }, { $set: { revokedAt: new Date() } }); sendSuccess(res, { revoked: true }); };
export const requestOtp = async (req, res) => sendSuccess(res, await auth.requestOtp(req.body), {}, 202);
export const forgotPassword = async (req, res) => sendSuccess(res, await auth.forgotPassword(req.body), {}, 202);
export const verifyOtp = async (req, res) => sendSuccess(res, await auth.verifyCustomerOtp(req.body, req));
export const signupStart = async (req, res) => sendSuccess(res, await auth.startSignup(req.body), {}, 201);
export const signupVerify = async (req, res) => sendSuccess(res, await auth.verifySignupOtp(req.body.signupId, req.body.otp));
export const signupPlans = async (_req, res) => sendSuccess(res, await SubscriptionPlan.find({ active: true }).sort({ pricePaise: 1 }).lean());
export const selectSignupPlan = async (req, res) => { const signup = await Signup.findOneAndUpdate({ _id: req.params.signupId, status: "OTP_VERIFIED" }, { $set: { selectedPlanTier: req.body.planTier, status: "PLAN_SELECTED" } }, { new: true }); sendSuccess(res, signup); };
export const signupPayment = async (req, res) => { const signup = await Signup.findOneAndUpdate({ _id: req.params.signupId, status: "PLAN_SELECTED" }, { $set: { status: "PAYMENT_PENDING", paymentReference: `signup_${Date.now()}` } }, { new: true }); sendSuccess(res, { signupId: signup?._id, status: signup?.status, paymentUrl: `/mock-signup-pay/${signup?._id}` }); };
export const signupStatus = async (req, res) => sendSuccess(res, await Signup.findById(req.params.signupId).select("status tenantCode selectedPlanTier expiresAt").lean());
export const checkAvailability = async (req, res) => sendSuccess(res, { available: !(await Tenant.exists({ $or: [...(req.query.mobile ? [{ mobile: req.query.mobile }] : []), ...(req.query.tenantCode ? [{ code: req.query.tenantCode }] : [])] })) });
export const resolveTenant = async (req, res) => {
  let tenant = null;
  if (req.query.tenantCode) {
    tenant = await Tenant.findOne({ code: String(req.query.tenantCode).trim().toUpperCase() }).select("_id code name branding status").lean();
  } else if (req.query.mobile) {
    const customer = await Customer.findOne({ mobile: req.query.mobile }).select("tenantId").lean();
    if (customer?.tenantId) tenant = await Tenant.findById(customer.tenantId).select("_id code name branding status").lean();
  }
  if (!tenant) throw errors.notFound("Jewellery");
  sendSuccess(res, tenant);
};
export const setPassword = async (req, res) => sendSuccess(res, await auth.setPassword({ auth: req.auth, resetToken: req.body.resetToken, password: req.body.password }));
export const changePassword = async (req, res) => sendSuccess(res, await auth.changePassword(req.auth, req.body));
