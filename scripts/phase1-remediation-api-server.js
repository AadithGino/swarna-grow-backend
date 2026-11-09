/**
 * Isolated Phase 1 API for browser tests (memory Mongo + test secrets).
 * Usage: NODE_ENV=test node scripts/phase1-remediation-api-server.js
 */
process.env.NODE_ENV = "test";
process.env.PORT = process.env.PORT ?? "4051";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret-32-characters-min!!";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret-32-characters-min!";
process.env.INTEGRATION_ENCRYPTION_KEY =
  process.env.INTEGRATION_ENCRYPTION_KEY ?? "test-integration-key-32-characters!!";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";
process.env.REDIS_REQUIRED = process.env.REDIS_REQUIRED ?? "false";
process.env.PROVIDER_MODE = "mock";
process.env.OTP_PROVIDER = "mock";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.CORS_ORIGINS =
  process.env.CORS_ORIGINS ??
  "http://127.0.0.1:3123,http://localhost:3123,http://127.0.0.1:5173";

const { createServer } = await import("node:http");
const { startTestDb } = await import("../tests/helpers/db.js");
const { seedPhase1BrowserFixture } = await import("../tests/helpers/phase1-remediation-fixture.js");
const { createApp } = await import("../src/app.js");
const { connectRedis } = await import("../src/config/redis.js");

await startTestDb();
const fixture = await seedPhase1BrowserFixture();
const queueAvailable = await connectRedis().catch(() => false);
const app = createApp();
const server = createServer(app);
const port = Number(process.env.PORT);
server.listen(port, () => {
  process.stdout.write(
    JSON.stringify({
      ok: true,
      port,
      apiPrefix: "/api/v1",
      queueAvailable: Boolean(queueAvailable),
      fixtureTenants: [fixture.tenantA.tenantCode, fixture.tenantB.tenantCode],
    }) + "\n",
  );
});

async function shutdown() {
  server.close();
  const { stopTestDb } = await import("../tests/helpers/db.js");
  const { disconnectRedis } = await import("../src/config/redis.js");
  await disconnectRedis().catch(() => {});
  await stopTestDb({ force: true });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
