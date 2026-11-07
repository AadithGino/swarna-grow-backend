/**
 * Shared authorization for Vercel cron / manual tick HTTP handlers.
 * Bearer token only (`Authorization: Bearer <secret>`). Query-string secrets are rejected.
 */

/** @param {import("http").IncomingMessage | Record<string, unknown>} req */
export function readCronBearerToken(req) {
  const raw = req.headers?.authorization;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(raw.trim());
  return m ? m[1] : null;
}

function isProductionDeployment() {
  return process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
}

/**
 * @param {import("http").IncomingMessage | Record<string, unknown>} req
 * @param {{ requireSecretAlways?: boolean }} opts
 * - `requireSecretAlways` (queue-tick): nonempty CRON_SECRET + valid Bearer required in every environment.
 * - omit (keep-warm): production requires secret + Bearer; local/dev may omit secret for convenience.
 */
export function assertCronRequestAuthorized(req, opts = {}) {
  const requireSecretAlways = Boolean(opts.requireSecretAlways);
  const secret = process.env.CRON_SECRET?.trim();
  const prod = isProductionDeployment();

  if (!secret) {
    if (requireSecretAlways || prod) {
      return {
        ok: false,
        statusCode: 503,
        body: {
          ok: false,
          code: "CRON_SECRET_NOT_CONFIGURED",
          message: "Cron is not configured (missing CRON_SECRET).",
        },
      };
    }
    return { ok: true, devOpen: true };
  }

  const token = readCronBearerToken(req);
  if (!token || token !== secret) {
    return {
      ok: false,
      statusCode: 401,
      body: {
        ok: false,
        code: "UNAUTHORIZED",
        message: "Unauthorized.",
      },
    };
  }
  return { ok: true };
}

/**
 * @param {import("http").ServerResponse} res
 * @param {number} statusCode
 * @param {Record<string, unknown>} body
 */
export function sendCronJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
