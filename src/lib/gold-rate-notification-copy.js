import { moneyRef } from "./money.js";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { env } from "../config/env.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = env.APP_TIMEZONE ?? "Asia/Kolkata";

export const SCHEME_GOLD_RATE_DEEP_LINK = "/gold-rate/current";
export const ECOMMERCE_GOLD_RATE_DEEP_LINK = "/shop";

function formatSchemeEffectiveDate(effectiveDateYmd) {
  const d = dayjs.tz(`${effectiveDateYmd}T12:00:00`, TZ);
  return d.isValid()
    ? d.format("D MMM YYYY")
    : effectiveDateYmd;
}

function formatEcommerceEffectiveAt(iso) {
  const d = dayjs(iso).tz(TZ);
  return d.isValid()
    ? d.format("D MMM YYYY, h:mm A")
    : String(iso);
}

export function suggestSchemeGoldRateNotificationCopy({ ratePerGramPaise, effectiveDateYmd }) {
  const rateDisplay = moneyRef(ratePerGramPaise).amountDisplay;
  const dateLabel = formatSchemeEffectiveDate(effectiveDateYmd);
  return {
    title: "22K scheme gold rate updated",
    body: `Scheme gold rate: ${rateDisplay}/g for 22K gold, effective ${dateLabel}. View your scheme.`,
  };
}

export function suggestEcommerceGoldRateNotificationCopy({ purity, ratePerGramPaise, effectiveAt }) {
  const rateDisplay = moneyRef(ratePerGramPaise).amountDisplay;
  return {
    title: `${purity} shop gold rate updated`,
    body: `Shop gold rate: ${rateDisplay}/g for ${purity} gold. Making charges and applicable taxes are calculated separately.`,
    effectiveLabel: formatEcommerceEffectiveAt(effectiveAt),
  };
}
