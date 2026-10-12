#!/usr/bin/env node
/**
 * One-command local runner: in-memory Mongo + API (NODE_ENV=test, payment test harness).
 * Refuses Atlas / shared / staging / production Mongo URIs.
 *
 * Usage:
 *   node scripts/run-ecommerce-payment-test-ui.js
 *   node scripts/run-ecommerce-payment-test-ui.js --smoke   # seed + API smoke, then exit
 *   node scripts/run-ecommerce-payment-test-ui.js --port 4001
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { assertIsolatedMongoUri } from "./lib/isolated-mongo-uri.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const DB_NAME = "swarnagrow_ecommerce_pay_ui";
const DEFAULT_PORT = 4001;

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, smoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--smoke") args.smoke = true;
    if (argv[i] === "--port" && argv[i + 1]) {
      args.port = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function baseEnv(port, mongoUri) {
  assertIsolatedMongoUri(mongoUri);
  return {
    NODE_ENV: "test",
    ECOMMERCE_PAYMENTS_TEST_HARNESS: "true",
    PROVIDER_MODE: "mock",
    OTP_PROVIDER: "mock",
    REDIS_REQUIRED: "false",
    RATE_LIMIT_ENABLED: "false",
    PORT: String(port),
    MONGODB_URI: mongoUri,
    CORS_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173",
    JWT_ACCESS_SECRET: "test-jwt-access-secret-min-32-chars!!",
    JWT_REFRESH_SECRET: "test-jwt-refresh-secret-min-32-chars!",
    INTEGRATION_ENCRYPTION_KEY: "test-integration-encryption-key-32",
  };
}

async function waitForHealth(origin, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${origin}/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`API did not become healthy at ${origin}/health`);
}

async function runSmoke({ apiBase, session }) {
  const headers = (token, idem) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-idempotency-key": idem,
  });
  const { createId } = await import("../src/lib/ids.js");
  const token = session.customer.accessToken;
  const branchId = session.branchId;
  const productSlug =
    session.acceptance?.fixedSample?.slug
    ?? session.acceptance?.goldSample?.slug
    ?? session.seedSummary?.tenants?.[0]?.acceptance?.fixedSample?.slug;

  const catalogRes = await fetch(`${apiBase}/app/shop/products?limit=5`, {
    headers: headers(token, createId("smoke")),
  });
  if (!catalogRes.ok) throw new Error(`catalog ${catalogRes.status}`);
  const catalog = await catalogRes.json();
  const productId =
    catalog.data?.items?.[0]?.id
    ?? catalog.data?.items?.find((p) => p.slug === productSlug)?.id;
  if (!productId) throw new Error("No published product for smoke flow");

  let res = await fetch(`${apiBase}/app/shop/cart`, {
    method: "PUT",
    headers: headers(token, createId("cart")),
    body: JSON.stringify({ lines: [{ productId, quantity: 1 }] }),
  });
  if (!res.ok) throw new Error(`cart ${res.status} ${await res.text()}`);

  res = await fetch(`${apiBase}/app/shop/quotes`, {
    method: "POST",
    headers: headers(token, createId("quote")),
    body: JSON.stringify({
      fulfilmentMode: "BRANCH_PICKUP",
      pickupBranchId: branchId,
    }),
  });
  const quoteBody = await res.json();
  if (!res.ok) throw new Error(`quote ${res.status} ${JSON.stringify(quoteBody)}`);
  if (quoteBody.data?.paymentAllowed !== true) {
    throw new Error(`quote paymentAllowed=false blockers=${JSON.stringify(quoteBody.data?.blockers)}`);
  }

  res = await fetch(`${apiBase}/app/shop/orders`, {
    method: "POST",
    headers: headers(token, createId("order")),
    body: JSON.stringify({ quoteId: quoteBody.data.id }),
  });
  const orderBody = await res.json();
  if (!res.ok) throw new Error(`order ${res.status} ${JSON.stringify(orderBody)}`);
  const orderId = orderBody.data.id;

  res = await fetch(`${apiBase}/app/shop/orders/${orderId}/payment-intents`, {
    method: "POST",
    headers: headers(token, createId("pay")),
    body: JSON.stringify({ redirectUrl: "http://127.0.0.1:3000/customer/ecopaytest/shop/orders/" + orderId }),
  });
  if (!res.ok) throw new Error(`payment-intent ${res.status} ${await res.text()}`);

  res = await fetch(`${apiBase}/app/shop/orders/${orderId}/test-harness/complete-payment`, {
    method: "POST",
    headers: headers(token, createId("complete")),
    body: JSON.stringify({ outcome: "COMPLETED" }),
  });
  const completeBody = await res.json();
  if (!res.ok) throw new Error(`harness complete ${res.status} ${JSON.stringify(completeBody)}`);
  if (completeBody.data?.orderStatus !== "PAID") {
    throw new Error(`expected PAID got ${completeBody.data?.orderStatus}`);
  }

  res = await fetch(`${apiBase}/app/shop/orders/${orderId}`, {
    headers: headers(token, createId("get-order")),
  });
  const paidOrder = await res.json();
  if (paidOrder.data?.status !== "PAID" || paidOrder.data?.paymentCompleted !== true) {
    throw new Error(`order not paid after harness: ${JSON.stringify(paidOrder.data?.status)}`);
  }
  console.log("[smoke] OK — quote paymentAllowed=true, harness → PAID, order", orderId);
  return { orderId, productId };
}

function printInstructions({ port, sessionPath, session, mongoProof }) {
  const origin = `http://127.0.0.1:${port}`;
  const apiBase = `${origin}/api/v1`;
  console.log("\n=== Ecommerce payment UI test harness ===\n");
  console.log("Database isolation:", mongoProof);
  console.log("Session file:", sessionPath);
  console.log("\nBackend (already running):");
  console.log(`  API_BASE=${apiBase}`);
  console.log(`  Health: ${origin}/health`);
  console.log("\nTenant Admin .env.local (create or merge):");
  console.log(`  NEXT_PUBLIC_USE_MOCKS=false`);
  console.log(`  NEXT_PUBLIC_API_BASE_URL=${apiBase}`);
  console.log(`  NEXT_PUBLIC_ECOMMERCE_PAYMENT_TEST_UI=true`);
  console.log("\nAdmin login (http://localhost:3000/login):");
  console.log(`  Tenant code: ${session.owner.tenantCode}`);
  console.log(`  Mobile: ${session.owner.mobile}`);
  console.log(`  Password: ${session.owner.password}`);
  console.log("\nCustomer login:");
  console.log(`  http://localhost:3000/customer/${session.tenantSlug}/login`);
  console.log(`  Mobile: ${session.customer.mobile}`);
  console.log(`  OTP: ${session.customer.otp} (NODE_ENV=test mock OTP)`);
  console.log("\nWalkthrough:");
  console.log(`  Shop → cart → quote (paymentAllowed) → order → Pay now → TEST harness complete → PAID`);
  console.log(`  Admin: /ecommerce/orders and fulfilment transition`);
  console.log("\nShutdown: Ctrl+C in this terminal (stops API + in-memory Mongo).\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let replSet;
  let serverProc;
  let sessionPath;

  const shutdown = async (code = 0) => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill("SIGTERM");
      await new Promise((r) => serverProc.once("exit", r));
    }
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
    if (replSet) {
      await replSet.stop({ doCleanup: true, force: true }).catch(() => {});
    }
    if (sessionPath) {
      try { unlinkSync(sessionPath); } catch { /* already removed */ }
    }
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await replSet.waitUntilRunning();
  const mongoUri = replSet.getUri(DB_NAME);
  const mongoProof = assertIsolatedMongoUri(mongoUri);
  console.log("[runner] Isolated Mongo:", mongoProof);

  const childEnv = baseEnv(args.port, mongoUri);
  Object.assign(process.env, childEnv);

  await mongoose.connect(mongoUri);
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

  const { seedEcommercePaymentTestUi } = await import("./lib/ecommerce-payment-test-ui-seed.js");
  const session = await seedEcommercePaymentTestUi();
  await mongoose.disconnect();

  sessionPath = join(repoRoot, "scripts", ".ecommerce-payment-test-ui-session.json");
  mkdirSync(dirname(sessionPath), { recursive: true });
  const sessionDoc = {
    ...session,
    customer: {
      mobile: session.customer.mobile,
      otp: session.customer.otp,
    },
    apiBase: `http://127.0.0.1:${args.port}/api/v1`,
    startedAt: new Date().toISOString(),
    mongo: mongoProof,
  };
  writeFileSync(sessionPath, JSON.stringify(sessionDoc, null, 2), { mode: 0o600 });
  // writeFileSync does not tighten permissions when replacing an older file.
  chmodSync(sessionPath, 0o600);
  process.once("exit", () => {
    try { unlinkSync(sessionPath); } catch { /* already removed */ }
  });

  serverProc = spawn(process.execPath, [join(repoRoot, "src/server.js")], {
    cwd: repoRoot,
    env: { ...process.env, ...childEnv },
    stdio: "inherit",
  });
  serverProc.on("exit", (c) => {
    if (c && c !== 0) console.error("[runner] API exited", c);
  });

  const origin = `http://127.0.0.1:${args.port}`;
  await waitForHealth(origin);

  const fullSession = { ...sessionDoc, customer: session.customer };
  if (args.smoke) {
    await runSmoke({ apiBase: sessionDoc.apiBase, session: fullSession });
    unlinkSync(sessionPath);
    sessionPath = undefined;
    await shutdown(0);
    return;
  }

  printInstructions({
    port: args.port,
    sessionPath,
    session: sessionDoc,
    mongoProof: `${mongoProof.host}/${mongoProof.dbName} (in-memory replset, not Atlas)`,
  });

  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
