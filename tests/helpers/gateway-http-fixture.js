import {
  PaymentIntentStatus,
  PaymentMode,
  PaymentStatus,
  TenantRole,
} from "../../src/constants/enums.js";
import { createId } from "../../src/lib/ids.js";
import {
  finalizeGatewaySuccess,
  GatewayFinalizeOutcome,
} from "../../src/services/finalize-gateway-success.service.js";
import argon2 from "argon2";
import {
  Payment,
  PaymentIntent,
  Scheme,
  Session,
  Tenant,
  User,
} from "../../src/models/index.js";
import { ROLE_PERMISSIONS } from "../../src/constants/permissions.js";
import { UserStatus, UserType } from "../../src/constants/enums.js";
import { armMockOrderStatusTemplate } from "../../src/lib/phonepe-provider-test-hooks.js";
import { bearerFor, seedBranch, seedCustomer, seedTenantUser } from "./db.js";

export async function configureTenantPhonePe(tenantId) {
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        integrationSecrets: {
          phonepe: {
            clientId: "mock-client",
            clientSecret: "mock-secret",
            environment: "SANDBOX",
            webhookUsername: "wh-user",
            webhookPassword: "wh-pass",
          },
        },
      },
    },
  );
}

export async function seedSuccessfulGatewayPayment({
  amountPaise = 100_000,
  branchId,
  tenantId,
  userId,
  customerId,
  intentSuffix = "__mock_completed__",
} = {}) {
  const schemeId = createId("scheme");
  const intentId = createId("paymentIntent");
  if (intentSuffix) {
    armMockOrderStatusTemplate(intentId, intentSuffix);
  }
  const paymentId = createId("payment");
  await Scheme.create({
    _id: schemeId,
    tenantId,
    branchId,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-GW-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      paymentRules: { partialPaymentAllowed: true, minPaymentPaise: 1000 },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: amountPaise,
    installments: [{
      number: 1,
      dueDate: "2026-01-05",
      amountPaise,
      paidPaise: 0,
      status: "DUE",
      graceEndsAt: "2026-01-10",
    }],
    positionVersion: 1,
    version: 1,
    createdBy: userId,
  });
  await Payment.create({
    _id: paymentId,
    tenantId,
    branchId,
    schemeId,
    customerId,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId,
    branchId,
    paymentId,
    schemeId,
    customerId,
    amountPaise,
    positionVersion: 1,
    status: PaymentIntentStatus.PENDING,
    version: 1,
  });
  const intent = await PaymentIntent.findById(intentId).lean();
  const fin = await finalizeGatewaySuccess({
    tenantId,
    reference: intentId,
    transactionId: `txn_${intentId}`,
    amountPaise,
    providerPayload: {},
    webhookEventId: `wh_${intentId}`,
    intent,
  });
  if (fin.outcome !== GatewayFinalizeOutcome.SUCCESS) {
    throw new Error(`finalize failed: ${fin.outcome}`);
  }
  return { paymentId, intentId, schemeId };
}

export async function seedAdminGatewayContext({ role = TenantRole.TENANT_OWNER } = {}) {
  const seeded = await seedTenantUser({ role });
  await configureTenantPhonePe(seeded.tenant._id);
  const customer = await seedCustomer({
    tenantId: seeded.tenant._id,
    branchId: seeded.branch._id,
  });
  const payment = await seedSuccessfulGatewayPayment({
    tenantId: seeded.tenant._id,
    branchId: seeded.branch._id,
    userId: seeded.user._id,
    customerId: customer._id,
  });
  return { ...seeded, customer, ...payment, token: bearerFor(seeded.user) };
}

export async function seedUserOnTenant({
  tenantId,
  branchId,
  role,
  mobile = "+919666655544",
  name = "Scoped User",
}) {
  const user = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId,
    branchId,
    role,
    name,
    mobile,
    passwordHash: await argon2.hash("1234", { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[role] ?? [],
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    tenantId,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals = { testSessionId: session._id };
  return { user, token: bearerFor(user) };
}

export async function seedBranchManagerContext() {
  const ownerCtx = await seedAdminGatewayContext({ role: TenantRole.TENANT_OWNER });
  const otherBranch = await seedBranch({ tenantId: ownerCtx.tenant._id, code: "BRB", name: "Branch B" });
  const otherCustomer = await seedCustomer({
    tenantId: ownerCtx.tenant._id,
    branchId: otherBranch._id,
    mobile: "+919555544433",
  });
  const otherPayment = await seedSuccessfulGatewayPayment({
    tenantId: ownerCtx.tenant._id,
    branchId: otherBranch._id,
    userId: ownerCtx.user._id,
    customerId: otherCustomer._id,
  });
  const manager = await seedUserOnTenant({
    tenantId: ownerCtx.tenant._id,
    branchId: ownerCtx.branch._id,
    role: TenantRole.BRANCH_MANAGER,
    mobile: "+919777766655",
  });
  return { ownerCtx, otherBranch, otherPayment, manager };
}

export function refundHeaders(idempotencyKey) {
  return {
    "x-idempotency-key": idempotencyKey,
    "content-type": "application/json",
  };
}
