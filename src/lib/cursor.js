import crypto from "node:crypto";
import { AppError } from "./app-error.js";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
const stable = (value) => { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof RegExp)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); };
export const filterHash = (filters) => crypto.createHash("sha256").update(stable(filters)).digest("hex").slice(0, 16);
export const createCursor = ({ lastValue, lastId, sort, filters }) => encode({ lastValue, lastId, sort, filterHash: filterHash(filters) });
export function parseCursor(cursor, { sort, filters }) {
  if (!cursor) return null;
  try { const parsed = decode(cursor); if (parsed.sort !== sort || parsed.filterHash !== filterHash(filters)) throw new AppError("CURSOR_FILTER_MISMATCH", "The cursor does not match the current filters.", 400); return parsed; }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError("INVALID_CURSOR", "The pagination cursor is invalid.", 400); }
}
export function cursorQuery(parsed, field, direction = "desc") {
  if (!parsed) return {};
  const operator = direction === "desc" ? "$lt" : "$gt";
  return { $or: [{ [field]: { [operator]: parsed.lastValue } }, { [field]: parsed.lastValue, _id: { [operator]: parsed.lastId } }] };
}
