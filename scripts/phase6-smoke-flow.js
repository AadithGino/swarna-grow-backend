/**
 * Phase 6 smoke flow against an already-seeded disposable database.
 */
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { TenantRole } from "../src/constants/enums.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Tenant, User } from "../src/models/index.js";
import {
  smokeActualFlexibleLock,
  smokeFixedEnrolAndManual,
  smokeMaturityTransition,
  smokePhonePePersisted,
  smokeRedemptionCashComplete,
  smokeRedemptionGoldHandoverComplete,
  smokeRedemptionPurchaseAdjustmentComplete,
  smokeSystemPolicyCompletion,
  verifyFinalSmokeInvariants,
} from "./lib/phase6-smoke-lifecycle.js";

const app = createApp();

function adminReq(ctx, { body = {}, params = {}, query = {} } = {}) {
  return {
    auth: { id: ctx.user._id, tenantId: ctx.tenant._id, type: "TENANT_USER", role: ctx.user.role },
    tenant: ctx.tenant,
    scope: { tenantId: ctx.tenant._id, branchId: ctx.branch._id },
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "phase6-smoke" },
    ip: "127.0.0.1",
    body,
    params,
    query,
  };
}

async function loadKairaliOwner() {
  const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
  if (!tenant) throw new Error("Demo tenant KAIRALI not found — run seed:demo first.");
  const branch = await mongoose.connection.db.collection("branches").findOne({ tenantId: tenant._id, isHeadOffice: true });
  const user = await User.findOne({ tenantId: tenant._id, role: TenantRole.TENANT_OWNER }).lean();
  if (!branch || !user) throw new Error("KAIRALI owner or HQ branch missing.");
  return { tenant, branch, user };
}

async function ensureTenantPhonePe(ctx) {
  await Tenant.updateOne(
    { _id: ctx.tenant._id },
    {
      $set: {
        "operations.customerAppPaymentsEnabled": true,
        "operations.customerAppWriteEnabled": true,
        integrationSecrets: {
          phonepe: {
            clientId: "P6SMOKE",
            clientSecret: "plain.secret",
            clientVersion: 1,
            webhookUsername: "u",
            webhookPassword: "p",
            environment: "SANDBOX",
          },
        },
      },
    },
  );
}

async function verifyPostSeedInvariants() {
  const db = mongoose.connection.db;
  if (await db.collection("payments").countDocuments({ mode: "CHEQUE" }) > 0) {
    throw new Error("CHEQUE payments present after seed.");
  }
  if (await db.collection("goldrates").countDocuments({ purity: { $ne: "22K" } }) > 0) {
    throw new Error("Non-22K gold rates present.");
  }
  console.log("Seed invariants: no CHEQUE, 22K-only rates.");
}

export async function runPhase6SmokeFlow() {
  await connectDatabase();
  try {
    await verifyPostSeedInvariants();
    const ctx = await loadKairaliOwner();
    ctx.tenantPhonePeReady = () => ensureTenantPhonePe(ctx);
    const fixedScheme = await smokeFixedEnrolAndManual(ctx, adminReq);
    await smokePhonePePersisted(ctx, app, adminReq, fixedScheme);
    await smokeActualFlexibleLock(ctx);
    await smokeSystemPolicyCompletion(ctx);
    await smokeMaturityTransition(ctx);
    await smokeRedemptionCashComplete(ctx);
    await smokeRedemptionGoldHandoverComplete(ctx);
    await smokeRedemptionPurchaseAdjustmentComplete(ctx);
    await verifyFinalSmokeInvariants(ctx);
    console.log("phase6-smoke-flow: ALL LIFECYCLE STEPS PASSED");
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1]?.endsWith("phase6-smoke-flow.js")) {
  runPhase6SmokeFlow().catch((error) => {
    console.error("phase6-smoke-flow FAILED:", error);
    process.exit(1);
  });
}
