import crypto from "node:crypto";
import { DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS } from "../models/digital-metals.models.js";
import { AppError } from "./app-error.js";
import { isRateStale } from "./digital-metals-quote-engine.js";

/** Default tenant assets evaluated for live readiness (tenant-wide; no branch rate overrides v1). */
export const DEFAULT_DIGITAL_METAL_ASSETS = [
  { metal: "GOLD", finenessPpm: 999_000 },
  { metal: "SILVER", finenessPpm: 999_000 },
];

export function stableTaxProfilePayload(settingsRows) {
  return (settingsRows ?? [])
    .filter(Boolean)
    .map((row) => ({
      metal: row.metal,
      finenessPpm: row.finenessPpm,
      settingsVersion: row.version,
      taxLines: (row.taxLines ?? [])
        .filter((t) => t?.active !== false)
        .map((t) => ({
          code: t.code,
          base: t.base ?? "METAL_SUBTOTAL",
          ratePercent: t.ratePercent,
        }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    }))
    .sort((a, b) => `${a.metal}:${a.finenessPpm}`.localeCompare(`${b.metal}:${b.finenessPpm}`));
}

export function computeTaxProfileFingerprint(settingsRows) {
  const payload = stableTaxProfilePayload(settingsRows);
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function computeTermsContentHash({ termsVersion, contentSnapshot }) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        termsVersion: String(termsVersion),
        contentSnapshot: String(contentSnapshot ?? ""),
      }),
    )
    .digest("hex");
}

function rateTimingState(rateRow, now = new Date()) {
  if (!rateRow) return "MISSING";
  const effectiveAt = new Date(rateRow.effectiveAt).getTime();
  if (effectiveAt > now.getTime()) return "FUTURE";
  return "CURRENT";
}

/**
 * Per-asset readiness — same rules as quote validation.
 */
export function resolveAssetReadiness({
  settings,
  effectiveRate,
  futureRate,
  metal: assetMetal,
  finenessPpm: assetFinenessPpm,
  now = new Date(),
}) {
  const issues = [];
  if (!settings) {
    issues.push({ code: "SETTINGS_MISSING", message: "Asset settings are not configured." });
  }
  const rateState = rateTimingState(effectiveRate, now);
  if (rateState === "MISSING") {
    issues.push({ code: "RATE_MISSING", message: "No effective rate is published for this asset." });
  } else if (rateState === "FUTURE") {
    issues.push({ code: "RATE_FUTURE", message: "Latest rate is scheduled for a future effective time." });
  } else if (
    settings
    && effectiveRate
    && isRateStale(
      effectiveRate,
      settings.rateMaxAgeSeconds ?? DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS,
      now,
    )
  ) {
    issues.push({ code: "STALE_RATE", message: "Published rate exceeds maximum age." });
  }
  return {
    metal: settings?.metal ?? effectiveRate?.metal ?? futureRate?.metal ?? assetMetal,
    finenessPpm: settings?.finenessPpm ?? effectiveRate?.finenessPpm ?? futureRate?.finenessPpm ?? assetFinenessPpm,
    settingsVersion: settings?.version ?? null,
    rateSequence: effectiveRate?.sequence ?? null,
    rateVersionId: effectiveRate?._id ?? null,
    rateTiming: rateState,
    rateStale: Boolean(
      settings && effectiveRate && rateState === "CURRENT"
        && isRateStale(
          effectiveRate,
          settings.rateMaxAgeSeconds ?? DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS,
          now,
        ),
    ),
    issues,
    quoteReady: issues.length === 0,
  };
}

export async function loadTenantAssetReadiness(tenantId, { loadSettings, loadEffectiveRate, loadNextFutureRate }, assets = DEFAULT_DIGITAL_METAL_ASSETS) {
  const rows = [];
  for (const asset of assets) {
    const settings = await loadSettings(tenantId, asset.metal, asset.finenessPpm);
    const effectiveRate = await loadEffectiveRate(tenantId, asset.metal, asset.finenessPpm);
    const futureRate = await loadNextFutureRate?.(tenantId, asset.metal, asset.finenessPpm);
    rows.push(
      resolveAssetReadiness({
        settings,
        effectiveRate,
        futureRate,
        metal: asset.metal,
        finenessPpm: asset.finenessPpm,
      }),
    );
  }
  return rows;
}

export function taxApprovalValid(tenant, fingerprint) {
  const approvedAt = tenant?.operations?.digitalMetalsTaxProfileApprovedAt;
  const approvedHash = tenant?.operations?.digitalMetalsTaxProfileFingerprint;
  if (!approvedAt || !approvedHash) return false;
  return approvedHash === fingerprint;
}

export function termsPublicationValid(tenant, publication) {
  const version = String(tenant?.operations?.digitalMetalsTermsVersion ?? "").trim();
  const hash = String(tenant?.operations?.digitalMetalsTermsContentHash ?? "").trim();
  if (!version || !hash || !publication) return false;
  return (
    publication.termsVersion === version
    && publication.contentHash === hash
    && String(publication.contentSnapshot ?? "").trim().length > 0
    && publication.active !== false
  );
}

export function assertQuoteAssetReadiness(readinessRow) {
  if (readinessRow?.quoteReady) return;
  const first = readinessRow?.issues?.[0];
  throw new AppError(first?.code ?? "NOT_READY", first?.message ?? "Asset is not ready for quoting.", 422);
}

export function assertTenantTaxAndTerms(tenant, { taxFingerprint, termsPublication }) {
  if (!taxApprovalValid(tenant, taxFingerprint)) {
    throw new AppError(
      "TAX_CONFIG_INCOMPLETE",
      "Approved tax configuration is required and must match the current settings versions.",
      422,
    );
  }
  if (!termsPublicationValid(tenant, termsPublication)) {
    throw new AppError(
      "TERMS_NOT_PUBLISHED",
      "Published customer terms must reference immutable content before quoting.",
      422,
    );
  }
}
