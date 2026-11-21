import { setImmediate } from "node:timers";
import { env } from "../config/env.js";
import { LandingDemoProvisionStatus, UserStatus, UserType } from "../constants/enums.js";
import { extractBrandColorsFromImageInput, parseLogoDataUrlBuffer } from "../lib/logo-color-extract.js";
import { logger } from "../config/logger.js";
import { DemoTemplate, LandingDemoRequest, Tenant, User } from "../models/index.js";
import { createDemo } from "./demo-instance.service.js";
import { ingestPlatformDemoLogoFromBuffer } from "./upload.service.js";
import { DemoInstance } from "../models/index.js";

async function resolvePlatformActorId() {
  const user = await User.findOne({
    type: UserType.PLATFORM_USER,
    status: UserStatus.ACTIVE,
  })
    .sort({ createdAt: 1 })
    .select("_id")
    .lean();
  return user?._id ?? "system-landing-demo";
}

async function resolveKairaliDemoTemplate() {
  const code = (env.LANDING_DEMO_TEMPLATE_TENANT_CODE ?? "KAIRALI").trim().toUpperCase();
  const tenant = await Tenant.findOne({ code }).select("_id code").lean();
  if (!tenant) return null;
  const template = await DemoTemplate.findOne({
    approvedSourceTenantId: tenant._id,
    currentPublishedVersionId: { $ne: null },
  })
    .sort({ updatedAt: -1 })
    .lean();
  return template;
}

function normalizeMobile(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("91") && digits.length >= 12) return `+${digits}`;
  return phone?.trim() || null;
}

export function scheduleLandingDemoAutoProvision(requestId) {
  if (!env.LANDING_DEMO_AUTO_PROVISION) return;
  setImmediate(() => {
    autoProvisionLandingDemoRequest(requestId).catch((err) => {
      logger.error({ err, requestId }, "landing demo auto-provision failed");
    });
  });
}

export async function autoProvisionLandingDemoRequest(requestId) {
  const row = await LandingDemoRequest.findById(requestId);
  if (!row || row.demoInstanceId) return row;

  await LandingDemoRequest.updateOne(
    { _id: requestId },
    { $set: { provisionStatus: LandingDemoProvisionStatus.RUNNING, provisionError: null } },
  );

  try {
    const template = await resolveKairaliDemoTemplate();
    if (!template?._id) {
      await LandingDemoRequest.updateOne(
        { _id: requestId },
        {
          $set: {
            provisionStatus: LandingDemoProvisionStatus.SKIPPED,
            provisionError: `No published demo template for tenant ${env.LANDING_DEMO_TEMPLATE_TENANT_CODE}. Register KAIRALI in Demo Builder first.`,
          },
        },
      );
      return null;
    }

    const actorId = await resolvePlatformActorId();
    const colors = await extractBrandColorsFromImageInput(row.logoDataUrl || null);

    let logoUploadId = null;
    const parsed = parseLogoDataUrlBuffer(row.logoDataUrl);
    if (parsed?.buffer?.length) {
      const ingested = await ingestPlatformDemoLogoFromBuffer({
        ownerId: actorId,
        buffer: parsed.buffer,
        contentType: parsed.contentType,
        fileName: row.logoFileName || "landing-logo.webp",
      });
      logoUploadId = ingested.uploadId;
    }

    const { instance } = await createDemo({
      templateId: template._id,
      prospectName: row.brandName || row.showroom,
      prospectContactMobile: normalizeMobile(row.phone),
      branding: {
        logoUploadId,
        primaryColor: colors.primaryColor,
        accentColor: colors.accentColor,
        splashBackgroundColor: colors.splashBackgroundColor,
        displayName: row.brandName || row.showroom,
        splashTagline: row.location ? `${row.brandName} · ${row.location}` : row.brandName,
        splashEnabled: true,
      },
      rememberLinkSecret: true,
      actorId,
    });

    await LandingDemoRequest.updateOne(
      { _id: requestId },
      {
        $set: {
          provisionStatus: LandingDemoProvisionStatus.READY,
          provisionError: null,
          demoInstanceId: instance._id,
          demoPublicId: instance.publicId,
          demoTemplateId: template._id,
          autoPrimaryColor: colors.primaryColor,
          autoAccentColor: colors.accentColor,
          autoSplashBackgroundColor: colors.splashBackgroundColor,
          logoUploadId,
        },
      },
    );
    return instance;
  } catch (error) {
    await LandingDemoRequest.updateOne(
      { _id: requestId },
      {
        $set: {
          provisionStatus: LandingDemoProvisionStatus.FAILED,
          provisionError: error?.message ?? "Auto-provision failed",
        },
      },
    );
    throw error;
  }
}

export async function landingDemoInstanceStatus(instanceId) {
  if (!instanceId) return null;
  const instance = await DemoInstance.findById(instanceId).select("status publicId").lean();
  return instance?.status ?? null;
}