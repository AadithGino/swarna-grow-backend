/** @param {unknown} value @param {{ endOfDay?: boolean }} [opts] */
export function parseAdminOrderListDate(value, { endOfDay = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d;
}
