import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { connectRedis, disconnectRedis } from "./config/redis.js";
import { closeQueues } from "./queues/index.js";
import { startDispatcher, stopDispatcher } from "./queues/dispatcher.js";

await connectDatabase(); const queueAvailable = await connectRedis(); if (queueAvailable) startDispatcher();
const server = createServer(createApp()); server.keepAliveTimeout = 65_000; server.headersTimeout = 66_000; server.requestTimeout = 30_000;
server.listen(env.PORT, () => logger.info({ port: env.PORT, apiPrefix: env.API_PREFIX, queueAvailable }, "SwarnaGrow API listening"));
let shuttingDown = false;
async function shutdown(signal) { if (shuttingDown) return; shuttingDown = true; logger.info({ signal }, "Graceful shutdown started"); stopDispatcher(); server.close(async () => { await closeQueues(); await disconnectRedis(); await disconnectDatabase(); logger.info("Graceful shutdown complete"); process.exit(0); }); setTimeout(() => process.exit(1), 20_000).unref(); }
process.on("SIGTERM", () => void shutdown("SIGTERM")); process.on("SIGINT", () => void shutdown("SIGINT")); process.on("unhandledRejection", (reason) => logger.fatal({ err: reason }, "Unhandled promise rejection")); process.on("uncaughtException", (error) => { logger.fatal({ err: error }, "Uncaught exception"); void shutdown("uncaughtException"); });
