import dayjs from "dayjs";
import { DemoEvent, DemoInstance, DemoTemplate, DemoTemplateVersion, Tenant } from "../models/index.js";
import { AppError, errors } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import { randomToken, seal, sha256, unseal } from "../lib/crypto.js";
import { demoExpiryPolicy, maxActiveDemoInstances } from "../lib/demo-policy.js";
import { logger } from "../config/logger.js";
import { provisionDemoInstance } from "./demo-provision.service.js";
import { DemoEventType, DemoInstanceStatus, DemoTemplateVersionStatus } from "../constants/enums.js";

/**
 * DemoInstance CRUD + lifecycle (plan sections 8, 5.3, 6.2). createDemo returns as soon as the
 * PROVISIONING row + link secret exist; cloning runs in the background so large snapshots
 * (Payment/LedgerEntry) do not hang the HTTP request.
 */

const ACTIVE_STATUSES = [DemoInstanceStatus.PROVISIONING, DemoInstanceStatus.READY, DemoInstanceStatus.RESETTING];

function newLinkCredential() {
  const secret = randomToken(24);
  return { secret, hash: sha256(secret) };
}

export async function createDemo({
  templateId,
  prospectName,
  prospectContactMobile,
  branding,
  expiryDays,
  rememberLinkSecret,
  actorId,
}) {
  const template = await DemoTemplate.findById(templateId).lean();
  if (!template) throw errors.notFound("Demo template");
  if (!template.currentPublishedVersionId) {
    throw new AppError(
      "DEMO_TEMPLATE_NOT_PUBLISHED",
      "This template has no published version yet.",
      422,
    );
  }
  const version = await DemoTemplateVersion.findById(template.currentPublishedVersionId).lean();
  if (!version || version.status !== DemoTemplateVersionStatus.PUBLISHED) {
    throw new AppError("DEMO_TEMPLATE_NOT_PUBLISHED", "This template's published version is unavailable.", 422);
  }

  const activeCount = await DemoInstance.countDocuments({ status: { $in: ACTIVE_STATUSES } });
  if (activeCount >= maxActiveDemoInstances()) {
    throw new AppError(
      "DEMO_INSTANCE_LIMIT_REACHED",
      `The maximum number of active demo instances (${maxActiveDemoInstances()}) has been reached.`,
      409,
    );
  }

  const policy = demoExpiryPolicy();
  const requestedDays = Math.min(Number(expiryDays) || policy.defaultDays, policy.maxDays);
  const { secret, hash } = newLinkCredential();
  // Default ON so "Copy existing link" works after create. Opt out only when
  // rememberLinkSecret is explicitly false (hash-only / non-recoverable links).
  const persistRecoverableSecret = rememberLinkSecret !== false;

  const instance = await DemoInstance.create({
    _id: createId("dins"),
    publicId: randomToken(16),
    prospectName,
    prospectContactMobile: prospectContactMobile ?? null,
    branding: branding ?? {},
    templateVersionId: version._id,
    status: DemoInstanceStatus.PROVISIONING,
    expiresAt: dayjs().add(requestedDays, "day").toDate(),
    createdBy: actorId,
    linkSecretHash: hash,
    sealedLinkSecret: persistRecoverableSecret ? seal(secret) : null,
  });

  setImmediate(() => {
    provisionDemoInstance({ instanceId: instance._id, actorId }).catch((error) => {
      logger.error(
        { err: error, instanceId: instance._id },
        "background demo provision failed",
      );
    });
  });

  return { instance: instance.toObject(), linkSecret: secret };
}

export async function listDemos({ cursor, limit, status }) {
  return paginate(DemoInstance, {
    filters: status
      ? { status }
      : { status: { $ne: DemoInstanceStatus.DELETED } },
    cursor,
    limit,
    sort: "createdAt:desc",
  });
}

export async function getDemo(instanceId) {
  const instance = await DemoInstance.findById(instanceId).lean();
  if (!instance) throw errors.notFound("Demo instance");
  return instance;
}

const PATCHABLE_FIELDS = ["prospectName", "prospectContactMobile", "branding"];

export async function updateDemo({ instanceId, patch, expectedVersion }) {
  const set = {};
  let brandingChanged = false;
  for (const field of PATCHABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    if (field === "branding") {
      for (const [key, value] of Object.entries(patch.branding ?? {})) {
        set[`branding.${key}`] = value;
        brandingChanged = true;
      }
    } else {
      set[field] = patch[field];
    }
  }

  const inc = { version: 1, ...(brandingChanged ? { "branding.revision": 1 } : {}) };
  const result = await DemoInstance.findOneAndUpdate(
    { _id: instanceId, version: expectedVersion },
    { $set: set, $inc: inc },
    { new: true },
  ).lean();
  if (!result) {
    const exists = await DemoInstance.exists({ _id: instanceId });
    if (!exists) throw errors.notFound("Demo instance");
    throw new AppError("VERSION_CONFLICT", "This demo instance was changed by someone else. Reload and retry.", 409);
  }
  if (brandingChanged && result.activeTenantId) {
    const tenantSet = Object.fromEntries(
      Object.entries(patch.branding ?? {}).map(([key, value]) => [`branding.${key}`, value]),
    );
    await Tenant.findByIdAndUpdate(result.activeTenantId, {
      $set: tenantSet,
      $inc: { "branding.revision": 1 },
    });
  }
  return result;
}

export async function rotateLink(instanceId, { rememberLinkSecret } = {}) {
  const { secret, hash } = newLinkCredential();
  // Keep the new secret recoverable by default (same rule as create).
  const persistRecoverableSecret = rememberLinkSecret !== false;
  const instance = await DemoInstance.findByIdAndUpdate(
    instanceId,
    {
      $set: {
        linkSecretHash: hash,
        sealedLinkSecret: persistRecoverableSecret ? seal(secret) : null,
      },
      $inc: { linkVersion: 1 },
    },
    { new: true },
  ).lean();
  if (!instance) throw errors.notFound("Demo instance");
  await DemoEvent.create({ instanceId, type: DemoEventType.LINK_ROTATED, metadata: { linkVersion: instance.linkVersion } });
  return { instance, linkSecret: secret };
}

export async function copyLink(instanceId) {
  const instance = await DemoInstance.findById(instanceId).select("+sealedLinkSecret publicId").lean();
  if (!instance) throw errors.notFound("Demo instance");
  if (!instance.sealedLinkSecret) {
    throw new AppError(
      "DEMO_LINK_NOT_RECOVERABLE",
      "This demo's link secret wasn't saved for recovery. Rotate the link to get a new one.",
      409,
    );
  }
  return { publicId: instance.publicId, linkSecret: unseal(instance.sealedLinkSecret) };
}

export async function disableDemo(instanceId, actorId) {
  const instance = await DemoInstance.findOneAndUpdate(
    { _id: instanceId, status: { $ne: DemoInstanceStatus.DISABLED } },
    { $set: { status: DemoInstanceStatus.DISABLED, disabledAt: new Date() } },
    { new: true },
  ).lean();
  if (!instance) throw errors.notFound("Demo instance");
  await DemoEvent.create({ instanceId, type: DemoEventType.INSTANCE_DISABLED, actorId: actorId ?? null, actorType: actorId ? "PLATFORM_USER" : null });
  return instance;
}

export async function reactivateDemo(instanceId, actorId) {
  const current = await DemoInstance.findById(instanceId).lean();
  if (!current) throw errors.notFound("Demo instance");
  if (current.status !== DemoInstanceStatus.DISABLED) {
    throw new AppError("DEMO_NOT_DISABLED", "Only a disabled demo instance can be reactivated.", 409);
  }
  if (current.expiresAt && new Date(current.expiresAt).getTime() <= Date.now()) {
    throw new AppError("DEMO_EXPIRED", "This demo has expired and cannot be reactivated. Extend its expiry first.", 409);
  }
  const instance = await DemoInstance.findByIdAndUpdate(
    instanceId,
    { $set: { status: DemoInstanceStatus.READY, disabledAt: null } },
    { new: true },
  ).lean();
  await DemoEvent.create({ instanceId, type: DemoEventType.INSTANCE_REACTIVATED, actorId: actorId ?? null, actorType: actorId ? "PLATFORM_USER" : null });
  return instance;
}
