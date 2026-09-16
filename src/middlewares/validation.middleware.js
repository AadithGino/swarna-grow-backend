import { errors } from "../lib/app-error.js";

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
    const result = schema.safeParse(req[location]);
    if (!result.success) details.push(...result.error.issues.map((issue) => ({ field: [location, ...issue.path].join("."), message: issue.message })));
    else applyParsed(req, location, result.data);
  }
  return details.length ? next(errors.validation(details)) : next();
};
