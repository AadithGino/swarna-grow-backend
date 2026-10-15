import { EcommerceGoldRate, GoldRate } from "../models/index.js";
import { goldRateForExactDate } from "./gold-rate-lookup.js";
import { isEcommerceOperational } from "./ecommerce-access.js";
import { today } from "./date.js";

export async function resolveApplicableSchemeGoldRateId({
  tenantId,
  branchId,
  effectiveDateYmd,
}) {
  const row = await goldRateForExactDate(
    { tenantId, branchId: branchId ?? null },
    effectiveDateYmd,
  );
  return row?._id ?? null;
}

export async function latestApplicableEcommerceGoldRateId(tenantId, purity, at = new Date()) {
  const row = await EcommerceGoldRate.findOne({
    tenantId,
    purity,
    effectiveAt: { $lte: at },
  })
    .sort({ effectiveAt: -1, createdAt: -1 })
    .lean();
  return row?._id ?? null;
}

export async function revalidateSchemeGoldRateNotification(campaign, _tenant) {
  const ymdHint = String(campaign.schemeEffectiveDate ?? "").slice(0, 10);
  if (ymdHint) {
    const businessToday = today();
    if (ymdHint > businessToday) {
      return { ok: false, reason: "NOT_DUE" };
    }
    if (ymdHint < businessToday) {
      return { ok: false, reason: "STALE_BUSINESS_DATE" };
    }
  }
  const rate = await GoldRate.findOne({
    _id: campaign.rateId,
    tenantId: campaign.tenantId,
  }).lean();
  if (!rate) return { ok: false, reason: "RATE_MISSING" };
  const ymd = String(campaign.schemeEffectiveDate ?? rate.effectiveDate).slice(0, 10);
  const businessToday = today();
  if (ymd > businessToday) {
    return { ok: false, reason: "NOT_DUE" };
  }
  if (ymd < businessToday) {
    return { ok: false, reason: "STALE_BUSINESS_DATE" };
  }
  const applicable = await resolveApplicableSchemeGoldRateId({
    tenantId: campaign.tenantId,
    branchId: rate.branchId ?? null,
    effectiveDateYmd: ymd,
  });
  if (applicable !== rate._id) {
    return { ok: false, reason: "RATE_SUPERSEDED" };
  }
  return { ok: true, rate };
}

export async function revalidateEcommerceGoldRateNotification(campaign, tenant) {
  if (!isEcommerceOperational(tenant)) {
    return { ok: false, reason: "STORE_INACTIVE" };
  }
  const rate = await EcommerceGoldRate.findOne({
    _id: campaign.rateId,
    tenantId: campaign.tenantId,
  }).lean();
  if (!rate) return { ok: false, reason: "RATE_MISSING" };
  const applicable = await latestApplicableEcommerceGoldRateId(
    campaign.tenantId,
    rate.purity,
    new Date(),
  );
  if (applicable !== rate._id) {
    return { ok: false, reason: "RATE_SUPERSEDED" };
  }
  return { ok: true, rate };
}
