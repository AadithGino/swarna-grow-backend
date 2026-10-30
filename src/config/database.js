import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "./logger.js";

mongoose.set("strictQuery", true);

const isServerless = Boolean(process.env.VERCEL);

let listenersAttached = false;

function attachConnectionListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  mongoose.connection.on("error", (error) => logger.error({ err: error }, "MongoDB connection error"));
  mongoose.connection.on("disconnected", () => logger.warn("MongoDB disconnected"));
}

export async function connectDatabase() {
  const state = mongoose.connection.readyState;
  // 1 = connected, 2 = connecting
  if (state === 1) return;
  if (state === 2) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once("connected", resolve);
      mongoose.connection.once("error", reject);
    });
    return;
  }

  attachConnectionListeners();

  const maxPool = isServerless
    ? Math.min(env.MONGODB_MAX_POOL_SIZE, 5)
    : env.MONGODB_MAX_POOL_SIZE;

  await mongoose.connect(env.MONGODB_URI, {
    maxPoolSize: maxPool,
    // Keep pool empty between invocations on Vercel; spin up on demand.
    minPoolSize: isServerless ? 0 : env.NODE_ENV === "production" ? 5 : 0,
    serverSelectionTimeoutMS: isServerless ? 5_000 : 10_000,
    socketTimeoutMS: isServerless ? 20_000 : 45_000,
    maxIdleTimeMS: isServerless ? 10_000 : undefined,
    autoIndex: env.NODE_ENV !== "production",
  });
  logger.info({ serverless: isServerless, maxPool }, "MongoDB connected");
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

export const databaseReady = () => mongoose.connection.readyState === 1;
