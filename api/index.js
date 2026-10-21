/**
 * Vercel serverless entry — HTTP API only (no worker/scheduler/dispatcher).
 * Long-lived processes remain on Railway/Render/Fly or a VPS.
 */
import { createApp } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { connectRedis } from "../src/config/redis.js";
import { assertOtpProviderReady } from "../src/integrations/otp.provider.js";

let app;
let bootPromise;

async function boot() {
  assertOtpProviderReady();
  await connectDatabase();
  await connectRedis().catch(() => false);
  app = createApp();
  return app;
}

function getApp() {
  if (!bootPromise) bootPromise = boot();
  return bootPromise;
}

export default async function handler(req, res) {
  const expressApp = await getApp();
  expressApp(req, res);
}
