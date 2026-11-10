import { DemoInstance } from "../models/index.js";
import { AppError, errors } from "./app-error.js";
import { DemoInstanceStatus } from "../constants/enums.js";

/**
 * Re-checks a demo customer session against current DemoInstance state (plan section 6.1:
 * "Refresh checks these against current server state"). Called from both
 * auth.middleware.js#authenticate and auth.service.js#refresh so a demo session can't outlive
 * a reset, disable, expiry, or link rotation just because its JWT hasn't expired yet.
 *
 * Error codes match plan section 7.
 *
 * @param {{ demoInstanceId: string, demoGenerationId: string, demoLinkVersion: number, tenantId: string }} params
 */
export async function assertDemoSessionStillValid({
  demoInstanceId,
  demoGenerationId,
  demoLinkVersion,
  tenantId,
}) {
  if (!demoInstanceId) {
    throw new AppError("DEMO_LINK_INVALID", "This demo session is missing its demo context.", 410);
  }
  const instance = await DemoInstance.findById(demoInstanceId).lean();
  if (!instance) throw new AppError("DEMO_LINK_INVALID", "This demo no longer exists.", 410);
  if (instance.status === DemoInstanceStatus.DISABLED) {
    throw new AppError("DEMO_DISABLED", "This demo has been disabled.", 410);
  }
  if (instance.status === DemoInstanceStatus.EXPIRED || instance.expiresAt?.getTime() <= Date.now()) {
    throw new AppError("DEMO_EXPIRED", "This demo has expired.", 410);
  }
  if (instance.status !== DemoInstanceStatus.READY) {
    throw new AppError("DEMO_NOT_READY", "This demo is not ready right now.", 409);
  }
  if (
    String(instance.activeGenerationId ?? "") !== String(demoGenerationId ?? "") ||
    String(instance.activeTenantId ?? "") !== String(tenantId ?? "")
  ) {
    throw new AppError(
      "DEMO_GENERATION_CHANGED",
      "This demo was reset since you opened it. Open the demo link again.",
      409,
    );
  }
  if (Number(instance.linkVersion) !== Number(demoLinkVersion)) {
    throw new AppError("DEMO_LINK_INVALID", "This demo link was rotated. Use the latest link.", 410);
  }
  return instance;
}

/**
 * Cross-check used by authenticate(): an ordinary session must never resolve against a demo
 * tenant, and a demo session must never resolve against a live tenant (plan section 6.1).
 * @param {{ isDemoSession: boolean, tenantIsDemo: boolean }} params
 */
export function assertDemoSessionTenantMatch({ isDemoSession, tenantIsDemo }) {
  if (Boolean(isDemoSession) !== Boolean(tenantIsDemo)) {
    throw errors.unauthenticated("This session does not match its tenant.");
  }
}

/**
 * Used by the public branding/session-exchange endpoints (plan section 6.2), before any
 * session exists yet. Same status/expiry reasoning as assertDemoSessionStillValid, but
 * without the generation/link-version comparison (there is no prior session to compare
 * against — the caller is establishing the first one).
 * @param {{ status?: string, expiresAt?: Date|string|null } | null} instance
 */
export function assertInstancePubliclyAccessible(instance) {
  if (!instance) throw new AppError("DEMO_LINK_INVALID", "This demo no longer exists.", 410);
  if (instance.status === DemoInstanceStatus.DISABLED) {
    throw new AppError("DEMO_DISABLED", "This demo has been disabled.", 410);
  }
  const expired =
    instance.status === DemoInstanceStatus.EXPIRED ||
    (instance.expiresAt && new Date(instance.expiresAt).getTime() <= Date.now());
  if (expired) throw new AppError("DEMO_EXPIRED", "This demo has expired.", 410);
  if (instance.status !== DemoInstanceStatus.READY) {
    throw new AppError("DEMO_NOT_READY", "This demo is not ready yet.", 409);
  }
}
