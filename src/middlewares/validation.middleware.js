import { errors } from "../lib/app-error.js";

export const validate = (schemas) => (req, _res, next) => {
  const details = [];
  for (const [location, schema] of Object.entries(schemas)) {
    const result = schema.safeParse(req[location]);
    if (!result.success) details.push(...result.error.issues.map((issue) => ({ field: [location, ...issue.path].join("."), message: issue.message })));
    else req[location] = result.data;
  }
  return details.length ? next(errors.validation(details)) : next();
};
