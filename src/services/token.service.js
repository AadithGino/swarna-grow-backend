import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { Session } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { errors, AppError } from "../lib/app-error.js";

const accessTtl = (subject) => subject.type === "TENANT_USER" && subject.mobileClient ? env.JWT_MOBILE_TTL : env.JWT_WEB_TTL;
export function signAccessToken(subject) {
  return jwt.sign({
    typ: subject.type,
    tid: subject.tenantId ?? undefined,
    bid: subject.branchId ?? null,
    rol: subject.role,
    per: subject.permissions ?? [],
    did: subject.deviceId,
    sv: subject.securityVersion ?? 0,
    sid: subject.sessionId ?? undefined,
  }, env.JWT_ACCESS_SECRET, { subject: subject.id, expiresIn: accessTtl(subject), issuer: "swarnagrow", audience: "swarnagrow-clients", jwtid: crypto.randomUUID() });
}
export function verifyAccessToken(token) {
  try { return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: "swarnagrow", audience: "swarnagrow-clients" }); }
  catch (error) { if (error.name === "TokenExpiredError") throw new AppError("TOKEN_EXPIRED", "Your session has expired.", 401); throw errors.unauthenticated("The access token is invalid."); }
}
export async function issueSession(subject, device, request) {
  const refreshToken = randomToken(48); const familyId = createId("session");
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86_400_000);
  const session = await Session.create({ userId: subject.type === "CUSTOMER" ? undefined : subject.id, customerId: subject.type === "CUSTOMER" ? subject.id : undefined, tenantId: subject.tenantId, deviceId: device.deviceId, familyId, refreshTokenHash: sha256(refreshToken), platform: device.platform, appVersion: device.appVersion, userAgent: request?.headers?.["user-agent"], ip: request?.ip, expiresAt });
  return {
    accessToken: signAccessToken({ ...subject, deviceId: device.deviceId, sessionId: session._id }),
    refreshToken,
    expiresAt,
    mobileClient: subject.mobileClient ?? device.platform !== "web",
  };
}
export async function rotateSession(refreshToken, subjectLoader) {
  const hash = sha256(refreshToken);
  const existing = await Session.findOneAndUpdate(
    {
      refreshTokenHash: hash,
      consumedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { consumedAt: new Date() } },
    { new: false },
  );
  if (!existing) {
    const stale = await Session.findOne({ refreshTokenHash: hash }).select("+refreshTokenHash");
    if (stale?.consumedAt) {
      await Session.updateMany({ familyId: stale.familyId }, { $set: { revokedAt: new Date() } });
      throw new AppError("TOKEN_REUSE_DETECTED", "This device session was revoked because a refresh token was reused.", 401);
    }
    throw errors.unauthenticated("The refresh token is invalid or expired.");
  }
  const subject = await subjectLoader(existing); if (!subject) throw errors.unauthenticated();
  const next = randomToken(48); const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86_400_000);
  const session = await Session.create({ userId: existing.userId, customerId: existing.customerId, tenantId: existing.tenantId, deviceId: existing.deviceId, familyId: existing.familyId, refreshTokenHash: sha256(next), platform: existing.platform, appVersion: existing.appVersion, expiresAt });
  return {
    accessToken: signAccessToken({ ...subject, deviceId: existing.deviceId, securityVersion: subject.securityVersion ?? 0, sessionId: session._id }),
    refreshToken: next,
    expiresAt,
    mobileClient: existing.platform !== "web",
  };
}
