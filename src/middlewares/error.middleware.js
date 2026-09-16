import { ZodError } from "zod";
import { AppError } from "../lib/app-error.js";
import { logger } from "../config/logger.js";
import { databaseReady } from "../config/database.js";
import { ErrorLog } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { env } from "../config/env.js";
import { appErrorFromDuplicateKey } from "../lib/mongo-duplicate.js";

export function notFoundHandler(req, _res, next) { next(new AppError("ROUTE_NOT_FOUND", `No API route matches ${req.method} ${req.originalUrl}.`, 404)); }
export function errorHandler(error, req, res, _next) {
  let normalized = error;
  if (error instanceof ZodError) normalized = new AppError("VALIDATION_FAILED", "Please correct the highlighted fields.", 400, error.issues);
  else if (error instanceof SyntaxError && error.status === 400 && "body" in error) normalized = new AppError("INVALID_JSON", "The request body is not valid JSON.", 400);
  else if (error?.name === "ValidationError") normalized = new AppError("VALIDATION_FAILED", "Please correct the highlighted fields.", 400, Object.values(error.errors).map((item) => ({ field: item.path, message: item.message })));
  else if (error?.name === "CastError") normalized = new AppError("RESOURCE_NOT_FOUND", "The requested resource was not found.", 404);
  else if (error?.code === 11000) normalized = appErrorFromDuplicateKey(error);
  if (!(normalized instanceof AppError)) { logger.error({ err: error, traceId: req.traceId }, "Unhandled request error"); normalized = new AppError("INTERNAL_ERROR", "Something went wrong. Please try again.", 500); }
  else if (normalized.statusCode >= 500) logger.error({ err: error, traceId: req.traceId }, "Request failed");
  if (normalized.statusCode >= 500 && databaseReady()) void ErrorLog.create({ _id: createId("error"), tenantId: req.auth?.tenantId ?? null, actorId: req.auth?.id, method: req.method, path: req.originalUrl, code: normalized.code, message: error.message, statusCode: normalized.statusCode, traceId: req.traceId, stack: env.NODE_ENV === "production" ? undefined : error.stack }).catch((writeError) => logger.error({ err: writeError }, "Failed to persist error log"));
  let details = normalized.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const rows = [];
    if (details.mobile != null && details.mobile !== "") {
      rows.push({
        field: "body.mobile",
        message:
          "This mobile number is already registered for a customer in this jewellery.",
      });
    }
    if (details.email != null && details.email !== "") {
      rows.push({
        field: "body.email",
        message:
          "This email is already registered for a customer in this jewellery.",
      });
    }
    details = rows.length ? rows : undefined;
  }
  res.status(normalized.statusCode).json({
    success: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(details ? { details } : {}),
      traceId: req.traceId,
    },
  });
}
