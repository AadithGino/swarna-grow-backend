/** Escape a string for safe RegExp use. */
export const escaped = (value) =>
  String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Build a case-insensitive regex from `q` (empty → null). */
export const searchRegex = (q) => {
  const text = String(q ?? "").trim();
  if (!text) return null;
  return new RegExp(`^${escaped(text)}`, "i");
};

/** Split a search string into tokens (words). */
export function fuzzySearchTokens(q) {
  return String(q ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Fuzzy token → regex: characters may appear in order with gaps (e.g. "vkm" → "Vijay Kumar").
 * Numeric / receipt / enrollment-like tokens use the same subsequence logic on normalized chars.
 */
export function fuzzyTokenRegex(token) {
  const raw = String(token ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/[\s_-]+/g, "");
  if (!normalized) return null;
  if (normalized.length < 2) return null;
  return new RegExp(`^${escaped(normalized)}`, "i");
}

/**
 * Mongo filter: every token must match at least one of `fields` (fuzzy subsequence per token).
 */
export function fuzzyMongoFilter(fields, q) {
  const tokens = fuzzySearchTokens(q);
  if (!tokens.length || !fields?.length) return null;
  const tokenRegexes = tokens.map(fuzzyTokenRegex).filter(Boolean);
  if (!tokenRegexes.length) return null;
  if (tokenRegexes.length === 1) {
    const re = tokenRegexes[0];
    return { $or: fields.map((field) => ({ [field]: re })) };
  }
  return {
    $and: tokenRegexes.map((re) => ({
      $or: fields.map((field) => ({ [field]: re })),
    })),
  };
}

/**
 * Date range on a Date field using IST day bounds.
 * Returns a partial filter object (may be empty).
 */
export const dateMatch = (field, query = {}) => {
  const from = query.from ? new Date(`${query.from}T00:00:00+05:30`) : null;
  const to = query.to ? new Date(`${query.to}T23:59:59.999+05:30`) : null;
  if (!from && !to) return {};
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return { [field]: range };
};

/** Calendar-date (YYYY-MM-DD string) range for scheme due/maturity fields. */
export const calendarDateMatch = (field, query = {}) => {
  const from = query.from ? String(query.from).slice(0, 10) : null;
  const to = query.to ? String(query.to).slice(0, 10) : null;
  if (!from && !to) return {};
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return { [field]: range };
};

function shiftYmd(ymdStr, days) {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Resolve workboard presets into IST calendar from/to (preset wins over manual range). */
export function resolveDatePreset(preset, query = {}) {
  const p = String(preset ?? query.preset ?? "")
    .trim()
    .toUpperCase();
  if (!p || p === "ALL" || p === "CUSTOM") {
    return { from: query.from, to: query.to };
  }
  const now = new Date();
  const ist = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  const ymd = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const startOfWeek = (d) => {
    const copy = new Date(d);
    const day = copy.getDay();
    const diff = day === 0 ? 6 : day - 1;
    copy.setDate(copy.getDate() - diff);
    return copy;
  };
  const today = ymd(ist);
  if (p === "TODAY") return { from: today, to: today };
  if (p === "TOMORROW") {
    const tomorrow = shiftYmd(today, 1);
    return { from: tomorrow, to: tomorrow };
  }
  if (p === "THIS_WEEK") {
    return { from: ymd(startOfWeek(ist)), to: today };
  }
  if (p === "NEXT_7_DAYS") {
    return { from: today, to: shiftYmd(today, 6) };
  }
  if (p === "THIS_MONTH") {
    const from = `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}-01`;
    return { from, to: today };
  }
  if (p === "LAST_MONTH") {
    const firstThis = new Date(ist.getFullYear(), ist.getMonth(), 1);
    const lastPrev = new Date(firstThis);
    lastPrev.setDate(0);
    const firstPrev = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 1);
    return { from: ymd(firstPrev), to: ymd(lastPrev) };
  }
  if (p === "LAST_3_MONTHS") {
    return { from: shiftYmd(today, -89), to: today };
  }
  return { from: query.from, to: query.to };
}

/**
 * Effective list/chart/report range: explicit from+to win; else period/preset.
 */
export function resolveQueryDateRange(query = {}) {
  const from = query.from != null ? String(query.from).trim() : "";
  const to = query.to != null ? String(query.to).trim() : "";
  if (from && to) {
    return { from, to };
  }
  const preset = query.period ?? query.preset ?? "THIS_MONTH";
  return resolveDatePreset(preset, query);
}

/** Maturity list: schemes maturing in range (not only status MATURED). */
export function maturityListFilter(query = {}) {
  const dates = resolveDatePreset(query.preset, query);
  const filter = { ...calendarDateMatch("maturityDate", dates) };
  const state = String(query.maturityState ?? "ALL").toUpperCase();
  const now = new Date();
  const ist = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  const today = `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}-${String(ist.getDate()).padStart(2, "0")}`;

  if (state === "REDEEMED") {
    filter.status = "REDEEMED";
    return filter;
  }
  if (state === "MATURED_PENDING_REDEMPTION" || state === "MATURED") {
    filter.status = "MATURED";
    return filter;
  }
  if (state === "UPCOMING") {
    filter.status = { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] };
    const range = { ...(filter.maturityDate ?? {}), $gt: today };
    filter.maturityDate = range;
    return filter;
  }
  filter.status = { $in: ["ACTIVE", "LOCKED", "DEFAULTED", "MATURED"] };
  return filter;
}

function scopeBranchId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.toUpperCase() === "ALL") return null;
  return normalized;
}

/** Tenant-wide roles may narrow lists via ?branchId=; branch roles stay locked to JWT scope. */
export function effectiveScope(req) {
  const scope = { tenantId: req.scope.tenantId };
  const lockedBranch = scopeBranchId(req.scope.branchId);
  const queryBranch = scopeBranchId(req.query?.branchId);
  if (lockedBranch) {
    scope.branchId = lockedBranch;
  } else if (queryBranch) {
    scope.branchId = queryBranch;
  }
  return scope;
}
