/**
 * Idempotent Digital Gold & Silver DB setup for demo tenant KAIRALI.
 * Run: node --env-file=.env scripts/seed-kairali-digital-metals.js
 * Requires: npm run seed:demo (or existing KAIRALI tenant + owner user).
 */
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { PlanTier, UserStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import {
  computeTaxProfileFingerprint,
  computeTermsContentHash,
  DEFAULT_DIGITAL_METAL_ASSETS,
  loadTenantAssetReadiness,
  taxApprovalValid,
  termsPublicationValid,
} from "../src/lib/digital-metals-readiness.js";
import { enrichCapabilityDto } from "../src/lib/digital-metals-capability-build.js";
import {
  DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS,
  DigitalMetalProcurementEntry,
  DigitalMetalRateVersion,
  DigitalMetalRedemptionCatalogItem,
  DigitalMetalSettingsVersion,
  DigitalMetalTermsPublication,
  GoldRate,
  Tenant,
  User,
} from "../src/models/index.js";
import { isRateStale } from "../src/lib/digital-metals-quote-engine.js";

const TERMS_VERSION = "kairali-digi-gold-v1";
const TERMS_SNAPSHOT = [
  "Kairali Jewellers — Digital Gold & Silver",
  "",
  "1. Purchases credit metal to your wallet at the quoted rate; holdings are in micrograms (fineness as shown).",
  "2. Sells and physical redemption debit reserved metal; INR proceeds follow jeweller payout rules.",
  "3. Rates, fees, and taxes are as displayed at checkout. Quotes expire per published TTL.",
  "4. Physical redemption is subject to catalogue, minting/delivery charges, and fulfilment availability.",
  "5. Contact Kairali Jewellers support for disputes; platform terms supplement jeweller policies.",
].join("\n");

async function latestSettings(tenantId, metal, finenessPpm) {
  return DigitalMetalSettingsVersion.findOne({ tenantId, metal, finenessPpm })
    .sort({ version: -1 })
    .lean();
}

async function effectiveRate(tenantId, metal, finenessPpm, now = new Date()) {
  return DigitalMetalRateVersion.findOne({
    tenantId,
    metal,
    finenessPpm,
    effectiveAt: { $lte: now },
  })
    .sort({ effectiveAt: -1, sequence: -1 })
    .lean();
}

async function ensureSettings(tenantId, metal, finenessPpm, enteredBy) {
  const existing = await latestSettings(tenantId, metal, finenessPpm);
  if (existing) {
    if (existing.rateMaxAgeSeconds < DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS) {
      const bumped = await DigitalMetalSettingsVersion.create({
        _id: createId("dmsv"),
        tenantId,
        metal,
        finenessPpm,
        version: existing.version + 1,
        buyFee: existing.buyFee ?? { type: "NONE" },
        sellFee: existing.sellFee ?? { type: "NONE" },
        taxLines: existing.taxLines ?? [],
        quoteTtlSeconds: existing.quoteTtlSeconds ?? 900,
        sellQuoteTtlSeconds: existing.sellQuoteTtlSeconds ?? 900,
        sellApprovalTtlSeconds: existing.sellApprovalTtlSeconds ?? 1800,
        rateMaxAgeSeconds: DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS,
        exposureCapPaise: existing.exposureCapPaise ?? null,
        holdingPeriodDays: existing.holdingPeriodDays ?? 0,
        enteredBy,
      });
      return bumped.toObject();
    }
    return existing;
  }
  return DigitalMetalSettingsVersion.create({
    _id: createId("dmsv"),
    tenantId,
    metal,
    finenessPpm,
    version: 1,
    buyFee: { type: "NONE" },
    sellFee: { type: "NONE" },
    taxLines: [],
    quoteTtlSeconds: 900,
    sellQuoteTtlSeconds: 900,
    sellApprovalTtlSeconds: 1800,
    rateMaxAgeSeconds: DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS,
    holdingPeriodDays: 0,
    enteredBy,
  }).then((d) => d.toObject());
}

async function ensureRate(tenantId, metal, finenessPpm, buyPaise, sellPaise, enteredBy, { forceFresh = false } = {}) {
  const now = new Date();
  const settings = await latestSettings(tenantId, metal, finenessPpm);
  const maxAge = settings?.rateMaxAgeSeconds ?? DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS;
  const current = await effectiveRate(tenantId, metal, finenessPpm, now);
  if (!forceFresh && current && !isRateStale(current, maxAge, now)) return current;

  const lastSeq = await DigitalMetalRateVersion.findOne({ tenantId, metal, finenessPpm })
    .sort({ sequence: -1 })
    .lean();
  const sequence = (lastSeq?.sequence ?? 0) + 1;
  return DigitalMetalRateVersion.create({
    _id: createId("dmrv"),
    tenantId,
    metal,
    finenessPpm,
    customerBuyRatePerGramPaise: buyPaise,
    customerSellRatePerGramPaise: sellPaise,
    effectiveAt: now,
    publishedAt: now,
    sequence,
    source: "KAIRALI_SEED",
    enteredBy,
  }).then((d) => d.toObject());
}

export async function ensureTerms(tenantId) {
  const contentHash = computeTermsContentHash({
    termsVersion: TERMS_VERSION,
    contentSnapshot: TERMS_SNAPSHOT,
  });
  let pub = await DigitalMetalTermsPublication.findOne({ tenantId, termsVersion: TERMS_VERSION }).lean();
  if (!pub) {
    pub = (
      await DigitalMetalTermsPublication.create({
        _id: createId("dmtp"),
        tenantId,
        termsVersion: TERMS_VERSION,
        contentSnapshot: TERMS_SNAPSHOT,
        contentHash,
        publishedAt: new Date(),
        publishedBy: "seed-kairali-digital-metals",
        active: true,
      })
    ).toObject();
  }
  return { contentHash, publication: pub };
}

async function ensureCatalogue(tenantId) {
  const items = [
    {
      sku: "KAIRALI-GOLD-2G-999",
      label: "Gold coin 2 g (999)",
      metal: "GOLD",
      finenessPpm: 999_000,
      unitQuantityUg: 2 * UG_PER_G,
      mintingRule: { type: "FLAT_INR", amountPaise: 0 },
      deliveryFlatPaise: 0,
      pickupEnabled: true,
      deliveryEnabled: true,
      leadTimeDays: 3,
    },
    {
      sku: "KAIRALI-SILVER-10G-999",
      label: "Silver bar 10 g (999)",
      metal: "SILVER",
      finenessPpm: 999_000,
      unitQuantityUg: 10 * UG_PER_G,
      mintingRule: { type: "FLAT_INR", amountPaise: 5000 },
      deliveryFlatPaise: 9900,
      pickupEnabled: true,
      deliveryEnabled: true,
      leadTimeDays: 5,
    },
  ];
  for (const row of items) {
    const exists = await DigitalMetalRedemptionCatalogItem.findOne({ tenantId, sku: row.sku }).lean();
    if (exists) continue;
    await DigitalMetalRedemptionCatalogItem.create({
      _id: createId("dmrci"),
      tenantId,
      ...row,
      active: true,
      version: 1,
    });
  }
}

async function ensureOpeningPosition(tenantId, ownerId, metal, finenessPpm, grams) {
  const key = `kairali-opening-${metal}-${finenessPpm}`;
  const exists = await DigitalMetalProcurementEntry.findOne({ tenantId, idempotencyKey: key }).lean();
  if (exists) return;
  const quantityUg = grams * UG_PER_G;
  await DigitalMetalProcurementEntry.create({
    tenantId,
    entryType: "OPENING_POSITION",
    status: "APPROVED",
    metal,
    finenessPpm,
    quantityUg,
    obligationQuantityUg: quantityUg,
    effectiveDate: "2020-01-01",
    evidenceUploadIds: [],
    createdByUserId: ownerId,
    approvedByUserId: ownerId,
    approvedAt: new Date(),
    idempotencyKey: key,
  });
}

/** Re-bind tax approval + terms pointers after settings/rate changes (demo / recovery). */
export async function syncKairaliDigitalMetalsTenantOps(tenantId, { taxFingerprint, contentHash }) {
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "operations.digitalMetalsEnabled": true,
        "operations.digitalMetalsPaused": false,
        "operations.digitalMetalsPauseReason": "",
        "operations.digitalMetalsTermsVersion": TERMS_VERSION,
        "operations.digitalMetalsTermsContentHash": contentHash,
        "operations.digitalMetalsTaxProfileApprovedAt": new Date(),
        "operations.digitalMetalsTaxProfileFingerprint": taxFingerprint,
        "operations.digitalMetalsPlatformPaused": false,
        "operations.digitalMetalsPlatformPauseReason": "",
        "subscription.tier": PlanTier.GROWTH,
        "subscription.planFeaturesSnapshot.digitalMetals": true,
        "subscription.featureOverrides.digitalMetals": true,
      },
    },
  );
}

async function resolveGoldRatePaise(tenantId) {
  const row = await GoldRate.findOne({ tenantId }).sort({ effectiveDate: -1, createdAt: -1 }).lean();
  if (row?.ratePerGramPaise) return row.ratePerGramPaise;
  return 725_000;
}

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: "KAIRALI" });
  if (!tenant) {
    throw new Error("KAIRALI tenant not found — run: npm run seed:demo");
  }
  const owner =
    (await User.findOne({ tenantId: tenant._id, role: "TENANT_OWNER", status: UserStatus.ACTIVE }).lean()) ??
    (await User.findOne({ tenantId: tenant._id, mobile: "9847012345", status: UserStatus.ACTIVE }).lean());
  if (!owner) throw new Error("KAIRALI owner user not found");

  const goldPaise = await resolveGoldRatePaise(tenant._id);
  const silverPaise = Math.max(500, Math.round(goldPaise / 90));

  const forceFreshRates = process.argv.includes("--refresh-rates");
  for (const asset of DEFAULT_DIGITAL_METAL_ASSETS) {
    await ensureSettings(tenant._id, asset.metal, asset.finenessPpm, owner._id);
    const buy = asset.metal === "GOLD" ? goldPaise : silverPaise;
    const sell = Math.max(1, buy - (asset.metal === "GOLD" ? 500 : 50));
    await ensureRate(tenant._id, asset.metal, asset.finenessPpm, buy, sell, owner._id, {
      forceFresh: forceFreshRates,
    });
  }

  const settingsRows = await Promise.all(
    DEFAULT_DIGITAL_METAL_ASSETS.map((a) => latestSettings(tenant._id, a.metal, a.finenessPpm)),
  );
  const taxFingerprint = computeTaxProfileFingerprint(settingsRows);
  const { contentHash } = await ensureTerms(tenant._id);

  await syncKairaliDigitalMetalsTenantOps(tenant._id, { taxFingerprint, contentHash });

  await ensureCatalogue(tenant._id);
  await ensureOpeningPosition(tenant._id, owner._id, "GOLD", 999_000, 500);
  await ensureOpeningPosition(tenant._id, owner._id, "SILVER", 999_000, 5_000);

  const fresh = await Tenant.findById(tenant._id).lean();
  const publication = await DigitalMetalTermsPublication.findOne({
    tenantId: tenant._id,
    termsVersion: TERMS_VERSION,
  }).lean();

  const loaders = {
    loadSettings: (tid, metal, finenessPpm) => latestSettings(tid, metal, finenessPpm),
    loadEffectiveRate: (tid, metal, finenessPpm) => effectiveRate(tid, metal, finenessPpm),
    loadNextFutureRate: async () => null,
  };
  const assets = await loadTenantAssetReadiness(fresh._id, loaders);
  const capability = await enrichCapabilityDto(fresh, {}, loaders);

  process.stdout.write(
    `${JSON.stringify(
      {
        tenantId: fresh._id,
        tenantCode: fresh.code,
        digitalMetalsEnabled: fresh.operations?.digitalMetalsEnabled,
        planDigitalMetals: fresh.subscription?.planFeaturesSnapshot?.digitalMetals,
        taxApproved: taxApprovalValid(fresh, taxFingerprint),
        termsOk: termsPublicationValid(fresh, publication),
        assets: assets.map((a) => ({
          metal: a.metal,
          finenessPpm: a.finenessPpm,
          quoteReady: a.quoteReady,
          issues: a.issues,
        })),
        canPlaceNewBuy: capability.canPlaceNewBuy,
        canPlaceNewSell: capability.canPlaceNewSell,
        canPlaceRedemption: capability.canPlaceRedemption,
        blockers: capability.blockers,
        termsVersion: TERMS_VERSION,
        goldRatePerGramPaiseUsed: goldPaise,
        silverRatePerGramPaiseUsed: silverPaise,
        note: "Local buy payments: set ECOMMERCE_PAYMENTS_TEST_HARNESS=true or configure PhonePe on tenant.",
      },
      null,
      2,
    )}\n`,
  );

  await disconnectDatabase();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
