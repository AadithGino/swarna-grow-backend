/** Prefix formula-injection characters for safe CSV export (Excel). */
export function escapeCsvCell(value) {
  if (value == null) return "";
  const text = String(value);
  if (/^[=+\-@]/.test(text)) return `'${text}`;
  return text;
}
