/**
 * Number guard: every figure in the agent's written answer must be traceable to a tool
 * result, the turn context, or the owner's own question. Simple sums/differences/
 * percentages of traceable figures are allowed; anything else is treated as invented.
 */

const MULTIPLIERS = [
  { re: /^(crore|crores|cr)\b/i, m: 1e7 },
  { re: /^(lakh|lakhs|lac|lacs|l)\b/i, m: 1e5 },
  { re: /^(k|thousand)\b/i, m: 1e3 },
];

function parseNumber(raw) {
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** All numbers mentioned inside a JSON-ish value (numbers and numbers within strings). */
export function collectNumbers(value, out = new Set(), depth = 0) {
  if (depth > 8 || value == null) return out;
  if (typeof value === "number") {
    if (Number.isFinite(value)) out.add(value);
    return out;
  }
  if (typeof value === "string") {
    for (const m of value.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
      const n = parseNumber(m[0]);
      if (n != null) out.add(Math.abs(n));
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) collectNumbers(v, out, depth + 1);
  }
  return out;
}

/** Figures in the answer that need checking: ₹ amounts, decimals, numbers ≥ 10 (not obvious dates/ordinals). */
export function extractClaims(text) {
  const s = String(text ?? "");
  const claims = [];
  const re = /(₹|rs\.?\s?|inr\s?)?\s?(\d[\d,]*(?:\.\d+)?)\s*(%|percent)?\s*([a-z]+)?/gi;
  for (const m of s.matchAll(re)) {
    const currency = Boolean(m[1]);
    const base = parseNumber(m[2]);
    if (base == null) continue;
    const percent = Boolean(m[3]);
    let value = base;
    const after = (m[4] ?? "").toLowerCase();
    if (!percent) {
      for (const { re: mre, m: mult } of MULTIPLIERS) {
        if (mre.test(after) && (currency || after !== "l")) {
          value = base * mult;
          break;
        }
      }
    }
    const raw = `${m[1] ?? ""}${m[2]}${m[3] ?? ""}`.replace(/\s+/g, "").trim();
    // Skip small bare integers (counts like "3 customers" are checked only if ≥ 10) and year-like tokens.
    if (!currency && !percent && Number.isInteger(base) && base < 10) continue;
    if (!currency && !percent && base >= 1900 && base <= 2100 && Number.isInteger(base)) continue;
    claims.push({ raw, value, currency, percent, approx: value !== base });
  }
  return claims;
}

function close(a, b, rel = 0.005, abs = 1) {
  return Math.abs(a - b) <= Math.max(abs, Math.abs(b) * rel);
}

/**
 * @param {string} text the answer
 * @param {Set<number>} allowed numbers from tool results / context / question
 * @returns {{ ok: boolean, unknown: string[] }}
 */
export function checkAnswerNumbers(text, allowed) {
  const claims = extractClaims(text);
  if (!claims.length) return { ok: true, unknown: [] };
  const list = [...allowed].filter((n) => Number.isFinite(n));
  const pairPool = list.slice(0, 120);
  const unknown = [];
  for (const c of claims) {
    const tolRel = c.approx ? 0.02 : 0.005;
    const v = c.value;
    if (list.some((n) => close(v, n, tolRel))) continue;
    let ok = false;
    if (c.percent) {
      outer: for (const a of pairPool) {
        for (const b of pairPool) {
          if (!b) continue;
          if (close(v, (a / b) * 100, 0.02, 0.6) || close(v, Math.abs((a - b) / b) * 100, 0.02, 0.6)) {
            ok = true;
            break outer;
          }
        }
      }
    } else {
      outer2: for (let i = 0; i < pairPool.length; i += 1) {
        for (let j = 0; j < pairPool.length; j += 1) {
          if (i === j) continue;
          const a = pairPool[i];
          const b = pairPool[j];
          if (close(v, Math.abs(a - b), tolRel) || close(v, a + b, tolRel)) {
            ok = true;
            break outer2;
          }
        }
      }
    }
    if (!ok) unknown.push(c.raw);
  }
  return { ok: unknown.length === 0, unknown };
}
