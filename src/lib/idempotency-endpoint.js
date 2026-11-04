const MUTATION_QUERY_KEYS = new Set([
  "refundId",
  "paymentAttemptId",
  "returnRequestId",
  "cancellationRequestId",
]);

/** Canonical idempotency scope: tenant/actor/key are separate; this binds method, route template, resource ids, and mutation query. */
export function buildIdempotencyEndpoint(req) {
  const routeTemplate = req.route?.path ?? req.path;
  const mount = req.baseUrl ?? "";
  const path = `${mount}${routeTemplate}`.replace(/\/{2,}/g, "/");
  const paramKeys = Object.keys(req.params ?? {}).sort();
  const resource =
    paramKeys.length > 0
      ? `{${paramKeys.map((key) => `${key}:${req.params[key]}`).join(",")}}`
      : "";
  const queryKeys = Object.keys(req.query ?? {})
    .filter((key) => MUTATION_QUERY_KEYS.has(key))
    .sort();
  const query =
    queryKeys.length > 0
      ? `?${queryKeys.map((key) => `${key}=${String(req.query[key])}`).join("&")}`
      : "";
  return `${req.method} ${path}${resource}${query}`;
}

export function idempotencyScopedBody(req) {
  const scoped = { ...(req.body ?? {}) };
  for (const key of Object.keys(req.query ?? {}).sort()) {
    if (MUTATION_QUERY_KEYS.has(key)) scoped[`__query_${key}`] = req.query[key];
  }
  return scoped;
}

const METHOD_PATH_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+([^?{]+)/;

/** Legacy records used route.path without mount; normalize for compatibility checks. */
export function normalizeIdempotencyRoutePath(endpoint) {
  const match = endpoint.match(METHOD_PATH_RE);
  if (!match) return endpoint;
  let path = match[2].replace(/\/{2,}/g, "/");
  path = path.replace(/^\/api\/v\d+\/(app|admin|staff|platform)\//i, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  return `${match[1]} ${path}`;
}

export function extractIdempotencyResourceBinding(endpoint) {
  const start = endpoint.indexOf("{");
  if (start === -1) return null;
  const end = endpoint.indexOf("}", start);
  if (end === -1) return null;
  const map = {};
  for (const part of endpoint.slice(start + 1, end).split(",")) {
    const sep = part.indexOf(":");
    if (sep === -1) continue;
    map[part.slice(0, sep)] = part.slice(sep + 1);
  }
  return Object.keys(map).length ? map : null;
}

/** Same idempotency key may replay only when route and bound resource ids align. */
export function idempotencyEndpointsCompatible(storedEndpoint, currentEndpoint) {
  // Fully mounted current routes must retain their API namespace. Legacy
  // unmounted identities retain compatibility with the original route only.
  const mounted = /^(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\/v\d+\/(app|admin|staff|platform)\//i;
  if (mounted.test(storedEndpoint) && mounted.test(currentEndpoint)) {
    const storedPath = storedEndpoint.match(METHOD_PATH_RE)?.[0];
    const currentPath = currentEndpoint.match(METHOD_PATH_RE)?.[0];
    if (storedPath !== currentPath) return false;
  }
  const storedNorm = normalizeIdempotencyRoutePath(storedEndpoint);
  const currentNorm = normalizeIdempotencyRoutePath(currentEndpoint);
  if (storedNorm !== currentNorm) return false;
  const storedResource = extractIdempotencyResourceBinding(storedEndpoint);
  const currentResource = extractIdempotencyResourceBinding(currentEndpoint);
  if (!storedResource && !currentResource) return true;
  if (!storedResource || !currentResource) return false;
  const keys = new Set([...Object.keys(storedResource), ...Object.keys(currentResource)]);
  for (const key of keys) {
    if (storedResource[key] !== currentResource[key]) return false;
  }
  return true;
}
