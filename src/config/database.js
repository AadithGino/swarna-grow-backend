import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "./logger.js";

mongoose.set("strictQuery", true);

export async function connectDatabase() {
  mongoose.connection.on("error", (error) => logger.error({ err: error }, "MongoDB connection error"));
  mongoose.connection.on("disconnected", () => logger.warn("MongoDB disconnected"));
  await mongoose.connect(env.MONGODB_URI, {
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    minPoolSize: env.NODE_ENV === "production" ? 5 : 0,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    autoIndex: env.NODE_ENV !== "production",
  });
  try {
    const { Customer, GoldRate } = await import("../models/index.js");
    await GoldRate.syncIndexes();
    const customerIndexes = await Customer.collection.indexes();
    const passbookIndex = customerIndexes.find((index) => index.name === "tenantId_1_passbookNumber_1");
    if (passbookIndex?.sparse && !passbookIndex.partialFilterExpression) {
      await Customer.collection.dropIndex("tenantId_1_passbookNumber_1");
      logger.warn("Dropped legacy sparse passbook index (null collisions blocked customer signup)");
    }
    await Customer.syncIndexes();
  } catch (error) {
    logger.warn({ err: error }, "Customer/GoldRate index sync skipped");
  }
  logger.info("MongoDB connected");
}

export async function disconnectDatabase() { await mongoose.disconnect(); }
export const databaseReady = () => mongoose.connection.readyState === 1;
