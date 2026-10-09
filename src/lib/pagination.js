import { createCursor, cursorQuery, parseCursor } from "./cursor.js";
import { AppError } from "./app-error.js";

export async function paginate(model, { scope = {}, filters = {}, cursor, limit = 20, sort = "createdAt:desc", projection, populate = [] }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const [field, direction = "desc"] = sort.split(":");
  if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(field) || !["asc", "desc"].includes(direction)) throw new AppError("SORT_INVALID", "The requested sort is invalid.", 400);
  const parsed = parseCursor(cursor, { sort, filters });
  const cursorCond = cursorQuery(parsed, field, direction);
  const query = { ...scope, ...filters };
  if (cursorCond.$or) {
    if (query.$or) {
      const filterOr = query.$or;
      delete query.$or;
      const existingAnd = query.$and
        ? (Array.isArray(query.$and) ? query.$and : [query.$and])
        : [];
      query.$and = [...existingAnd, { $or: filterOr }, cursorCond];
    } else {
      Object.assign(query, cursorCond);
    }
  }
  let operation = model.find(query, projection).sort({ [field]: direction === "desc" ? -1 : 1, _id: direction === "desc" ? -1 : 1 }).limit(safeLimit + 1).lean();
  for (const path of populate) operation = operation.populate(path);
  const rows = await operation;
  const hasMore = rows.length > safeLimit;
  const data = hasMore ? rows.slice(0, safeLimit) : rows;
  const last = data.at(-1);
  return { data, meta: { nextCursor: hasMore && last ? createCursor({ lastValue: last[field], lastId: last._id, sort, filters }) : null, hasMore, limit: safeLimit } };
}
