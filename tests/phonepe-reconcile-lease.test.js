import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { PaymentMode, PaymentStatus } from "../src/constants/enums.js";
import {
  armPauseBeforeExhaustionTransition,
  armPauseBeforeReconcileCore,
  armPauseDuringReconcileProgress,
  clearReconcileTestHooks,
} from "../src/lib/phonepe-reconcile-test-hooks.js";
import { Alert, Payment } from "../src/models/index.js";
import {
  claimPaymentForReconcile,
  clearReconcileLease,
  reconcileGatewayPayment,
} from "../src/services/phonepe-reconcile.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { createId } from "../src/lib/ids.js";
import { Customer, PaymentIntent, Scheme } from "../src/models/index.js";
import { PaymentIntentStatus } from "../src/constants/enums.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearReconcileTestHooks();
});

async function seedPendingForLease() {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Lease",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      paymentRules: {
        partialPaymentAllowed: true,
        advancePaymentAllowed: false,
        maxAdvanceInstallments: 0,
        minPaymentPaise: 1000,
      },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 50_000,
    installments: [{
      number: 1,
      dueDate: "2026-01-05",
      amountPaise: 50_000,
      paidPaise: 0,
      status: "DUE",
      graceEndsAt: "2026-01-10",
    }],
    positionVersion: 1,
    version: 1,
    createdBy: user._id,
  });
  const intentId = createId("paymentIntent");
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise: 50_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(Date.now() - 3600_000),
    gatewayReconcileAttempts: 0,
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    amountPaise: 50_000,
    positionVersion: 1,
    status: PaymentIntentStatus.PENDING,
    paymentId,
    version: 1,
  });
  return { tenant, paymentId };
}

test("stale owner cannot clear lease, mutate progress, or exhaust after ownership loss", async () => {
  const { tenant, paymentId } = await seedPendingForLease();
  const claimedA = await claimPaymentForReconcile({
    paymentId,
    tenantId: tenant._id,
    workerLabel: "worker_a_lease_test",
    now: new Date(),
  });
  const tokenA = claimedA.gatewayReconcileLeaseOwner;
  const pause = armPauseDuringReconcileProgress();
  const reconcileA = reconcileGatewayPayment(claimedA);
  await pause.waitUntilPaused();

  await Payment.updateOne(
    { _id: paymentId, tenantId: tenant._id, gatewayReconcileLeaseOwner: tokenA },
    {
      $unset: {
        gatewayReconcileLeaseOwner: "",
        gatewayReconcileLeaseExpiresAt: "",
      },
    },
  );
  const claimedB = await claimPaymentForReconcile({
    paymentId,
    tenantId: tenant._id,
    workerLabel: "worker_b_lease_test",
    now: new Date(),
  });
  assert.ok(claimedB);
  const tokenB = claimedB.gatewayReconcileLeaseOwner;

  const attemptsBefore = (await Payment.findById(paymentId).lean()).gatewayReconcileAttempts ?? 0;
  pause.resume();
  const outcomeA = await reconcileA;
  pause.disarm();

  assert.equal(outcomeA.outcome, "LEASE_LOST");
  const mid = await Payment.findById(paymentId).lean();
  assert.equal(mid.gatewayReconcileLeaseOwner, tokenB);
  assert.equal(mid.gatewayReconcileAttempts, attemptsBefore);
  assert.equal(await clearReconcileLease(paymentId, tenant._id, tokenA), 0);
  assert.equal(await Alert.countDocuments({ tenantId: tenant._id, type: "GATEWAY_RECONCILE_EXHAUSTED" }), 0);

  const outcomeB = await reconcileGatewayPayment(claimedB);
  assert.equal(outcomeB.outcome, "STILL_PENDING");
  const afterB = await Payment.findById(paymentId).lean();
  assert.equal(afterB.gatewayReconcileLeaseOwner, undefined);
  assert.equal(afterB.gatewayReconcileAttempts, attemptsBefore + 1);
  assert.equal(await clearReconcileLease(paymentId, tenant._id, tokenB), 0);
});

test("same scheduler label yields distinct fencing tokens and stale worker cannot interfere", async () => {
  const { tenant, paymentId } = await seedPendingForLease();
  const schedulerLabel = "scheduler";
  const claimedA = await claimPaymentForReconcile({
    paymentId,
    tenantId: tenant._id,
    workerLabel: schedulerLabel,
    now: new Date(),
  });
  const tokenA = claimedA.gatewayReconcileLeaseOwner;
  const pause = armPauseDuringReconcileProgress();
  const reconcileA = reconcileGatewayPayment(claimedA);
  await pause.waitUntilPaused();

  await Payment.updateOne(
    { _id: paymentId, tenantId: tenant._id, gatewayReconcileLeaseOwner: tokenA },
    {
      $unset: {
        gatewayReconcileLeaseOwner: "",
        gatewayReconcileLeaseExpiresAt: "",
      },
    },
  );
  const claimedB = await claimPaymentForReconcile({
    paymentId,
    tenantId: tenant._id,
    workerLabel: schedulerLabel,
    now: new Date(),
  });
  const tokenB = claimedB.gatewayReconcileLeaseOwner;
  assert.notEqual(tokenA, tokenB);
  assert.match(tokenA, new RegExp(`^${schedulerLabel}_${paymentId}_`));
  assert.match(tokenB, new RegExp(`^${schedulerLabel}_${paymentId}_`));

  const attemptsBefore = (await Payment.findById(paymentId).lean()).gatewayReconcileAttempts ?? 0;
  pause.resume();
  const outcomeA = await reconcileA;
  pause.disarm();
  assert.equal(outcomeA.outcome, "LEASE_LOST");
  assert.equal(await clearReconcileLease(paymentId, tenant._id, tokenA), 0);

  const mid = await Payment.findById(paymentId).lean();
  assert.equal(mid.gatewayReconcileLeaseOwner, tokenB);
  assert.equal(mid.gatewayReconcileAttempts, attemptsBefore);

  const outcomeB = await reconcileGatewayPayment(claimedB);
  assert.equal(outcomeB.outcome, "STILL_PENDING");
  assert.equal((await Payment.findById(paymentId).lean()).gatewayReconcileLeaseOwner, undefined);
  assert.equal(await clearReconcileLease(paymentId, tenant._id, tokenB), 0);
});

test("worker B recovers exact threshold exhaustion without extra increment or provider call", async () => {
  const maxAttempts = env.PHONEPE_RECONCILE_MAX_ATTEMPTS ?? 5;
  const { tenant, paymentId } = await seedPendingForLease();
  await Payment.updateOne(
    { _id: paymentId, tenantId: tenant._id },
    { $set: { gatewayReconcileAttempts: maxAttempts - 1 } },
  );

  const originalGetOrderStatus = phonePeProvider.getOrderStatus.bind(phonePeProvider);
  let providerCalls = 0;
  phonePeProvider.getOrderStatus = async (...args) => {
    providerCalls += 1;
    return originalGetOrderStatus(...args);
  };

  try {
    const claimedA = await claimPaymentForReconcile({
      paymentId,
      tenantId: tenant._id,
      workerLabel: "scheduler",
      now: new Date(),
    });
    const tokenA = claimedA.gatewayReconcileLeaseOwner;
    const pause = armPauseBeforeExhaustionTransition();
    const reconcileA = reconcileGatewayPayment(claimedA);
    await pause.waitUntilPaused();

    await Payment.updateOne(
      { _id: paymentId, tenantId: tenant._id, gatewayReconcileLeaseOwner: tokenA },
      {
        $unset: {
          gatewayReconcileLeaseOwner: "",
          gatewayReconcileLeaseExpiresAt: "",
        },
      },
    );
    const claimedB = await claimPaymentForReconcile({
      paymentId,
      tenantId: tenant._id,
      workerLabel: "scheduler",
      now: new Date(),
    });
    assert.ok(claimedB);
    const tokenB = claimedB.gatewayReconcileLeaseOwner;

    pause.resume();
    await reconcileA;
    pause.disarm();

    const afterA = await Payment.findById(paymentId).lean();
    assert.equal(afterA.gatewayReconcileAttempts, maxAttempts);
    assert.notEqual(afterA.reviewReason, "GATEWAY_RECONCILE_EXHAUSTED");
    assert.equal(providerCalls, 1);

    const callsBeforeB = providerCalls;
    const outcomeB = await reconcileGatewayPayment(claimedB);
    assert.equal(outcomeB.outcome, "RECONCILE_EXHAUSTED");
    assert.equal(providerCalls, callsBeforeB);

    const afterB = await Payment.findById(paymentId).lean();
    assert.equal(afterB.gatewayReconcileAttempts, maxAttempts);
    assert.equal(afterB.reviewReason, "GATEWAY_RECONCILE_EXHAUSTED");
    assert.equal(await Alert.countDocuments({ tenantId: tenant._id, type: "GATEWAY_RECONCILE_EXHAUSTED", entityId: paymentId }), 1);
    assert.equal((await Payment.findById(paymentId).lean()).gatewayReconcileLeaseOwner, undefined);
    assert.equal(await clearReconcileLease(paymentId, tenant._id, tokenB), 0);
  } finally {
    phonePeProvider.getOrderStatus = originalGetOrderStatus;
  }
});

test("core refetch never adopts another lease owner before provider work", async () => {
  const { tenant, paymentId } = await seedPendingForLease();
  const originalGetOrderStatus = phonePeProvider.getOrderStatus.bind(phonePeProvider);
  let providerCalls = 0;
  phonePeProvider.getOrderStatus = async (...args) => {
    providerCalls += 1;
    return originalGetOrderStatus(...args);
  };

  try {
    const claimedA = await claimPaymentForReconcile({
      paymentId,
      tenantId: tenant._id,
      workerLabel: "worker_a_core_fence",
      now: new Date(),
    });
    const tokenA = claimedA.gatewayReconcileLeaseOwner;
    const pause = armPauseBeforeReconcileCore();
    const reconcileA = reconcileGatewayPayment(claimedA);
    await pause.waitUntilPaused();

    await Payment.updateOne(
      { _id: paymentId, tenantId: tenant._id, gatewayReconcileLeaseOwner: tokenA },
      {
        $unset: {
          gatewayReconcileLeaseOwner: "",
          gatewayReconcileLeaseExpiresAt: "",
        },
      },
    );
    const claimedB = await claimPaymentForReconcile({
      paymentId,
      tenantId: tenant._id,
      workerLabel: "worker_b_core_fence",
      now: new Date(),
    });
    assert.ok(claimedB);
    const tokenB = claimedB.gatewayReconcileLeaseOwner;

    const before = await Payment.findById(paymentId).lean();
    const attemptsBefore = before.gatewayReconcileAttempts ?? 0;
    const reviewBefore = before.requiresReview ?? false;
    const reviewReasonBefore = before.reviewReason ?? null;

    pause.resume();
    const outcomeA = await reconcileA;
    pause.disarm();

    assert.equal(outcomeA.outcome, "LEASE_LOST");
    assert.equal(providerCalls, 0);

    const after = await Payment.findById(paymentId).lean();
    assert.equal(after.gatewayReconcileLeaseOwner, tokenB);
    assert.equal(after.gatewayReconcileAttempts, attemptsBefore);
    assert.equal(after.requiresReview ?? false, reviewBefore);
    assert.equal(after.reviewReason ?? null, reviewReasonBefore);
    assert.equal(await clearReconcileLease(paymentId, tenant._id, tokenA), 0);
    assert.equal(await Alert.countDocuments({ tenantId: tenant._id, type: "GATEWAY_RECONCILE_EXHAUSTED" }), 0);
  } finally {
    phonePeProvider.getOrderStatus = originalGetOrderStatus;
  }
});

test("max attempts exhausts before missing-credentials path without provider call", async () => {
  const maxAttempts = env.PHONEPE_RECONCILE_MAX_ATTEMPTS ?? 5;
  const { tenant, paymentId } = await seedPendingForLease();
  await Payment.updateOne(
    { _id: paymentId, tenantId: tenant._id },
    { $set: { gatewayReconcileAttempts: maxAttempts } },
  );

  const originalGetOrderStatus = phonePeProvider.getOrderStatus.bind(phonePeProvider);
  let providerCalls = 0;
  phonePeProvider.getOrderStatus = async (...args) => {
    providerCalls += 1;
    return originalGetOrderStatus(...args);
  };

  try {
    const claimed = await claimPaymentForReconcile({
      paymentId,
      tenantId: tenant._id,
      workerLabel: "threshold_no_creds",
      now: new Date(),
    });
    const outcome = await reconcileGatewayPayment(claimed);
    assert.equal(outcome.outcome, "RECONCILE_EXHAUSTED");
    assert.equal(providerCalls, 0);

    const after = await Payment.findById(paymentId).lean();
    assert.equal(after.gatewayReconcileAttempts, maxAttempts);
    assert.equal(after.reviewReason, "GATEWAY_RECONCILE_EXHAUSTED");
    assert.equal(
      await Alert.countDocuments({
        tenantId: tenant._id,
        type: "GATEWAY_RECONCILE_EXHAUSTED",
        entityId: paymentId,
      }),
      1,
    );
  } finally {
    phonePeProvider.getOrderStatus = originalGetOrderStatus;
  }
});

test("clearReconcileLease rejects stale owner filter", async () => {
  const { tenant, paymentId } = await seedPendingForLease();
  await Payment.updateOne(
    { _id: paymentId, tenantId: tenant._id },
    {
      $set: {
        gatewayReconcileLeaseOwner: "owner_live",
        gatewayReconcileLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    },
  );
  assert.equal(await clearReconcileLease(paymentId, tenant._id, "owner_stale"), 0);
  const row = await Payment.findById(paymentId).lean();
  assert.equal(row.gatewayReconcileLeaseOwner, "owner_live");
  assert.equal(await clearReconcileLease(paymentId, tenant._id, "owner_live"), 1);
});
