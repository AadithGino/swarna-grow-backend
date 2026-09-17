import { connectRedis, disconnectRedis } from "../config/redis.js";
import { getQueue, closeQueues } from "../queues/index.js";
import { logger } from "../config/logger.js";

if (!(await connectRedis())) throw new Error("Redis is required for the scheduler");
const maintenance = getQueue("maintenance");
await Promise.all([
  maintenance.upsertJobScheduler("maturity-daily", { pattern: "5 0 * * *", tz: "Asia/Kolkata" }, { name: "maturity", data: {} }),
  maintenance.upsertJobScheduler("overdue-daily", { pattern: "10 0 * * *", tz: "Asia/Kolkata" }, { name: "overdue", data: {} }),
  maintenance.upsertJobScheduler("payment-reminders-daily", { pattern: "30 9 * * *", tz: "Asia/Kolkata" }, { name: "payment-reminders", data: {} }),
  maintenance.upsertJobScheduler("expire-flexible-capacity", { pattern: "15 0 * * *", tz: "Asia/Kolkata" }, { name: "expire-flexible-capacity", data: {} }),
  maintenance.upsertJobScheduler("defaulting-daily", { pattern: "20 0 * * *", tz: "Asia/Kolkata" }, { name: "defaulting", data: {} }),
  maintenance.upsertJobScheduler("apply-flexible-locks-daily", { pattern: "25 0 * * *", tz: "Asia/Kolkata" }, { name: "apply-flexible-locks", data: {} }),
  maintenance.upsertJobScheduler("grievance-close-hourly", { pattern: "0 * * * *", tz: "Asia/Kolkata" }, { name: "grievance-auto-close", data: {} }),
  maintenance.upsertJobScheduler("expire-payments", { every: 60_000 }, { name: "expire-payments", data: {} }),
]);
logger.info("Schedulers registered"); await closeQueues(); await disconnectRedis();
