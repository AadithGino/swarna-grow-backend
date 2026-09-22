/**
 * Parses authenticated platform router mutations for validator registry sync.
 * Keys match `platformRouteValidators` (METHOD + space + path without /api prefix).
 */

const MUTATION_RE =
  /platformRouter\.(post|patch|put|delete)\(\s*"([^"]+)"/g;

export function parseAuthenticatedPlatformMutationKeys(routesSource) {
  const authGate = "platformRouter.use(authenticate";
  const idx = routesSource.indexOf(authGate);
  const scoped = idx >= 0 ? routesSource.slice(idx) : routesSource;
  const keys = new Set();
  const re = new RegExp(MUTATION_RE.source, "g");
  for (let match = re.exec(scoped); match; match = re.exec(scoped)) {
    const method = match[1].toUpperCase();
    const path = match[2].startsWith("/") ? match[2] : `/${match[2]}`;
    keys.add(`${method} ${path}`);
  }
  return [...keys].sort();
}

export function assertPlatformMutationRegistry({ routesSource, validators }) {
  const routes = parseAuthenticatedPlatformMutationKeys(routesSource);
  const validatorKeys = Object.keys(validators).sort();
  const missing = routes.filter((key) => !validators[key]);
  const orphan = validatorKeys.filter((key) => !routes.includes(key));
  if (missing.length || orphan.length) {
    const parts = [];
    if (missing.length) parts.push(`missing validators: ${missing.join(", ")}`);
    if (orphan.length) parts.push(`orphan validators: ${orphan.join(", ")}`);
    throw new Error(parts.join("; "));
  }
  for (const key of routes) {
    const entry = validators[key];
    if (!entry?.body && !entry?.params) {
      throw new Error(`validator entry must define body and/or params for ${key}`);
    }
  }
  return { routeCount: routes.length, routes };
}
