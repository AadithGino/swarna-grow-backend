import { buildSchemeMaturityProjection } from "../lib/maturity-projection.js";
import { getScheme } from "./scheme.service.js";

export async function maturityProjectionForScheme(req) {
  const scheme = await getScheme(req);
  return buildSchemeMaturityProjection(scheme);
}
