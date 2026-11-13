import express from "express";
import compression from "compression";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { apiRouter } from "./routes/index.js";
import { webhookRouter } from "./routes/webhook.routes.js";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware.js";
import { traceMiddleware } from "./middlewares/trace.middleware.js";
import { sendSuccess } from "./lib/response.js";
import { getReadinessState } from "./lib/readiness.js";
import { mockStorageRouter } from "./routes/mock-storage.routes.js";

export function createApp() {
  const app = express(); app.disable("x-powered-by"); app.disable("etag"); app.set("trust proxy", env.TRUST_PROXY);
  // 410 responses are heuristically cacheable. A rotated demo session was being replayed from the browser disk cache.
  app.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  app.use(traceMiddleware); app.use(pinoHttp({ logger, genReqId: (req) => req.traceId })); app.use(helmet()); app.use(cors({ origin(origin, callback) { if (!origin || env.corsOrigins.includes(origin)) return callback(null, true); callback(new Error("CORS origin denied")); }, credentials: true, maxAge: 86400 })); app.use(compression());
  app.get("/health", (_req, res) => sendSuccess(res, { status: "ok", timestamp: new Date().toISOString() }));
  app.get("/health/ready", async (_req, res) => {
    const { ready, data } = await getReadinessState();
    res.status(ready ? 200 : 503).json({ success: ready, data });
  });
  const webhookBodyLimit = `${env.WEBHOOK_MAX_BODY_BYTES}b`;
  app.use(`${env.API_PREFIX}/webhooks`, express.raw({ type: "application/json", limit: webhookBodyLimit }), (req, _res, next) => { req.rawBody = Buffer.from(req.body); next(); }, webhookRouter);
  app.use(
    "/mock-storage",
    express.raw({ type: () => true, limit: "10mb" }),
    mockStorageRouter,
  );
  // Demo logo content PUT is a raw binary body (presign → PUT → complete).
  app.put(
    `${env.API_PREFIX}/platform/demo/uploads/:uploadId/content`,
    express.raw({ type: () => true, limit: "3mb" }),
    (_req, _res, next) => next(),
  );
  app.use(express.json({ limit: "1mb" })); app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use(env.API_PREFIX, apiRouter); app.use(notFoundHandler); app.use(errorHandler); return app;
}
