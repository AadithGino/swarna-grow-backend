import { Router } from "express";
import * as auth from "../controllers/auth.controller.js";
import * as payment from "../controllers/payment.controller.js";
import { Branch } from "../models/index.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import {
  loginRateLimit,
  otpRequestRateLimit,
  otpVerifyRateLimit,
  publicRateLimit,
  tenantResolveRateLimit,
} from "../middlewares/security.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import {
  customerPasswordLoginBody, otpRequestBody, otpVerifyBody, publicPaymentInitiateBody, publicSetPasswordBody, signupPaymentBody, signupSelectPlanBody, signupStartBody, signupVerifyBody,
} from "../validators/common.validators.js";
import { sendSuccess } from "../lib/response.js";
import { getAppConfig } from "../services/platform.service.js";
import { requireSignupToken, requireSignupTokenForStatus } from "../middlewares/signup-auth.middleware.js";

export const publicRouter = Router(); publicRouter.use(publicRateLimit);
publicRouter.get("/app-config", asyncHandler(async (_req, res) => sendSuccess(res, await getAppConfig())));
publicRouter.get("/auth/password-policy", (_req, res) => sendSuccess(res, { minLength: 4, maxLength: 128, numericOnly: true, requireUppercase: false, requireLowercase: false, requireNumber: true, requireSymbol: false }));
publicRouter.post("/auth/otp/request", otpRequestRateLimit, validate({ body: otpRequestBody }), idempotent, asyncHandler(auth.requestOtp));
publicRouter.post("/auth/otp/verify", otpVerifyRateLimit, validate({ body: otpVerifyBody }), idempotent, asyncHandler(auth.verifyOtp));
publicRouter.post("/auth/login-password", loginRateLimit, validate({ body: customerPasswordLoginBody }), asyncHandler(auth.loginCustomerPassword));
publicRouter.post("/auth/set-password", validate({ body: publicSetPasswordBody }), asyncHandler(auth.setPassword));
publicRouter.get("/tenants/resolve", tenantResolveRateLimit, asyncHandler(auth.resolveTenant));
publicRouter.get("/tenants/:tenantId/branches", asyncHandler(async (req, res) => sendSuccess(res, await Branch.find({ tenantId: req.params.tenantId, active: true }).select("_id code name address mobile").lean())));
publicRouter.post("/signup/start", validate({ body: signupStartBody }), idempotent, asyncHandler(auth.signupStart));
publicRouter.post("/signup/verify-otp", validate({ body: signupVerifyBody }), idempotent, asyncHandler(auth.signupVerify));
publicRouter.get("/signup/plans", asyncHandler(auth.signupPlans));
publicRouter.post("/signup/:signupId/select-plan", requireSignupToken, validate({ body: signupSelectPlanBody }), idempotent, asyncHandler(auth.selectSignupPlan));
publicRouter.post("/signup/:signupId/payment/initiate", requireSignupToken, validate({ body: signupPaymentBody }), idempotent, asyncHandler(auth.signupPayment));
publicRouter.get("/signup/:signupId/status", requireSignupTokenForStatus, asyncHandler(auth.signupStatus));
publicRouter.get("/signup/check-availability", asyncHandler(auth.checkAvailability));
publicRouter.get("/pay/:linkToken", asyncHandler(payment.publicLink));
publicRouter.post("/pay/:linkToken/initiate", validate({ body: publicPaymentInitiateBody }), idempotent, asyncHandler(payment.initiatePublic));
publicRouter.get("/pay/:linkToken/status", asyncHandler(payment.publicStatus));
