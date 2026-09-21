import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/lib/app-error.js";
import {
  advanceInstallmentWindowCount,
  allocateFixedPaymentToInstallments,
  computeFixedPaymentQuote,
  isFixedPaymentAmountAllowed,
  previewFixedAllocation,
} from "../src/lib/fixed-payment-policy.js";
import {
  fixedReservationConsumable,
  reserveFixedPaymentIntentInSession,
  sumActiveFixedReservationPaise,
} from "../src/lib/fixed-payment-reservation.js";
import { createId } from "../src/lib/ids.js";
import { withTransaction } from "../src/lib/transaction.js";
import {
  Alert,
  Customer,
  LedgerEntry,
  OutboxEvent,
  Payment,
  PaymentIntent,
  PaymentLink,
  Scheme,
} from "../src/models/index.js";
import { PaymentIntentStatus, PaymentStatus, TenantRole } from "../src/constants/enums.js";
import { finalizeGatewaySuccess } from "../src/services/finalize-gateway-success.service.js";
import {
  cancelPaymentLink,
  createPaymentLink,
  recordPayment,
} from "../src/services/payment.service.js";
import { payableRange } from "../src/services/scheme.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

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
    headers: { "user-agent": "phase4-test" },
    ip: "127.0.0.1",
    body,
    query: {},
  };
}

test("advance window count: disabled, 0, 1 and 2 future slots", () => {
  assert.equal(advanceInstallmentWindowCount({ advancePaymentAllowed: false }), 1);
  assert.equal(
    advanceInstallmentWindowCount({ advancePaymentAllowed: true, maxAdvanceInstallments: 0 }),
    1,
  );
  assert.equal(
    advanceInstallmentWindowCount({ advancePaymentAllowed: true, maxAdvanceInstallments: 1 }),
    2,
  );
  assert.equal(
    advanceInstallmentWindowCount({ advancePaymentAllowed: true, maxAdvanceInstallments: 2 }),
    3,
  );
});

test("partial disabled rejects arbitrary amounts and accepts consecutive sums", () => {
  const quote = computeFixedPaymentQuote(
    { installments: installmentsBase },
    { partialPaymentAllowed: false, advancePaymentAllowed: true, maxAdvanceInstallments: 2 },
  );
  assert.deepEqual(quote.allowedAmountsPaise, [100_000, 200_000, 300_000]);
  assert.equal(isFixedPaymentAmountAllowed(quote, 150_000), false);
  assert.equal(isFixedPaymentAmountAllowed(quote, 300_000), true);
});

test("partial enabled respects min and max per transaction", () => {
  const quote = computeFixedPaymentQuote(
    { installments: installmentsBase },
    {
      partialPaymentAllowed: true,
      advancePaymentAllowed: false,
      minPaymentPaise: 20_000,
      maxPaymentPerTransactionPaise: 50_000,
    },
  );
  assert.equal(isFixedPaymentAmountAllowed(quote, 10_000), false);
  assert.equal(isFixedPaymentAmountAllowed(quote, 25_000), true);
  assert.equal(isFixedPaymentAmountAllowed(quote, 60_000), false);
});

test("partial disabled completes partial current installment before advancing", () => {
  const installments = [
    { number: 1, amountPaise: 100_000, paidPaise: 100_000, status: "PAID" },
    { number: 2, amountPaise: 100_000, paidPaise: 40_000, status: "PARTIALLY_PAID" },
    { number: 3, amountPaise: 100_000, paidPaise: 0, status: "PENDING" },
  ];
  const quote = computeFixedPaymentQuote(
    { installments },
    { partialPaymentAllowed: false, advancePaymentAllowed: true, maxAdvanceInstallments: 1 },
  );
  assert.deepEqual(quote.allowedAmountsPaise, [60_000, 160_000]);
  assert.equal(previewFixedAllocation(installments, 60_000, { partialPaymentAllowed: false }).throughInstallment, 2);
});

test("payableRange exposes reservation-aware fixed quote fields", async () => {
  const rules = {
    partialPaymentAllowed: false,
    advancePaymentAllowed: true,
    maxAdvanceInstallments: 1,
  };
  const { scheme } = await seedFixedScheme(rules);
  await withTransaction(async (session) => {
    await reserveFixedPaymentIntentInSession(session, {
      tenantId: scheme.tenantId,
      scheme: await Scheme.findById(scheme._id).session(session),
      amountPaise: 100_000,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
  });
  const quote = await payableRange({ query: {}, body: {} }, (await Scheme.findById(scheme._id)).toObject());
  assert.equal(quote.model, "FIXED");
  assert.equal(quote.reservedPaise, 100_000);
  assert.equal(quote.currentInstallmentNumber, 2);
  assert.deepEqual(quote.allowedAmountsPaise, [100_000]);
});

test("fixed payment link creates intent reservation with 30 minute default", async () => {
  const { scheme, user } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  const before = Date.now();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  const storedLink = await PaymentLink.findById(link.id).lean();
  assert.ok(intent);
  assert.equal(intent.fixedFromInstallment, 2);
  assert.equal(intent.fixedThroughInstallment, 2);
  assert.equal(storedLink.paymentIntentId, intent._id);
  const ttlMs = new Date(storedLink.expiresAt).getTime() - before;
  assert.ok(ttlMs >= 29 * 60_000 && ttlMs <= 31 * 60_000);
});

test("second reservation fails when combined amount exceeds payable capacity", async () => {
  const { scheme } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  await withTransaction(async (session) => {
    await reserveFixedPaymentIntentInSession(session, {
      tenantId: scheme.tenantId,
      scheme: await Scheme.findById(scheme._id).session(session),
      amountPaise: 100_000,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
  });
  await assert.rejects(
    () => withTransaction(async (session) => {
      await reserveFixedPaymentIntentInSession(session, {
        tenantId: scheme.tenantId,
        scheme: await Scheme.findById(scheme._id).session(session),
        amountPaise: 100_000,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
    }),
    (error) => error instanceof AppError && error.code === "PAYMENT_CONFIRMATION_PENDING",
  );
});

test("two reservations succeed when advance policy allows combined amount", async () => {
  const { scheme } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: true,
    maxAdvanceInstallments: 1,
  });
  await withTransaction(async (session) => {
    await reserveFixedPaymentIntentInSession(session, {
      tenantId: scheme.tenantId,
      scheme: await Scheme.findById(scheme._id).session(session),
      amountPaise: 100_000,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    await reserveFixedPaymentIntentInSession(session, {
      tenantId: scheme.tenantId,
      scheme: await Scheme.findById(scheme._id).session(session),
      amountPaise: 100_000,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
  });
  const { reservedPaise } = await sumActiveFixedReservationPaise(scheme.tenantId, scheme._id);
  assert.equal(reservedPaise, 200_000);
});

test("pending reservation blocks manual payment until link cancelled", async () => {
  const { scheme, user } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  await assert.rejects(
    () => recordPayment(staffReq(scheme, user, {
      schemeId: scheme._id,
      amountPaise: 100_000,
      mode: "CASH",
      expectedVersion: 2,
    })),
    (error) => error.code === "PAYMENT_CONFIRMATION_PENDING",
  );
  await cancelPaymentLink({
    ...staffReq(scheme, user),
    params: { linkId: link.id },
  });
  const payment = await recordPayment(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
    mode: "CASH",
    expectedVersion: 3,
  }));
  assert.equal(payment.status, "SUCCESS");
});

test("gateway finalization applies reserved allocation once", async () => {
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
    mode: "ONLINE_GATEWAY",
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  const transactionId = `TX-${createId("tx")}`;
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId,
    amountPaise: 100_000,
    intent,
    paymentId: payment._id,
  });
  const refreshed = await Scheme.findById(scheme._id).lean();
  assert.equal(refreshed.installments[1].status, "PAID");
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id }), 1);
  const replay = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId,
    amountPaise: 100_000,
    intent,
    paymentId: payment._id,
  });
  assert.equal(replay.outcome, "ALREADY_SUCCESS");
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id }), 1);
});

test("late success after cancelled reservation routes to review once", async () => {
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
  await cancelPaymentLink({
    ...staffReq(scheme, user),
    params: { linkId: link.id },
  });
  const cancelledIntent = await PaymentIntent.findById(intent._id).lean();
  assert.equal(cancelledIntent.status, PaymentIntentStatus.CANCELLED);
  const payment = await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    receiptNumber: `PENDING-${intent._id}`,
    amountPaise: 100_000,
    mode: "ONLINE_GATEWAY",
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  const transactionId = `TX-${createId("tx")}`;
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId,
    amountPaise: 100_000,
    intent: cancelledIntent,
    paymentId: payment._id,
  });
  const updatedPayment = await Payment.findById(payment._id).lean();
  assert.equal(updatedPayment.status, PaymentStatus.UNALLOCATED_PENDING_REVIEW);
  assert.equal((await Scheme.findById(scheme._id)).installments[1].status, "DUE");
  assert.equal(await Alert.countDocuments({ tenantId: tenant._id, entityId: payment._id }), 1);
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, type: "UNALLOCATED_PAYMENT" }), 1);
  assert.equal(await OutboxEvent.countDocuments({ key: payment._id, topic: "payment.unallocated.fixed_reservation_stale" }), 1);
  const replay = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId,
    amountPaise: 100_000,
    intent: cancelledIntent,
    paymentId: payment._id,
  });
  assert.equal(replay.outcome, "ALREADY_SUCCESS");
  assert.equal(await Alert.countDocuments({ tenantId: tenant._id, entityId: payment._id }), 1);
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, type: "UNALLOCATED_PAYMENT" }), 1);
});

test("fixedReservationConsumable rejects stale installment window", () => {
  const rules = { partialPaymentAllowed: false, advancePaymentAllowed: false };
  const intent = {
    status: PaymentIntentStatus.PENDING,
    amountPaise: 100_000,
    fixedFromInstallment: 2,
    fixedThroughInstallment: 2,
    reservationExpiresAt: new Date(Date.now() + 60_000),
  };
  const scheme = {
    installments: [
      { number: 1, amountPaise: 100_000, paidPaise: 100_000, status: "PAID" },
      { number: 2, amountPaise: 100_000, paidPaise: 100_000, status: "PAID" },
      { number: 3, amountPaise: 100_000, paidPaise: 0, status: "DUE" },
    ],
  };
  const result = fixedReservationConsumable(intent, scheme, rules);
  assert.equal(result.ok, false);
});

test("public pay rejects malformed and expired tokens without 500", async () => {
  const malformed = await request(app).get("/api/v1/public/pay/not-a-valid-token");
  assert.notEqual(malformed.status, 500);
  const { scheme, user } = await seedFixedScheme({
    partialPaymentAllowed: false,
    advancePaymentAllowed: false,
  });
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
    expiresInMinutes: 1,
  }));
  await PaymentLink.updateOne({ _id: link.id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
  const expired = await request(app).get(`/api/v1/public/pay/${link.token}`);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error?.code, "PAYMENT_LINK_EXPIRED");
});

test("partial disabled allocation throws on leftover when amount invalid", () => {
  const scheme = {
    installments: [
      { number: 1, amountPaise: 100_000, paidPaise: 0, status: "DUE" },
    ],
  };
  assert.throws(
    () => allocateFixedPaymentToInstallments(scheme, 50_000, { partialPaymentAllowed: false }),
    /FIXED_PAYMENT_PARTIAL_NOT_ALLOWED/,
  );
});
