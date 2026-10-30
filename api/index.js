/**
 * Vercel serverless entry — HTTP API only (no worker/scheduler/dispatcher).
 * Long-lived processes remain on Railway/Render/Fly or a VPS.
 */
import { createApp } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { connectRedis } from "../src/config/redis.js";
import { assertOtpProviderReady } from "../src/integrations/otp.provider.js";

const g = globalThis;

async function boot() {
  assertOtpProviderReady();
  // Parallelize Mongo + Redis so a slow Redis cannot serialize cold start.
  await Promise.all([connectDatabase(), connectRedis().catch(() => false)]);
  return createApp();
}

function getApp() {
  // Persist across warm invocations in the same Vercel isolate.
  if (!g.__swarnaBootPromise) {
    g.__swarnaBootPromise = boot().catch((err) => {
      g.__swarnaBootPromise = undefined;
      throw err;
    });
  }
  return g.__swarnaBootPromise;
}

export default async function handler(req, res) {
  const expressApp = await getApp();
  expressApp(req, res);
}
