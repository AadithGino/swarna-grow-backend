import { buildDigitalMetalsCapability } from "./digital-metals-capability.js";
import {
  computeTaxProfileFingerprint,
  DEFAULT_DIGITAL_METAL_ASSETS,
  loadTenantAssetReadiness,
  taxApprovalValid,
  termsPublicationValid,
} from "./digital-metals-readiness.js";
import { DigitalMetalTermsPublication, DigitalMetalWallet } from "../models/index.js";

export async function enrichCapabilityDto(tenant, context, loaders) {
  const base = buildDigitalMetalsCapability(tenant, context);
  const assets = await loadTenantAssetReadiness(tenant._id ?? tenant.id, loaders);
  const settingsRows = await Promise.all(
    DEFAULT_DIGITAL_METAL_ASSETS.map((a) => loaders.loadSettings(tenant._id ?? tenant.id, a.metal, a.finenessPpm)),
  );
  const taxFingerprint = computeTaxProfileFingerprint(settingsRows);
  const taxOk = taxApprovalValid(tenant, taxFingerprint);
  const publication = tenant?.operations?.digitalMetalsTermsVersion
    ? await DigitalMetalTermsPublication.findOne({
        tenantId: tenant._id ?? tenant.id,
        termsVersion: tenant.operations.digitalMetalsTermsVersion,
      }).lean()
    : null;
  const termsOk = termsPublicationValid(tenant, publication);

  const blockers = [...(base.blockers ?? [])];
  if (!taxOk) {
    blockers.push({
      code: "TAX_CONFIG_INCOMPLETE",
      message: "Tax profile is not approved for the current settings versions.",
    });
  }
  if (!termsOk) {
    blockers.push({
      code: "TERMS_NOT_PUBLISHED",
      message: "Published customer terms must reference immutable content.",
    });
  }
  for (const asset of assets) {
    for (const issue of asset.issues ?? []) {
      if (!blockers.some((b) => b.code === issue.code && b.message === issue.message)) {
        blockers.push(issue);
      }
    }
  }

  const hasWalletHoldings = context.hasHoldings
    ?? (await DigitalMetalWallet.exists({
      tenantId: tenant._id ?? tenant.id,
      ...(context.customerId ? { customerId: context.customerId } : {}),
      heldUg: { $gt: 0 },
    }));

  const canViewHoldings = base.canViewHoldings || Boolean(hasWalletHoldings);
  const tradingAllowed = base.enabled && taxOk && termsOk && assets.every((a) => a.quoteReady);

  return {
    ...base,
    hasLegacyActivity: base.hasLegacyActivity || Boolean(hasWalletHoldings),
    canViewHoldings,
    canViewHistory: canViewHoldings,
    canPlaceNewBuy: tradingAllowed,
    canPlaceNewSell: tradingAllowed,
    canPlaceRedemption: tradingAllowed,
    blockers,
    taxProfileFingerprint: taxFingerprint,
    taxProfileApproved: taxOk,
    termsPublished: termsOk,
    termsContentHash: tenant?.operations?.digitalMetalsTermsContentHash ?? null,
    pause: {
      tenantPaused: tenant?.operations?.digitalMetalsPaused === true,
      tenantPauseReason: tenant?.operations?.digitalMetalsPauseReason ?? "",
      platformPaused: tenant?.operations?.digitalMetalsPlatformPaused === true,
      platformPauseReason: tenant?.operations?.digitalMetalsPlatformPauseReason ?? "",
    },
    assets,
    implementationPhase: 3,
    workspaceLive: true,
  };
}
