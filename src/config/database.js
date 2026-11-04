import { assertFinancialIndexesReady } from "../lib/financial-index-rollout.js";
import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "./logger.js";

mongoose.set("strictQuery", true);

const isServerless = Boolean(process.env.VERCEL);

let listenersAttached = false;
let connectInFlight = null;
let financialIndexesReady = false;

function attachConnectionListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  mongoose.connection.on("error", (error) => logger.error({ err: error }, "MongoDB connection error"));
  mongoose.connection.on("disconnected", () => { financialIndexesReady = false; logger.warn("MongoDB disconnected"); });
}

export function connectDatabase() {
  if (connectInFlight) return connectInFlight;
  if (mongoose.connection.readyState === 1 && (env.NODE_ENV !== "production" || financialIndexesReady)) return Promise.resolve();
  // All cold-start callers wait for both connection and schema verification.
  connectInFlight = connectAndVerify().finally(() => { connectInFlight = null; });
  return connectInFlight;
}

async function connectAndVerify() {
  attachConnectionListeners();
  if (mongoose.connection.readyState === 2) {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        mongoose.connection.removeListener("connected", connected);
        mongoose.connection.removeListener("error", failed);
      };
      const connected = () => { cleanup(); resolve(); };
      const failed = error => { cleanup(); reject(error); };
      mongoose.connection.once("connected", connected);
      mongoose.connection.once("error", failed);
    });
  }
  const maxPool = isServerless
    ? Math.min(env.MONGODB_MAX_POOL_SIZE, 5)
    : env.MONGODB_MAX_POOL_SIZE;

  if (mongoose.connection.readyState !== 1) await mongoose.connect(env.MONGODB_URI, {
    maxPoolSize: maxPool,
    // Keep pool empty between invocations on Vercel; spin up on demand.
    minPoolSize: isServerless ? 0 : env.NODE_ENV === "production" ? 5 : 0,
    serverSelectionTimeoutMS: isServerless ? 5_000 : 10_000,
    socketTimeoutMS: isServerless ? 20_000 : 45_000,
    maxIdleTimeMS: isServerless ? 10_000 : undefined,
    autoIndex: env.NODE_ENV !== "production",
  });
  if (env.NODE_ENV === "production") {
    try { await assertFinancialIndexesReady(); financialIndexesReady = true; }
    catch (error) { await mongoose.disconnect(); throw error; }
  }
  logger.info({ serverless: isServerless, maxPool }, "MongoDB connected");
}

export async function disconnectDatabase() {
  financialIndexesReady = false;
  await mongoose.disconnect();
}

export const databaseReady = () => mongoose.connection.readyState === 1 && (env.NODE_ENV !== "production" || financialIndexesReady);
