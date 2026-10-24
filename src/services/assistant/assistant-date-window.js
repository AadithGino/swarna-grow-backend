import { resolveDatePreset } from "../../lib/query-filters.js";

export const ASSISTANT_TIMEZONE = "Asia/Kolkata";

/** Inclusive calendar-day shift on YYYY-MM-DD (UTC date math). */
export function shiftYmd(ymdStr, days) {
  const [y, m, d] = String(ymdStr ?? "").split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Inclusive rolling window: last N calendar days ending todayIst (day 1 = today).
 * last 30 @ 2026-10-24 → 2026-09-25 … 2026-10-24
 */
export function resolveInclusiveRollingDays(n, todayIst) {
  const count = Number(n);
  const today = String(todayIst ?? "").trim();
  if (!today || !Number.isFinite(count) || count < 1 || count > 366) return null;
  if (count === 365) return { period: "LAST_365_DAYS" };
  return { from: shiftYmd(today, -(count - 1)), to: today };
}

/**
 * Parse relative date intent from natural language (IST calendar policy).
 * @returns {{ period?: string, from?: string, to?: string } | null}
 */
export function parseRelativeDateWindow(text, todayIst) {
  const raw = String(text ?? "").trim();
  const t = raw.toLowerCase();
  const today = String(todayIst ?? "").trim();
  if (!t || !today) return null;

  if (/\blast\s+365\s+days?\b/.test(t) || /\bpast\s+365\s+days?\b/.test(t)) {
    return { period: "LAST_365_DAYS" };
  }
  if (/\bthis\s+month\b/.test(t)) return { period: "THIS_MONTH" };
  if (/\blast\s+month\b/.test(t) && !/\blast\s+monthly\b/.test(t)) return { period: "LAST_MONTH" };
  if (/\bthis\s+week\b/.test(t)) return { period: "THIS_WEEK" };
  if (/\bthis\s+year\b/.test(t)) return { period: "THIS_YEAR" };
  if (/\blast\s+(three|3)\s+months?\b/.test(t)) return { period: "LAST_3_MONTHS" };

  const rolling = t.match(/(?:^|\b)(?:in\s+)?(?:the\s+)?(?:last|past)\s+(\d{1,3})\s+days?\b/);
  if (rolling) {
    return resolveInclusiveRollingDays(Number(rolling[1]), today);
  }
  return null;
}

/** Resolve action/report filters to concrete from/to using presets when needed. */
export function resolveActionDateBounds(action, todayIst) {
  if (!action || typeof action !== "object") return { from: undefined, to: undefined, period: undefined };
  const bag =
    action.kind === "report"
      ? action.filters ?? {}
      : action.kind === "query"
        ? action.spec ?? {}
        : action.kind === "collectionDaily"
          ? action.filters ?? {}
          : {};
  const from = bag.from ? String(bag.from).slice(0, 10) : undefined;
  const to = bag.to ? String(bag.to).slice(0, 10) : undefined;
  if (from && to) return { from, to, period: undefined };
  const period = bag.period ? String(bag.period).trim() : undefined;
  if (period) {
    const resolved = resolveDatePreset(period, { from, to });
    return {
      from: resolved.from ? String(resolved.from).slice(0, 10) : undefined,
      to: resolved.to ? String(resolved.to).slice(0, 10) : undefined,
      period,
    };
  }
  return { from, to, period: undefined };
}

export function formatAppliedDateLabel(from, to) {
  if (!from || !to) return undefined;
  return from === to ? from : `${from} – ${to}`;
}
