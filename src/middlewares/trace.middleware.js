import crypto from "node:crypto";
export function traceMiddleware(req, res, next) { req.traceId = req.headers["x-trace-id"] || crypto.randomUUID(); res.setHeader("X-Trace-Id", req.traceId); next(); }
