import { AppError, errors } from "../lib/app-error.js";
import { auditPlatformMutation } from "../lib/platform-audit.js";
import {
  buildBuyQuotePayload,
  buildSellQuotePayload,
  CALCULATION_VERSION,
  isRateStale,
} from "../lib/digital-metals-quote-engine.js";
import { createId } from "../lib/ids.js";
import { moneyRef } from "../lib/money.js";
import { withTransaction } from "../lib/transaction.js";
import {
  DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS,
  DigitalMetalQuote,
  DigitalMetalRateVersion,
  DigitalMetalSettingsVersion,
  DigitalMetalTermsPublication,
  Tenant,
} from "../models/index.js";
import { writeAudit } from "./audit.service.js";
import { AuditEntityType } from "../constants/enums.js";
import { attachSubscriptionCatalogPlan } from "../lib/subscription-plan-for-tenant.js";
import { presentDigitalMetalsAccessState } from "../lib/digital-metals-access.js";
import {
  assertQuoteAssetReadiness,
  assertTenantTaxAndTerms,
  computeTaxProfileFingerprint,
  computeTermsContentHash,
  DEFAULT_DIGITAL_METAL_ASSETS,
  loadTenantAssetReadiness,
  resolveAssetReadiness,
} from "../lib/digital-metals-readiness.js";

function assetKey(metal, finenessPpm) {
  return `${metal}:${finenessPpm}`;
}

async function latestSettings(tenantId, metal, finenessPpm, session) {
  const q = DigitalMetalSettingsVersion.findOne({ tenantId, metal, finenessPpm })
    .sort({ version: -1 })
    .session(session ?? null);
  return q.lean();
}

async function latestEffectiveRate(tenantId, metal, finenessPpm, at = new Date(), session) {
  return DigitalMetalRateVersion.findOne({
    tenantId,
    metal,
    finenessPpm,
    effectiveAt: { $lte: at },
  })
    .sort({ effectiveAt: -1, createdAt: -1 })
    .session(session ?? null)
    .lean();
}

async function loadNextFutureRate(tenantId, metal, finenessPpm, at = new Date(), session) {
  return DigitalMetalRateVersion.findOne({
    tenantId,
    metal,
    finenessPpm,
    effectiveAt: { $gt: at },
  })
    .sort({ effectiveAt: 1 })
    .session(session ?? null)
    .lean();
}

function mapSettingsRow(row) {
  if (!row) return null;
  return {
    id: row._id,
    metal: row.metal,
    finenessPpm: row.finenessPpm,
    version: row.version,
    buyFee: row.buyFee ?? { type: "NONE" },
    sellFee: row.sellFee ?? { type: "NONE" },
    taxLines: row.taxLines ?? [],
    quoteTtlSeconds: row.quoteTtlSeconds ?? 900,
    sellQuoteTtlSeconds: row.sellQuoteTtlSeconds ?? 900,
    sellApprovalTtlSeconds: row.sellApprovalTtlSeconds ?? 1800,
    rateMaxAgeSeconds: row.rateMaxAgeSeconds ?? DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS,
    exposureCapPaise: row.exposureCapPaise ?? null,
    holdingPeriodDays: row.holdingPeriodDays ?? 0,
    updatedAt: row.updatedAt,
  };
}

function mapRateRow(row) {
  if (!row) return null;
  return {
    rateVersionId: row._id,
    metal: row.metal,
    finenessPpm: row.finenessPpm,
    customerBuyRatePerGramPaise: row.customerBuyRatePerGramPaise,
    customerSellRatePerGramPaise: row.customerSellRatePerGramPaise,
    customerBuyRatePerGram: moneyRef(row.customerBuyRatePerGramPaise),
    customerSellRatePerGram: moneyRef(row.customerSellRatePerGramPaise),
    effectiveAt: row.effectiveAt,
    publishedAt: row.publishedAt,
    sequence: row.sequence,
    source: row.source ?? "MANUAL",
    maxAgeSeconds: null,
  };
}

function resolveEffectiveAt(body) {
  if (body.effectiveAt) return new Date(body.effectiveAt);
  if (body.effectiveAtLocal) {
    const parsed = new Date(body.effectiveAtLocal);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError("VALIDATION_FAILED", "effectiveAtLocal is not a valid date.", 422);
    }
    return parsed;
  }
  return new Date();
}

export async function getDigitalMetalsSettings(req) {
  const { metal, finenessPpm } = req.query;
  if (!metal || finenessPpm == null) {
    throw errors.validation([{ field: "metal", message: "metal and finenessPpm query params are required." }]);
  }
  const row = await latestSettings(req.auth.tenantId, metal, Number(finenessPpm));
  return {
    current: mapSettingsRow(row),
    liveReadiness: liveReadinessForTenant(req.tenant),
  };
}

function liveReadinessForTenant(tenant) {
  const access = presentDigitalMetalsAccessState(tenant);
  return {
    planEntitled: access.planEntitled,
    tenantEnabled: access.enabled,
    taxProfileApproved: Boolean(tenant?.operations?.digitalMetalsTaxProfileApprovedAt),
    termsPublished: Boolean(String(tenant?.operations?.digitalMetalsTermsVersion ?? "").trim()),
    termsVersion: tenant?.operations?.digitalMetalsTermsVersion ?? null,
  };
}

export async function patchDigitalMetalsSettings(req) {
  const tenantId = req.auth.tenantId;
  const { metal, finenessPpm, expectedVersion, ...patch } = req.body;
  if (patch.exposureCapPaise !== undefined && patch.exposureCapPaise != null) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Exposure cap is not enforced in this release and cannot be enabled.",
      422,
    );
  }
  delete patch.exposureCapPaise;
  return withTransaction(async (session) => {
    const current = await latestSettings(tenantId, metal, finenessPpm, session);
    if (!current && expectedVersion !== 1) {
      throw errors.conflict("VERSION_CONFLICT", "Settings version mismatch.", { expectedVersion, current: 0 });
    }
    if (current && Number(current.version) !== Number(expectedVersion)) {
      throw errors.conflict("VERSION_CONFLICT", "Settings version mismatch.", {
        expectedVersion,
        current: current.version,
      });
    }
    const nextVersion = (current?.version ?? 0) + 1;
    const base = mapSettingsRow(current) ?? {
      buyFee: { type: "NONE" },
      sellFee: { type: "NONE" },
      taxLines: [],
      quoteTtlSeconds: 900,
      sellQuoteTtlSeconds: 900,
      sellApprovalTtlSeconds: 1800,
      rateMaxAgeSeconds: DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS,
      exposureCapPaise: null,
      holdingPeriodDays: 0,
    };
    const row = (
      await DigitalMetalSettingsVersion.create(
        [
          {
            _id: createId("dmsv"),
            tenantId,
            metal,
            finenessPpm,
            version: nextVersion,
            buyFee: patch.buyFee ?? base.buyFee,
            sellFee: patch.sellFee ?? base.sellFee,
            taxLines: patch.taxLines ?? base.taxLines,
            quoteTtlSeconds: patch.quoteTtlSeconds ?? base.quoteTtlSeconds,
            sellQuoteTtlSeconds: patch.sellQuoteTtlSeconds ?? base.sellQuoteTtlSeconds,
            sellApprovalTtlSeconds: patch.sellApprovalTtlSeconds ?? base.sellApprovalTtlSeconds,
            rateMaxAgeSeconds: patch.rateMaxAgeSeconds ?? base.rateMaxAgeSeconds,
            exposureCapPaise: base.exposureCapPaise ?? null,
            holdingPeriodDays: patch.holdingPeriodDays ?? base.holdingPeriodDays ?? 0,
            enteredBy: req.auth.id,
          },
        ],
        { session },
      )
    )[0];
    await writeAudit({
      req,
      action: "DIGITAL_METALS_SETTINGS_PUBLISHED",
      entityType: AuditEntityType.TENANT,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    return mapSettingsRow(row.toObject());
  });
}

export async function getDigitalMetalsRatesCurrent(req) {
  const metal = req.query.metal;
  const finenessPpm = Number(req.query.finenessPpm);
  if (!metal || !finenessPpm) {
    throw errors.validation([{ field: "metal", message: "metal and finenessPpm are required." }]);
  }
  const settings = await latestSettings(req.auth.tenantId, metal, finenessPpm);
  const rate = await latestEffectiveRate(req.auth.tenantId, metal, finenessPpm);
  const mapped = mapRateRow(rate);
  if (mapped && settings) {
    mapped.maxAgeSeconds = settings.rateMaxAgeSeconds ?? DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS;
  }
  return {
    rate: mapped,
    stale: mapped && settings
      ? isRateStale(rate, settings.rateMaxAgeSeconds ?? DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS)
      : true,
    settingsVersion: settings?.version ?? null,
  };
}

export async function listDigitalMetalsRatesHistory(req) {
  const metal = req.query.metal;
  const finenessPpm = Number(req.query.finenessPpm);
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const rows = await DigitalMetalRateVersion.find({ tenantId: req.auth.tenantId, metal, finenessPpm })
    .sort({ effectiveAt: -1, createdAt: -1 })
    .limit(limit)
    .lean();
  return { items: rows.map(mapRateRow) };
}

export async function publishDigitalMetalsRate(req) {
  const tenantId = req.auth.tenantId;
  const effectiveAt = resolveEffectiveAt(req.body);
  if (effectiveAt.getTime() > Date.now() + 365 * 86_400_000) {
    throw new AppError("INVALID_SCHEDULE", "effectiveAt is too far in the future.", 422);
  }
  const { metal, finenessPpm, customerBuyRatePerGramPaise, customerSellRatePerGramPaise, expectedSequence } =
    req.body;
  return withTransaction(async (session) => {
    const last = await DigitalMetalRateVersion.findOne({ tenantId, metal, finenessPpm })
      .sort({ sequence: -1 })
      .session(session)
      .lean();
    const nextSequence = (last?.sequence ?? 0) + 1;
    if (expectedSequence != null && Number(expectedSequence) !== nextSequence) {
      throw errors.conflict("VERSION_CONFLICT", "Rate sequence mismatch.", {
        expectedSequence,
        nextSequence,
      });
    }
    const row = (
      await DigitalMetalRateVersion.create(
        [
          {
            _id: createId("dmrv"),
            tenantId,
            metal,
            finenessPpm,
            customerBuyRatePerGramPaise,
            customerSellRatePerGramPaise,
            effectiveAt,
            publishedAt: new Date(),
            sequence: nextSequence,
            source: "MANUAL",
            enteredBy: req.auth.id,
          },
        ],
        { session },
      )
    )[0];
    await writeAudit({
      req,
      action: "DIGITAL_METALS_RATE_PUBLISHED",
      entityType: AuditEntityType.TENANT,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    return mapRateRow(row.toObject());
  });
}

export async function assertQuotePrerequisites(tenant, tenantId, metal, finenessPpm) {
  if (!presentDigitalMetalsAccessState(tenant).planEntitled) {
    throw new AppError("FEATURE_NOT_ENTITLED", "Plan does not include digital metals.", 403);
  }
  const settings = await latestSettings(tenantId, metal, finenessPpm);
  const rate = await latestEffectiveRate(tenantId, metal, finenessPpm);
  const futureRate = await loadNextFutureRate(tenantId, metal, finenessPpm);
  assertQuoteAssetReadiness(resolveAssetReadiness({ settings, effectiveRate: rate, futureRate }));
  const settingsRows = await Promise.all(
    DEFAULT_DIGITAL_METAL_ASSETS.map((a) => latestSettings(tenantId, a.metal, a.finenessPpm)),
  );
  const taxFingerprint = computeTaxProfileFingerprint(settingsRows);
  const publication = tenant?.operations?.digitalMetalsTermsVersion
    ? await DigitalMetalTermsPublication.findOne({
        tenantId,
        termsVersion: tenant.operations.digitalMetalsTermsVersion,
      }).lean()
    : null;
  assertTenantTaxAndTerms(tenant, { taxFingerprint, termsPublication: publication });
  return { settings, rate };
}

export async function previewDigitalMetalsQuote(req) {
  const tenant = req.tenant ?? (await attachSubscriptionCatalogPlan(await Tenant.findById(req.auth.tenantId).lean()));
  const { side, metal, finenessPpm } = req.body;
  const { settings, rate } = await assertQuotePrerequisites(tenant, req.auth.tenantId, metal, finenessPpm);

  let core;
  if (side === "BUY") {
    core = buildBuyQuotePayload({
      inputMode: req.body.inputMode,
      budgetPaise: req.body.budgetPaise,
      quantityUg: req.body.quantityUg,
      buyRatePerGramPaise: rate.customerBuyRatePerGramPaise,
      buyFeeRule: settings.buyFee,
      taxLines: settings.taxLines,
    });
  } else {
    core = buildSellQuotePayload({
      quantityUg: req.body.quantityUg,
      sellRatePerGramPaise: rate.customerSellRatePerGramPaise,
      sellFeeRule: settings.sellFee,
      taxLines: settings.taxLines,
    });
  }

  const ttlSeconds = side === "BUY" ? settings.quoteTtlSeconds : settings.sellQuoteTtlSeconds;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const snapshot = {
    ...core,
    metalQuantityUg: String(core.quantityUg),
    feeLines: core.feePaise
      ? [{ code: side === "BUY" ? "BUY_FEE" : "SELL_FEE", amountPaise: core.feePaise }]
      : [],
    taxLines: core.taxLines ?? [],
    totalPayablePaise: core.totalPayablePaise,
    settlementPaise: core.settlementPaise,
    budgetRemainderPaise: core.budgetRemainderPaise ?? 0,
    rateSnapshot: {
      buyRatePerGramPaise: rate.customerBuyRatePerGramPaise,
      sellRatePerGramPaise: rate.customerSellRatePerGramPaise,
      rateVersionId: rate._id,
    },
    settingsVersion: settings.version,
    termsVersion: tenant.operations.digitalMetalsTermsVersion,
    calculationVersion: CALCULATION_VERSION,
  };

  const quote = await DigitalMetalQuote.create({
    _id: createId("dmq"),
    tenantId: req.auth.tenantId,
    quoteSource: "ADMIN_PREVIEW",
    side,
    metal,
    finenessPpm,
    inputMode: req.body.inputMode ?? (side === "SELL" ? "QUANTITY_UG" : req.body.inputMode),
    snapshot,
    expiresAt,
    settingsVersionId: settings._id,
    rateVersionId: rate._id,
    termsVersion: tenant.operations.digitalMetalsTermsVersion,
    calculationVersion: CALCULATION_VERSION,
    createdBySubject: req.auth.id,
  });

  return {
    quoteId: quote._id,
    expiresAt: quote.expiresAt,
    side,
    metal,
    finenessPpm,
    ...snapshot,
  };
}

export async function setTenantDigitalMetalsPause(req) {
  const pause = req.body.pause === true;
  const reason = String(req.body.reason ?? "").trim();
  if (pause && reason.length < 3) {
    throw new AppError("VALIDATION_FAILED", "reason is required when pausing (min 3 characters).", 422);
  }
  const tenant = await Tenant.findById(req.auth.tenantId);
  if (!tenant) throw errors.notFound("Tenant");
  const before = tenant.operations?.toObject?.() ?? tenant.operations ?? {};
  tenant.operations = {
    ...before,
    digitalMetalsPaused: pause,
    digitalMetalsPauseReason: pause ? reason : "",
    ...(pause
      ? { digitalMetalsPausedAt: new Date(), digitalMetalsPausedBy: req.auth.id }
      : {}),
  };
  tenant.version += 1;
  await tenant.save();
  await writeAudit({
    req,
    action: pause ? "DIGITAL_METALS_TENANT_PAUSED" : "DIGITAL_METALS_TENANT_RESUMED",
    entityType: AuditEntityType.TENANT,
    entityId: tenant._id,
    before,
    after: tenant.operations?.toObject?.() ?? tenant.operations,
  });
  return {
    digitalMetalsPaused: pause,
    reason: pause ? reason : null,
    version: tenant.version,
  };
}

export async function getPlatformDigitalMetalsStatus(tenantId) {
  const tenant = await attachSubscriptionCatalogPlan(await Tenant.findById(tenantId).lean());
  if (!tenant) throw errors.notFound("Tenant");
  const { enrichCapabilityDto } = await import("../lib/digital-metals-capability-build.js");
  const { presentDigitalMetalsAccessStateForTenant } = await import("../lib/digital-metals-access.js");
  const access = await presentDigitalMetalsAccessStateForTenant(tenant);
  const capability = await enrichCapabilityDto(
    tenant,
    { hasLegacyActivity: access.hasLegacyActivity },
    {
      loadSettings: latestSettings,
      loadEffectiveRate: latestEffectiveRate,
      loadNextFutureRate,
    },
  );
  return {
    tenantId,
    operations: {
      digitalMetalsEnabled: tenant.operations?.digitalMetalsEnabled === true,
      digitalMetalsPaused: tenant.operations?.digitalMetalsPaused === true,
      digitalMetalsPauseReason: tenant.operations?.digitalMetalsPauseReason ?? "",
      digitalMetalsPlatformPaused: tenant.operations?.digitalMetalsPlatformPaused === true,
      digitalMetalsPlatformPauseReason: tenant.operations?.digitalMetalsPlatformPauseReason ?? "",
      digitalMetalsTaxProfileApprovedAt: tenant.operations?.digitalMetalsTaxProfileApprovedAt ?? null,
      digitalMetalsTaxProfileFingerprint: tenant.operations?.digitalMetalsTaxProfileFingerprint ?? "",
      digitalMetalsTermsVersion: tenant.operations?.digitalMetalsTermsVersion ?? "",
      digitalMetalsTermsContentHash: tenant.operations?.digitalMetalsTermsContentHash ?? "",
    },
    entitlement: {
      planEntitled: access.planEntitled,
      featureKey: "digitalMetals",
    },
    capability,
  };
}

export async function platformApproveDigitalMetalsTax(tenantId, body, req) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw errors.notFound("Tenant");
  const before = tenant.operations?.toObject?.() ?? tenant.operations ?? {};
  let fingerprint = "";
  if (body.approve === true) {
    const settingsRows = await Promise.all(
      DEFAULT_DIGITAL_METAL_ASSETS.map((a) => latestSettings(tenantId, a.metal, a.finenessPpm)),
    );
    if (settingsRows.some((row) => !row)) {
      throw new AppError(
        "TAX_CONFIG_INCOMPLETE",
        "Publish asset settings for all default metals before tax approval.",
        422,
      );
    }
    fingerprint = computeTaxProfileFingerprint(settingsRows);
  }
  tenant.operations = {
    ...before,
    digitalMetalsTaxProfileApprovedAt: body.approve === true ? new Date() : null,
    digitalMetalsTaxProfileFingerprint: body.approve === true ? fingerprint : "",
  };
  tenant.version += 1;
  await tenant.save();
  await auditPlatformMutation({
    req,
    action: body.approve ? "PLATFORM_DIGITAL_METALS_TAX_APPROVED" : "PLATFORM_DIGITAL_METALS_TAX_REVOKED",
    entityType: AuditEntityType.TENANT,
    entityId: tenantId,
    tenantId,
    before,
    after: tenant.operations?.toObject?.() ?? tenant.operations,
  });
  return { tenantId, approved: body.approve === true, fingerprint: fingerprint || null };
}

export async function platformPublishDigitalMetalsTerms(tenantId, body, req) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw errors.notFound("Tenant");
  const contentSnapshot = String(body.contentSnapshot ?? "").trim();
  if (!contentSnapshot) {
    throw new AppError("VALIDATION_FAILED", "contentSnapshot is required for immutable terms publication.", 422);
  }
  const contentHash = computeTermsContentHash({
    termsVersion: body.termsVersion,
    contentSnapshot,
  });
  const before = tenant.operations?.toObject?.() ?? tenant.operations ?? {};
  await DigitalMetalTermsPublication.create({
    _id: createId("dmtp"),
    tenantId,
    termsVersion: body.termsVersion,
    contentHash,
    contentSnapshot,
    contentRef: body.contentRef ?? "",
    publishedAt: new Date(),
    publishedBy: req.auth?.id ?? null,
    active: true,
  });
  tenant.operations = {
    ...before,
    digitalMetalsTermsVersion: body.termsVersion,
    digitalMetalsTermsContentHash: contentHash,
  };
  tenant.version += 1;
  await tenant.save();
  await auditPlatformMutation({
    req,
    action: "PLATFORM_DIGITAL_METALS_TERMS_PUBLISHED",
    entityType: AuditEntityType.TENANT,
    entityId: tenantId,
    tenantId,
    before,
    after: tenant.operations?.toObject?.() ?? tenant.operations,
  });
  return { tenantId, termsVersion: body.termsVersion, contentHash };
}

export async function getAdminDigitalMetalsCapabilityAssets(req) {
  return loadTenantAssetReadiness(req.auth.tenantId, {
    loadSettings: latestSettings,
    loadEffectiveRate: latestEffectiveRate,
    loadNextFutureRate,
  });
}

export { assetKey, latestSettings, latestEffectiveRate, loadNextFutureRate };
