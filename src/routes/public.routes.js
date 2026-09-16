import { Router } from "express";
import * as auth from "../controllers/auth.controller.js";
import * as payment from "../controllers/payment.controller.js";
import { Branch } from "../models/index.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { otpRateLimit, publicRateLimit, tenantResolveRateLimit } from "../middlewares/security.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import {
  otpRequestBody, otpVerifyBody, publicSetPasswordBody, signupPaymentBody, signupSelectPlanBody, signupStartBody, signupVerifyBody,
} from "../validators/common.validators.js";
import { sendSuccess } from "../lib/response.js";
import { requireSignupToken, requireSignupTokenForStatus } from "../middlewares/signup-auth.middleware.js";

export const publicRouter = Router(); publicRouter.use(publicRateLimit);
publicRouter.get("/app-config", (_req, res) => sendSuccess(res, { android: { minimumVersion: "1.0.0", forceUpdate: false }, ios: { minimumVersion: "1.0.0", forceUpdate: false }, maintenance: null }));
publicRouter.get("/auth/password-policy", (_req, res) => sendSuccess(res, { minLength: 8, requireUppercase: true, requireLowercase: true, requireNumber: true, requireSymbol: true }));
publicRouter.post("/auth/otp/request", otpRateLimit, validate({ body: otpRequestBody }), idempotent, asyncHandler(auth.requestOtp));
publicRouter.post("/auth/otp/verify", otpRateLimit, validate({ body: otpVerifyBody }), idempotent, asyncHandler(auth.verifyOtp));
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
publicRouter.post("/pay/:linkToken/initiate", idempotent, asyncHandler(payment.initiatePublic));
publicRouter.get("/pay/:linkToken/status", asyncHandler(payment.publicStatus));
