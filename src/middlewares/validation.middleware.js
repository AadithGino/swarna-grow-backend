import { errors } from "../lib/app-error.js";

/**
 * Vercel rewrites like `/api/v1/:path* → /api` inject the capture as `query.path`.
 * Strict Zod query schemas then return VALIDATION_FAILED. Strip before parse.
 */
const VERCEL_REWRITE_QUERY_KEYS = new Set(["path"]);

function queryForValidation(query) {
  if (!query || typeof query !== "object") return query;
  let cleaned = null;
  for (const key of VERCEL_REWRITE_QUERY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(query, key)) continue;
    if (!cleaned) cleaned = { ...query };
    delete cleaned[key];
  }
  return cleaned ?? query;
}

/** Express 5 exposes read-only `req.query`; merge parsed fields instead of replacing. */
function applyParsed(req, location, data) {
  if (location === "query" || location === "params") {
    const target = req[location];
    if (target && typeof target === "object") {
      for (const key of Object.keys(data)) {
        target[key] = data[key];
      }
      return;
    }
  }
  req[location] = data;
}

export const validate = (schemas) => (req, _res, next) => {
  const details = [];
  for (const [location, schema] of Object.entries(schemas)) {
    const input = location === "query" ? queryForValidation(req[location]) : req[location];
    const result = schema.safeParse(input);
    if (!result.success) details.push(...result.error.issues.map((issue) => ({ field: [location, ...issue.path].join("."), message: issue.message })));
    else applyParsed(req, location, result.data);
  }
  return details.length ? next(errors.validation(details)) : next();
};
