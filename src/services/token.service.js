import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { Session } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";

const accessTtl = (subject) => subject.type === "TENANT_USER" && subject.mobileClient ? env.JWT_MOBILE_TTL : env.JWT_WEB_TTL;
/** Allow duplicate refresh with the same consumed token briefly (multi-tab / parallel 401). */
const REFRESH_REUSE_GRACE_MS = 30_000;
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
async function resolveConsumedRefresh(existing, subjectLoader, mongoSession) {
  const consumedAgeMs = Date.now() - new Date(existing.consumedAt).getTime();
  if (consumedAgeMs <= REFRESH_REUSE_GRACE_MS) {
    const successor = await Session.findOne({
      familyId: existing.familyId,
      revokedAt: null,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .session(mongoSession);
    if (successor) {
      const subject = await subjectLoader(successor);
      if (!subject) return { invalid: true };
      return {
        idempotent: true,
        subject,
        sessionId: successor._id,
        existing: successor,
        expiresAt: successor.expiresAt,
      };
    }
  }
  await Session.updateMany(
    { familyId: existing.familyId },
    { $set: { revokedAt: new Date() } },
    { session: mongoSession },
  );
  return { reused: true };
}

export async function rotateSession(refreshToken, subjectLoader) {
  const hash = sha256(refreshToken);
  const result = await withTransaction(async (mongoSession) => {
    const claimed = await Session.findOneAndUpdate(
      {
        refreshTokenHash: hash,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
        consumedAt: null,
      },
      { $set: { consumedAt: new Date() } },
      { new: false, session: mongoSession },
    ).select("+refreshTokenHash");
    if (claimed) {
      const subject = await subjectLoader(claimed);
      if (!subject) return { invalid: true };
      const next = randomToken(48);
      const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86_400_000);
      const [nextSession] = await Session.create([{
        userId: claimed.userId,
        customerId: claimed.customerId,
        tenantId: claimed.tenantId,
        deviceId: claimed.deviceId,
        familyId: claimed.familyId,
        refreshTokenHash: sha256(next),
        platform: claimed.platform,
        appVersion: claimed.appVersion,
        expiresAt,
      }], { session: mongoSession });
      return { subject, next, expiresAt, sessionId: nextSession._id, existing: claimed };
    }

    const existing = await Session.findOne({ refreshTokenHash: hash })
      .select("+refreshTokenHash")
      .session(mongoSession);
    if (!existing || existing.revokedAt || existing.expiresAt <= new Date()) {
      return { invalid: true };
    }
    if (existing.consumedAt) {
      return resolveConsumedRefresh(existing, subjectLoader, mongoSession);
    }
    return { invalid: true };
  });
  if (result.reused) {
    throw new AppError("TOKEN_REUSE_DETECTED", "This device session was revoked because a refresh token was reused.", 401);
  }
  if (result.invalid) throw errors.unauthenticated("The refresh token is invalid or expired.");
  if (result.idempotent) {
    const { subject, sessionId, existing, expiresAt } = result;
    return {
      accessToken: signAccessToken({
        ...subject,
        deviceId: existing.deviceId,
        securityVersion: subject.securityVersion ?? 0,
        sessionId,
      }),
      expiresAt,
      mobileClient: existing.platform !== "web",
    };
  }
  const { subject, next, expiresAt, sessionId, existing } = result;
  return {
    accessToken: signAccessToken({ ...subject, deviceId: existing.deviceId, securityVersion: subject.securityVersion ?? 0, sessionId }),
    refreshToken: next,
    expiresAt,
    mobileClient: existing.platform !== "web",
  };
}
