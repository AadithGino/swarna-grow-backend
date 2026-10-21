/**
 * Refresh KAIRALI digital metals rates + tax approval (fixes stale rate / tax mismatch).
 * Usage: npm run patch:kairali-digital-metals
 *        npm run patch:kairali-digital-metals -- --refresh-rates
 */
import process from "node:process";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { UserStatus } from "../src/constants/enums.js";
import {
  computeTaxProfileFingerprint,
  DEFAULT_DIGITAL_METAL_ASSETS,
} from "../src/lib/digital-metals-readiness.js";
import {
  DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS,
  DigitalMetalRateVersion,
  GoldRate,
  Tenant,
  User,
} from "../src/models/index.js";
import { isRateStale } from "../src/lib/digital-metals-quote-engine.js";

async function latestSettings(tenantId, metal, finenessPpm) {
  const { DigitalMetalSettingsVersion } = await import("../src/models/index.js");
  return DigitalMetalSettingsVersion.findOne({ tenantId, metal, finenessPpm }).sort({ version: -1 }).lean();
}

async function bumpLegacyRateMaxAge(tenantId, metal, finenessPpm, enteredBy) {
  const existing = await latestSettings(tenantId, metal, finenessPpm);
  if (!existing || existing.rateMaxAgeSeconds >= DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS) {
    return;
  }
  const { DigitalMetalSettingsVersion } = await import("../src/models/index.js");
  const { createId } = await import("../src/lib/ids.js");
  await DigitalMetalSettingsVersion.create({
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
  console.log(
    `Bumped ${metal} settings to v${existing.version + 1} (rateMaxAgeSeconds ${existing.rateMaxAgeSeconds} → ${DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS})`,
  );
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

async function main() {
  const forceFresh = process.argv.includes("--refresh-rates");
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: "KAIRALI" });
  if (!tenant) throw new Error("KAIRALI not found");
  const owner =
    (await User.findOne({ tenantId: tenant._id, role: "TENANT_OWNER", status: UserStatus.ACTIVE }).lean()) ??
    (await User.findOne({ tenantId: tenant._id, mobile: "9847012345", status: UserStatus.ACTIVE }).lean());
  if (!owner) throw new Error("KAIRALI owner not found");

  const goldRow = await GoldRate.findOne({ tenantId: tenant._id }).sort({ effectiveDate: -1, createdAt: -1 }).lean();
  const goldPaise = goldRow?.ratePerGramPaise ?? 725_000;
  const silverPaise = Math.max(500, Math.round(goldPaise / 90));

  const { createId } = await import("../src/lib/ids.js");
  const now = new Date();
  for (const asset of DEFAULT_DIGITAL_METAL_ASSETS) {
    await bumpLegacyRateMaxAge(tenant._id, asset.metal, asset.finenessPpm, owner._id);
  }
  for (const asset of DEFAULT_DIGITAL_METAL_ASSETS) {
    const settings = await latestSettings(tenant._id, asset.metal, asset.finenessPpm);
    const maxAge = settings?.rateMaxAgeSeconds ?? DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS;
    const current = await effectiveRate(tenant._id, asset.metal, asset.finenessPpm, now);
    const stale = !current || isRateStale(current, maxAge, now);
    if (!forceFresh && !stale) continue;
    const buy = asset.metal === "GOLD" ? goldPaise : silverPaise;
    const sell = Math.max(1, buy - (asset.metal === "GOLD" ? 500 : 50));
    const lastSeq = await DigitalMetalRateVersion.findOne({
      tenantId: tenant._id,
      metal: asset.metal,
      finenessPpm: asset.finenessPpm,
    })
      .sort({ sequence: -1 })
      .lean();
    await DigitalMetalRateVersion.create({
      _id: createId("dmrv"),
      tenantId: tenant._id,
      metal: asset.metal,
      finenessPpm: asset.finenessPpm,
      customerBuyRatePerGramPaise: buy,
      customerSellRatePerGramPaise: sell,
      effectiveAt: now,
      publishedAt: now,
      sequence: (lastSeq?.sequence ?? 0) + 1,
      source: "KAIRALI_PATCH",
      enteredBy: owner._id,
    });
  }

  const { ensureTerms, syncKairaliDigitalMetalsTenantOps } = await import("./seed-kairali-digital-metals.js");
  const settingsRows = await Promise.all(
    DEFAULT_DIGITAL_METAL_ASSETS.map((a) => latestSettings(tenant._id, a.metal, a.finenessPpm)),
  );
  const taxFingerprint = computeTaxProfileFingerprint(settingsRows);
  const { contentHash } = await ensureTerms(tenant._id);
  await syncKairaliDigitalMetalsTenantOps(tenant._id, { taxFingerprint, contentHash });

  console.log("KAIRALI digital metals live sync complete.", { forceFresh, goldPaise, silverPaise });
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});
