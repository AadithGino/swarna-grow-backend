/** Parse JWT-style duration strings (e.g. `30m`, `1h`) to seconds. */
export function ttlToSeconds(ttl) {
  if (typeof ttl === "number" && Number.isFinite(ttl)) return Math.max(0, Math.floor(ttl));
  const raw = String(ttl ?? "30m").trim();
  const match = /^(\d+)([smhd])$/i.exec(raw);
  if (!match) return 1800;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 60;
  return n * mult;
}
