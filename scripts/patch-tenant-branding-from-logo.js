/**
 * Re-extract primary / accent / splash colours from tenant logos and sync DemoInstance branding.
 *
 * Usage: npm run patch:tenant-branding-from-logo -- SHAZANAGOLDD GOLDFASHIONJ
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { UploadStatus } from "../src/constants/enums.js";
import { storageProvider } from "../src/integrations/storage.provider.js";
import { extractBrandColorsFromImageInput } from "../src/lib/logo-color-extract.js";
import { DemoInstance, Tenant, Upload } from "../src/models/index.js";

const MANUAL_OVERRIDES = {
  /** Client primary (Sachu) — deep maroon + gold accent */
  SHAZANAGOLDD: {
    primaryColor: "#460000",
    accentColor: "#C5A059",
    splashBackgroundColor: "#460000",
  },
  /** Purple gem mark — purple chrome, gold accent */
  GOLDFASHIONJ: {
    primaryColor: "#610051",
    accentColor: "#E5B84F",
    splashBackgroundColor: "#F3EDF2",
  },
  /** Forest-green wordmark, white type */
  FARAGOLDDEMO: {
    primaryColor: "#2D5A43",
    accentColor: "#FFFFFF",
    splashBackgroundColor: "#2D5A43",
  },
  /** Green leather + gold emblem */
  DIORAGOLDDEM: {
    primaryColor: "#163D2B",
    accentColor: "#D4AF37",
    splashBackgroundColor: "#163D2B",
  },
};

async function pinLogoUpload(uploadId) {
  if (!uploadId) return;
  await Upload.updateOne(
    { _id: uploadId },
    {
      $set: { status: UploadStatus.ATTACHED, scannedAt: new Date(), scanProvider: "skipped-patch" },
      $unset: { expiresAt: "" },
    },
  );
}

function mergeBranding(existing, colors) {
  return {
    ...(existing ?? {}),
    ...colors,
    splashEnabled: existing?.splashEnabled !== false,
    revision: (existing?.revision ?? 0) + 1,
  };
}

async function patchTenant(code) {
  const tenant = await Tenant.findOne({ code }).lean();
  if (!tenant) {
    console.warn(`Skip: tenant ${code} not found`);
    return;
  }
  const logoUploadId = tenant.branding?.logoUploadId;
  if (!logoUploadId) {
    console.warn(`Skip: ${code} has no logoUploadId`);
    return;
  }
  const upload = await Upload.findById(logoUploadId).lean();
  if (!upload?.objectKey) {
    console.warn(`Skip: upload missing for ${code}`);
    return;
  }
  await pinLogoUpload(logoUploadId);

  let colors = MANUAL_OVERRIDES[code];
  if (!colors) {
    const buffer = await storageProvider.readObjectBody(upload.objectKey);
    colors = await extractBrandColorsFromImageInput(buffer);
  }

  const branding = mergeBranding(
    { ...tenant.branding, logoUploadId, displayName: tenant.branding?.displayName ?? tenant.displayName },
    colors,
  );

  await Tenant.updateOne({ _id: tenant._id }, { $set: { branding, displayName: branding.displayName ?? tenant.displayName } });

  if (tenant.demoInstanceId) {
    const inst = await DemoInstance.findById(tenant.demoInstanceId).lean();
    const instBranding = mergeBranding(inst?.branding ?? {}, { ...colors, logoUploadId });
    await DemoInstance.updateOne({ _id: tenant.demoInstanceId }, { $set: { branding: instBranding } });
  }

  console.log(JSON.stringify({ code, logoUploadId, branding }, null, 2));
}

async function main() {
  const codes = process.argv.slice(2).map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (!codes.length) {
    console.error("Usage: node scripts/patch-tenant-branding-from-logo.js <TENANT_CODE> ...");
    process.exit(1);
  }
  await connectDatabase();
  for (const code of codes) {
    await patchTenant(code);
  }
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});