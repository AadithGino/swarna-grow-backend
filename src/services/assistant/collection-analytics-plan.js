import { PaymentMode } from "../../constants/enums.js";
import { PAYMENT_MODE_LABELS } from "../../constants/enums.js";
import { normalizeAssistantQuestion } from "./normalize-question.js";
import { parseRelativeDateWindow, resolveActionDateBounds } from "./assistant-date-window.js";
const PLANNER_VERSION = "2026-10-24";

/** Modes owners may compare in Sidekick (stored Payment.mode — not channel/instrument collapse). */
export const ANALYTICS_PAYMENT_MODES = Object.freeze([
  PaymentMode.CASH,
  PaymentMode.UPI,
  PaymentMode.CARD,
  PaymentMode.BANK_TRANSFER,
  PaymentMode.ONLINE_GATEWAY,
  PaymentMode.LEGACY_ONLINE,
]);

const MODE_ALIASES = Object.freeze([
  { re: /\bcash\b/i, mode: PaymentMode.CASH },
  { re: /\bupi\b/i, mode: PaymentMode.UPI },
  { re: /\bcard\b|\bpos\b/i, mode: PaymentMode.CARD },
  { re: /\bbank\s*transfer\b|\bneft\b|\brtgs\b/i, mode: PaymentMode.BANK_TRANSFER },
  {
    re: /\bonline\s*gateway\b|\bonline\s*payment\b|\bgateway\b|\bphonepe\b|\bphone\s*pe\b/i,
    mode: PaymentMode.ONLINE_GATEWAY,
  },
  { re: /\blegacy\s*online\b/i, mode: PaymentMode.LEGACY_ONLINE },
]);

function normalizeQuestion(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function defaultCollectionAnalyticsPlan() {
  return {
    operation: "trend",
    metric: "net_collected",
    timeGrain: "day",
    dimensions: ["day"],
    compareModes: null,
    sort: "chronological",
  };
}

/** Parse explicit payment-mode categories from natural language (UPI ≠ ONLINE_GATEWAY). */
export function parseCompareModesFromQuestion(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  const found = new Set();
  for (const { re, mode } of MODE_ALIASES) {
    if (re.test(q)) found.add(mode);
  }
  if (!found.size) return null;
  return [...found];
}

export function wantsModeComparison(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  if (parseCompareModesFromQuestion(question)?.length >= 2) return true;
  if (/\bcompar\w*\b/.test(q) && /\b(cash|upi|card|mode)\b/.test(q)) return true;
  if (/\b(cash|upi)\s+(and|vs|versus|&)\s+(cash|upi|upi|cash)\b/.test(q)) return true;
  if (/\bwise\b/.test(q) && /\b(cash|upi|mode)\b/.test(q)) return true;
  return false;
}

export function wantsOverallTotalsOnly(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  return (
    /\boverall\b/.test(q) ||
    /\btotal only\b/.test(q) ||
    /\bwithout\s+(mode|breakdown)\b/.test(q) ||
    /\bno\s+comparison\b/.test(q)
  );
}

export function wantsDayWiseGrain(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  return (
    /\bday[\s-]?wise\b/.test(q) ||
    /\bdaily\b/.test(q) ||
    /\beach\s+day\b/.test(q) ||
    /\bper\s+day\b/.test(q) ||
    /\bbreak[\s-]?down\b/.test(q)
  );
}

export function isCollectionAnalyticsQuestion(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  return /\b(collect\w*|receipts?|collection)\b/.test(q);
}

export function analyticsFromAction(action) {
  if (!action) return null;
  if (action.kind === "collectionDaily") {
    return action.analytics ?? action.filters?.analytics ?? null;
  }
  if (action.kind === "query" && action.spec?.entity === "collections") {
    const spec = action.spec;
    if (spec.timeBucket === "day" && spec.groupBy === "mode") {
      const modes = (spec.filters ?? [])
        .filter((f) => f.field === "mode" && f.op === "in")
        .flatMap((f) => (Array.isArray(f.value) ? f.value : [f.value]));
      return {
        operation: modes.length >= 2 ? "comparison" : "trend",
        metric: "net_collected",
        timeGrain: "day",
        dimensions: ["day", "mode"],
        compareModes: modes.length ? modes.map(String) : null,
        sort: "chronological",
      };
    }
  }
  return null;
}

export function normalizeCompareModes(modes) {
  if (!modes?.length) return null;
  const out = [];
  for (const raw of modes) {
    const m = String(raw ?? "").trim().toUpperCase();
    if (!m) continue;
    if (m === "DIGITAL" || m === "ONLINE") continue;
    if (ANALYTICS_PAYMENT_MODES.includes(m) && !out.includes(m)) out.push(m);
  }
  return out.length ? out : null;
}

/**
 * Merge prior resolved analytics with follow-up utterance (typed patches).
 */
export function mergeCollectionAnalyticsPlan(priorPlan, question, { todayIst, dateAction } = {}) {
  const base = {
    ...defaultCollectionAnalyticsPlan(),
    ...(priorPlan ?? {}),
  };
  const q = normalizeQuestion(normalizeAssistantQuestion(question));

  if (wantsOverallTotalsOnly(question)) {
    base.dimensions = ["day"];
    base.compareModes = null;
    base.operation = "trend";
  }

  const parsedModes = parseCompareModesFromQuestion(question);
  if (parsedModes?.length) {
    base.compareModes = normalizeCompareModes(parsedModes);
    if (!base.dimensions.includes("mode")) base.dimensions = [...base.dimensions, "mode"];
    base.operation = base.compareModes.length >= 2 ? "comparison" : "trend";
  } else if (/\binclude\b/.test(q) && priorPlan?.compareModes?.length) {
    const extra = parseCompareModesFromQuestion(question);
    if (extra?.length) {
      base.compareModes = normalizeCompareModes([...(priorPlan.compareModes ?? []), ...extra]);
      base.operation = "comparison";
    }
  }

  if (wantsDayWiseGrain(question)) {
    base.timeGrain = "day";
    if (!base.dimensions.includes("day")) base.dimensions = ["day", ...base.dimensions.filter((d) => d !== "day")];
  }

  if (/\bweekly\b/.test(q)) base.timeGrain = "week";
  if (/\bmonthly\b/.test(q)) base.timeGrain = "month";

  const tf = parseRelativeDateWindow(question, todayIst);
  let bounds = tf ?? null;
  if ((!bounds?.from || !bounds?.to) && dateAction) {
    const resolved = resolveActionDateBounds(dateAction, todayIst);
    if (resolved.from && resolved.to) bounds = resolved;
  }

  return { plan: base, bounds: bounds ?? undefined };
}

export function buildCollectionDailyAction({ bounds, analytics, branchId, planId }) {
  const filters = {
    ...(bounds?.from && bounds?.to ? { from: bounds.from, to: bounds.to } : {}),
    ...(bounds?.period ? { period: bounds.period } : {}),
    ...(branchId ? { branchId } : {}),
    ...(planId ? { planId } : {}),
  };
  return {
    kind: "collectionDaily",
    filters,
    analytics: {
      ...defaultCollectionAnalyticsPlan(),
      ...analytics,
      compareModes: normalizeCompareModes(analytics?.compareModes),
    },
    plannerVersion: PLANNER_VERSION,
  };
}

export function modeColumnKey(mode) {
  return String(mode).toLowerCase();
}

export function modeColumnLabel(mode) {
  return PAYMENT_MODE_LABELS[mode] ?? mode;
}

export function assertAnalyticsOutputMatchesPlan(plan, resultMeta) {
  if (!plan?.compareModes?.length) return { ok: true };
  const requested = new Set(plan.compareModes.map(String));
  const rendered = new Set((resultMeta?.compareModes ?? []).map(String));
  for (const mode of requested) {
    if (!rendered.has(mode)) {
      return {
        ok: false,
        reason: `Comparison requested for ${modeColumnLabel(mode)} but that mode was not rendered.`,
      };
    }
  }
  return { ok: true };
}
