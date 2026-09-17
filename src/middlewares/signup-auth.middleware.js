import { timingSafeEqual } from "node:crypto";
import { Signup } from "../models/index.js";
import { SignupStatus } from "../constants/enums.js";
import { AppError, errors } from "../lib/app-error.js";
import { asyncHandler } from "../lib/async-handler.js";
import { sha256 } from "../lib/crypto.js";

async function loadSignup(signupId) {
  const signup = await Signup.findById(signupId).select("+signupTokenHash");
  if (!signup) throw errors.notFound("Signup session");
  return signup;
}

function assertSignupToken(signup, rawToken) {
  if (!rawToken) throw errors.unauthenticated("Bearer signup token is required.");
  if (!signup.signupTokenHash || !signup.signupTokenExpiresAt) {
    throw new AppError("SIGNUP_TOKEN_REQUIRED", "Complete OTP verification to obtain a signup token.", 401);
  }
  if (signup.signupTokenExpiresAt.getTime() < Date.now()) {
    throw new AppError("SIGNUP_TOKEN_EXPIRED", "The signup token has expired. Restart signup.", 401);
  }
  const expected = Buffer.from(signup.signupTokenHash, "utf8");
  const received = Buffer.from(sha256(rawToken), "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw errors.unauthenticated("The signup token is invalid.");
  }
}

/** Required for plan selection and payment after OTP verification. */
export const requireSignupToken = asyncHandler(async (req, _res, next) => {
  const signup = await loadSignup(req.params.signupId);
  const [, rawToken] = (req.headers.authorization ?? "").split(" ");
  assertSignupToken(signup, rawToken);
  req.signup = signup;
  next();
});

/**
 * Status polling: open before OTP verify; requires signup token once OTP is verified or later.
 * Responses that include `setPasswordToken` never occur without a valid signup token.
 */
export const requireSignupTokenForStatus = asyncHandler(async (req, _res, next) => {
  const signup = await loadSignup(req.params.signupId);
  if (signup.status === SignupStatus.OTP_PENDING) {
    req.signup = signup;
    return next();
  }
  const [, rawToken] = (req.headers.authorization ?? "").split(" ");
  assertSignupToken(signup, rawToken);
  req.signup = signup;
  next();
});
