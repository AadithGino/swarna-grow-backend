import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { AppError } from "../src/lib/app-error.js";
import {
  computeFixedPaymentQuote,
  previewFixedAllocation,
} from "../src/lib/fixed-payment-policy.js";
import {
  isFixedReservationIntent,
  reserveFixedPaymentIntentInSession,
  sumActiveFixedReservationPaise,
} from "../src/lib/fixed-payment-reservation.js";
import { createId } from "../src/lib/ids.js";
import { withTransaction } from "../src/lib/transaction.js";
import {
  Customer,
  LedgerEntry,
  OutboxEvent,
  Payment,
  PaymentIntent,
  PaymentLink,
  Scheme,
} from "../src/models/index.js";
import {
  PaymentIntentStatus,
  PaymentMode,
  PaymentStatus,
  TenantRole,
} from "../src/constants/enums.js";
import { applyTerminalGatewayFailure } from "../src/services/gateway-terminal-failure.service.js";
import {
  finalizeGatewaySuccess,
  GatewayFinalizeOutcome,
} from "../src/services/finalize-gateway-success.service.js";
import {
  cancelPaymentLink,
  createPaymentLink,
  recordPayment,
} from "../src/services/payment.service.js";
import { payableRange } from "../src/services/scheme.service.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

const installmentsBase = [
  { number: 1, amountPaise: 100_000, paidPaise: 100_000, status: "PAID" },
  { number: 2, amountPaise: 100_000, paidPaise: 0, status: "DUE" },
  { number: 3, amountPaise: 100_000, paidPaise: 0, status: "PENDING" },
  { number: 4, amountPaise: 100_000, paidPaise: 0, status: "PENDING" },
];

async function seedFixedScheme(paymentRules, installments = installmentsBase) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Fixed",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-FX-${Date.now()}`,
    planSnapshot: { paymentPattern: "FIXED", paymentRules },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 100_000,
    installments: installments.map((row) => ({ ...row })),
    version: 1,
    createdBy: user._id,
  });
  return { tenant, branch, user, customer, scheme };
}

function staffReq(scheme, user, body = {}) {
  return {
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "phase4-audit" },
    ip: "127.0.0.1",
    body,
    query: {},
  };
}

test("maxAdvanceInstallments=2 allows current plus two future exact sums", () => {
  const quote = computeFixedPaymentQuote(
    { installments: installmentsBase },
    { partialPaymentAllowed: false, advancePaymentAllowed: true, maxAdvanceInstallments: 2 },
  );
  assert.deepEqual(quote.allowedAmountsPaise, [100_000, 200_000, 300_000]);
});

test("partial enabled allocation applies sequentially to installments", async () => {
  const installments = [
    { number: 1, amountPaise: 100_000, paidPaise: 0, status: "DUE" },
    { number: 2, amountPaise: 100_000, paidPaise: 0, status: "PENDING" },
  ];
  const { scheme, user } = await seedFixedScheme(
    { partialPaymentAllowed: true, advancePaymentAllowed: false, minPaymentPaise: 10_000 },
    installments,
  );
  const payment = await recordPayment(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 35_000,
    mode: "CASH",
    expectedVersion: 1,
  }));
  assert.equal(payment.status, PaymentStatus.SUCCESS);
  const refreshed = await Scheme.findById(scheme._id).lean();
  assert.equal(refreshed.installments[0].paidPaise, 35_000);
  assert.equal(refreshed.installments[0].status, "PARTIALLY_PAID");
  assert.equal(refreshed.installments[1].paidPaise, 0);
  assert.equal(await LedgerEntry.countDocuments({ paymentId: payment.id ?? payment._id }), 1);
});

test("reservations on different schemes do not block each other", async () => {
  const rules = { partialPaymentAllowed: false, advancePaymentAllowed: false };
  const a = await seedFixedScheme(rules);
  const b = await seedFixedScheme(rules);
  await withTransaction(async (session) => {
    await reserveFixedPaymentIntentInSession(session, {
      tenantId: a.scheme.tenantId,
      scheme: await Scheme.findById(a.scheme._id).session(session),
      amountPaise: 100_000,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    await reserveFixedPaymentIntentInSession(session, {
      tenantId: b.scheme.tenantId,
      scheme: await Scheme.findById(b.scheme._id).session(session),
      amountPaise: 100_000,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
  });
  const sumA = await sumActiveFixedReservationPaise(a.scheme.tenantId, a.scheme._id);
  const sumB = await sumActiveFixedReservationPaise(b.scheme.tenantId, b.scheme._id);
  assert.equal(sumA.reservedPaise, 100_000);
  assert.equal(sumB.reservedPaise, 100_000);
});

test("parallel reservation attempts cannot double-book the same installment capacity", async () => {
  const { scheme } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  const attempts = await Promise.allSettled([
    withTransaction((session) => reserveFixedPaymentIntentInSession(session, {
      tenantId: scheme.tenantId,
      scheme: scheme,
      amountPaise: 100_000,
      expiresAt,
    })),
    withTransaction((session) => reserveFixedPaymentIntentInSession(session, {
      tenantId: scheme.tenantId,
      scheme: scheme,
      amountPaise: 100_000,
      expiresAt,
    })),
  ]);
  const fulfilled = attempts.filter((row) => row.status === "fulfilled");
  const rejected = attempts.filter((row) => row.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(
    (await sumActiveFixedReservationPaise(scheme.tenantId, scheme._id)).reservedPaise,
    100_000,
  );
  assert.equal(await PaymentIntent.countDocuments({ schemeId: scheme._id, status: PaymentIntentStatus.PENDING }), 1);
});

test("expired reservation restores payable capacity in persisted quote", async () => {
  const { scheme } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  const { intent } = await withTransaction(async (session) => reserveFixedPaymentIntentInSession(session, {
    tenantId: scheme.tenantId,
    scheme: await Scheme.findById(scheme._id).session(session),
    amountPaise: 100_000,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  }));
  await PaymentIntent.updateOne(
    { _id: intent._id },
    {
      $set: {
        reservationExpiresAt: new Date(Date.now() - 60_000),
        status: PaymentIntentStatus.EXPIRED,
      },
    },
  );
  const expiredIntent = await PaymentIntent.findById(intent._id).lean();
  assert.equal(expiredIntent.status, PaymentIntentStatus.EXPIRED);
  assert.equal((await sumActiveFixedReservationPaise(scheme.tenantId, scheme._id)).reservedPaise, 0);
  const quote = await payableRange({ query: {}, body: {} }, (await Scheme.findById(scheme._id)).toObject());
  assert.equal(quote.payable, true);
  assert.equal(quote.maxPayablePaise, 100_000);
  assert.deepEqual(quote.allowedAmountsPaise, [100_000]);
});

test("terminal gateway failure releases fixed reservation capacity", async () => {
  const { tenant, scheme, user } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const storedLink = await PaymentLink.findById(link.id).lean();
  const intent = await PaymentIntent.findById(storedLink.paymentIntentId).lean();
  const payment = await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    receiptNumber: `PENDING-${intent._id}`,
    amountPaise: 100_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentIntent.updateOne({ _id: intent._id }, { $set: { paymentId: payment._id } });
  await applyTerminalGatewayFailure({
    tenantId: tenant._id,
    paymentId: payment._id,
    reference: intent._id,
    providerPayload: { test: true },
  });
  const failedIntent = await PaymentIntent.findById(intent._id).lean();
  assert.equal(failedIntent.status, PaymentIntentStatus.FAILED);
  assert.equal((await sumActiveFixedReservationPaise(tenant._id, scheme._id)).reservedPaise, 0);
});

test("legacy gateway intent without reservation finalizes to SUCCESS", async () => {
  const { tenant, scheme } = await seedFixedScheme({
    partialPaymentAllowed: true,
    advancePaymentAllowed: false,
    minPaymentPaise: 1000,
  });
  const paymentId = createId("payment");
  const intentId = `${createId("paymentIntent")}__mock_completed__`;
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise: 100_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    amountPaise: 100_000,
    positionVersion: 1,
    status: PaymentIntentStatus.PENDING,
    paymentId,
    version: 1,
  });
  const intent = await PaymentIntent.findById(intentId).lean();
  assert.equal(isFixedReservationIntent(intent), false);
  assert.equal(intent.fixedFromInstallment, undefined);
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `TX-${intentId}`,
    amountPaise: 100_000,
    intent,
    paymentId,
  });
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
  assert.equal((await Scheme.findById(scheme._id).lean()).installments[1].status, "PAID");
});

test("fixedFromInstallment 0 is not treated as a reservation on finalize", async () => {
  const { tenant, scheme } = await seedFixedScheme({
    partialPaymentAllowed: true,
    advancePaymentAllowed: false,
    minPaymentPaise: 1000,
  });
  const paymentId = createId("payment");
  const intentId = createId("paymentIntent");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    receiptNumber: `PENDING-${intentId}`,
    amountPaise: 100_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentIntent.collection.insertOne({
    _id: intentId,
    tenantId: tenant._id,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    amountPaise: 100_000,
    positionVersion: 1,
    status: PaymentIntentStatus.PENDING,
    paymentId,
    version: 1,
    fixedFromInstallment: 0,
    fixedThroughInstallment: 0,
  });
  const intent = await PaymentIntent.findById(intentId).lean();
  assert.equal(isFixedReservationIntent(intent), false);
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intentId,
    transactionId: `TX-${intentId}`,
    amountPaise: 100_000,
    intent,
    paymentId,
  });
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
});

test("expired fixed reservation success routes to review with single ledger row", async () => {
  const { tenant, scheme, user } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const storedLink = await PaymentLink.findById(link.id).lean();
  let intent = await PaymentIntent.findById(storedLink.paymentIntentId).lean();
  await PaymentIntent.updateOne(
    { _id: intent._id },
    { $set: { reservationExpiresAt: new Date(Date.now() - 60_000) } },
  );
  intent = await PaymentIntent.findById(intent._id).lean();
  const payment = await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    receiptNumber: `PENDING-${intent._id}`,
    amountPaise: 100_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 100_000,
    intent,
    paymentId: payment._id,
  });
  assert.equal((await Payment.findById(payment._id).lean()).status, PaymentStatus.UNALLOCATED_PENDING_REVIEW);
  assert.equal(await LedgerEntry.countDocuments({ paymentId: payment._id }), 1);
  assert.equal(await OutboxEvent.countDocuments({ key: payment._id, topic: "payment.unallocated.fixed_reservation_stale" }), 1);
});

test("callback amount mismatch does not allocate reserved installment", async () => {
  const { tenant, scheme, user } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const intent = await PaymentIntent.findById((await PaymentLink.findById(link.id).lean()).paymentIntentId).lean();
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    receiptNumber: `PENDING-${intent._id}`,
    amountPaise: 100_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentIntent.updateOne({ _id: intent._id }, { $set: { paymentId } });
  const intentWithPayment = await PaymentIntent.findById(intent._id).lean();
  const result = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 99_000,
    intent: intentWithPayment,
    paymentId,
  });
  assert.equal(result.outcome, GatewayFinalizeOutcome.AMOUNT_MISMATCH);
  assert.equal((await Scheme.findById(scheme._id).lean()).installments[1].status, "DUE");
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id }), 0);
});

test("full reservation leaves no payable amounts until released", async () => {
  const { scheme, user } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const quote = await payableRange({ query: {}, body: {} }, (await Scheme.findById(scheme._id)).toObject());
  assert.equal(quote.reservedPaise, 100_000);
  assert.equal(quote.payable, false);
  assert.equal(quote.maxPayablePaise, 0);
});

test("createPaymentLink rejects expiresInMinutes above 30 at HTTP layer", async () => {
  const { scheme, user } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  const res = await request(app)
    .post("/api/v1/admin/payment-links")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ schemeId: scheme._id, amountPaise: 100_000, expiresInMinutes: 120 });
  assert.notEqual(res.status, 500);
  assert.equal(res.status, 400);
});

test("createPaymentLink rejects expiresInMinutes above 30 for direct service calls", async () => {
  const { scheme, user } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  await assert.rejects(
    () => createPaymentLink(staffReq(scheme, user, {
      schemeId: scheme._id,
      amountPaise: 100_000,
      expiresInMinutes: 120,
    })),
    (error) => error instanceof AppError && error.statusCode === 400 && error.code === "VALIDATION_FAILED",
  );
});

test("admin payment-link idempotency replay returns same link without duplicate intents", async () => {
  const { scheme, user } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  const key = randomUUID();
  const body = { schemeId: scheme._id, amountPaise: 100_000 };
  const first = await request(app)
    .post("/api/v1/admin/payment-links")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", key)
    .send(body);
  const second = await request(app)
    .post("/api/v1/admin/payment-links")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", key)
    .send(body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.data.id, first.body.data.id);
  assert.equal(await PaymentLink.countDocuments({ schemeId: scheme._id }), 1);
  assert.equal(await PaymentIntent.countDocuments({ schemeId: scheme._id }), 1);
});

test("public pay surfaces cancelled and missing tokens without 500", async () => {
  const missing = await request(app).get("/api/v1/public/pay/");
  assert.notEqual(missing.status, 500);
  const { scheme, user } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  await cancelPaymentLink({
    ...staffReq(scheme, user),
    params: { linkId: link.id },
  });
  const cancelled = await request(app).get(`/api/v1/public/pay/${link.token}`);
  assert.notEqual(cancelled.status, 500);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.canPay, false);
});

test("preview allocation completes incomplete current before advancing", () => {
  const installments = [
    { number: 1, amountPaise: 100_000, paidPaise: 50_000, status: "PARTIALLY_PAID" },
    { number: 2, amountPaise: 100_000, paidPaise: 0, status: "DUE" },
  ];
  const allocation = previewFixedAllocation(installments, 50_000, { partialPaymentAllowed: false });
  assert.equal(allocation.fromInstallment, 1);
  assert.equal(allocation.throughInstallment, 1);
});
