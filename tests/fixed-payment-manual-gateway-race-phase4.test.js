import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/lib/app-error.js";
import {
  armPauseBeforeFixedSchemeCommit,
  armPauseBeforeGatewayRecordPayment,
  armPauseBeforeManualFixedReservationGate,
  clearFixedPaymentTestHooks,
} from "../src/lib/fixed-payment-test-hooks.js";
import { sumActiveFixedReservationPaise } from "../src/lib/fixed-payment-reservation.js";
import { createId } from "../src/lib/ids.js";
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
import {
  LedgerEntryType,
  PaymentMode,
  PaymentStatus,
  TenantRole,
} from "../src/constants/enums.js";
import { finalizeGatewaySuccess } from "../src/services/finalize-gateway-success.service.js";
import {
  cancelPaymentLink,
  createPaymentLink,
  recordPayment,
} from "../src/services/payment.service.js";
import { ledgerTotals } from "../src/services/scheme.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  clearFixedPaymentTestHooks();
});
test.afterEach(() => {
  clearFixedPaymentTestHooks();
});

const installmentsBase = [
  { number: 1, amountPaise: 100_000, paidPaise: 100_000, status: "PAID" },
  { number: 2, amountPaise: 100_000, paidPaise: 0, status: "DUE" },
];

async function seedFixedScheme() {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Race",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-R-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      paymentRules: { partialPaymentAllowed: false, advancePaymentAllowed: false },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 100_000,
    installments: installmentsBase.map((row) => ({ ...row })),
    version: 1,
    createdBy: user._id,
  });
  return { tenant, user, scheme };
}

function staffReq(scheme, user, body = {}) {
  return {
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    baseUrl: "/api/v1/admin",
    headers: {},
    ip: "127.0.0.1",
    body,
    query: {},
  };
}

async function assertFixedFinancialInvariants(schemeId, tenantId) {
  const scheme = await Scheme.findById(schemeId).lean();
  for (const row of scheme.installments ?? []) {
    assert.ok(row.paidPaise <= row.amountPaise, `installment ${row.number} overpaid`);
  }
  const ledgers = await LedgerEntry.find({ schemeId, tenantId }).lean();
  const sequences = ledgers.map((row) => row.sequence);
  assert.equal(new Set(sequences).size, sequences.length);
  const installmentRows = ledgers.filter((row) => row.type === LedgerEntryType.INSTALLMENT_PAYMENT);
  const allocatedPaise = installmentRows.reduce((sum, row) => sum + row.amountPaise, 0);
  const successPayments = await Payment.find({
    tenantId,
    schemeId,
    status: PaymentStatus.SUCCESS,
  }).lean();
  const successAllocated = successPayments.reduce(
    (sum, row) => sum + (row.allocatedAmountPaise ?? row.amountPaise),
    0,
  );
  assert.equal(allocatedPaise, successAllocated);
  const totals = ledgerTotals(ledgers.filter((row) => row.type !== LedgerEntryType.UNALLOCATED_PAYMENT));
  assert.equal(totals.amountPaidPaise, successAllocated);
  return { installmentLedgers: installmentRows.length, totals };
}

async function seedReservedCheckout({ tenant, scheme, user }) {
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
  return { link, intent, payment };
}

test("simultaneous manual and gateway: manual blocked, gateway allocates once", async () => {
  const { tenant, scheme, user } = await seedFixedScheme();
  const { intent, payment } = await seedReservedCheckout({ tenant, scheme, user });
  const blocking = await sumActiveFixedReservationPaise(tenant._id, scheme._id);
  assert.equal(blocking.reservedPaise, 100_000);
  const [manualResult, fin] = await Promise.all([
    recordPayment(staffReq(scheme, user, {
      schemeId: scheme._id,
      amountPaise: 100_000,
      mode: "CASH",
      expectedVersion: scheme.version + 1,
    })).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    ),
    finalizeGatewaySuccess({
      tenantId: tenant._id,
      reference: intent._id,
      transactionId: `TX-${createId("tx")}`,
      amountPaise: 100_000,
      intent,
      paymentId: payment._id,
    }),
  ]);
  assert.equal(manualResult.ok, false);
  assert.equal(manualResult.error.code, "PAYMENT_CONFIRMATION_PENDING");
  assert.equal(fin.outcome, "SUCCESS");
  const refreshed = await Scheme.findById(scheme._id).lean();
  assert.equal(refreshed.installments[1].status, "PAID");
  const { installmentLedgers } = await assertFixedFinancialInvariants(scheme._id, tenant._id);
  assert.equal(installmentLedgers, 1);
});

test("gateway commit barrier first: manual blocked then gateway wins", async () => {
  const { tenant, scheme, user } = await seedFixedScheme();
  const { intent, payment } = await seedReservedCheckout({ tenant, scheme, user });
  const pause = armPauseBeforeFixedSchemeCommit();
  const finalizePromise = finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 100_000,
    intent,
    paymentId: payment._id,
  });
  const manualPromise = recordPayment(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
    mode: "CASH",
    expectedVersion: scheme.version + 1,
  })).catch((error) => error);
  await pause.waitUntilPaused();
  const manualError = await manualPromise;
  assert.ok(manualError instanceof AppError);
  assert.equal(manualError.code, "PAYMENT_CONFIRMATION_PENDING");
  pause.resume();
  await finalizePromise;
  pause.disarm();
  assert.equal((await Scheme.findById(scheme._id).lean()).installments[1].status, "PAID");
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, type: LedgerEntryType.INSTALLMENT_PAYMENT }), 1);
});

test("manual gate barrier first: gateway completes before manual resumes", async () => {
  const { tenant, scheme, user } = await seedFixedScheme();
  const { intent, payment } = await seedReservedCheckout({ tenant, scheme, user });
  const pause = armPauseBeforeManualFixedReservationGate();
  const manualPromise = recordPayment(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
    mode: "CASH",
    expectedVersion: scheme.version + 1,
  })).catch((error) => error);
  await pause.waitUntilPaused();
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 100_000,
    intent,
    paymentId: payment._id,
  });
  pause.resume();
  const manualError = await manualPromise;
  pause.disarm();
  assert.ok(manualError instanceof AppError);
  assert.equal((await Scheme.findById(scheme._id).lean()).installments[1].status, "PAID");
  assert.notEqual(manualError.code, "PAYMENT_CONFIRMATION_PENDING");
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, type: LedgerEntryType.INSTALLMENT_PAYMENT }), 1);
});

test("manual commits first: stale gateway success becomes UNALLOCATED once", async () => {
  const { tenant, scheme, user } = await seedFixedScheme();
  const { link, intent, payment } = await seedReservedCheckout({ tenant, scheme, user });
  await cancelPaymentLink({ ...staffReq(scheme, user), params: { linkId: link.id } });
  const cancelledIntent = await PaymentIntent.findById(intent._id).lean();
  const transactionId = `TX-${createId("tx")}`;
  const pause = armPauseBeforeGatewayRecordPayment();
  const manualPromise = recordPayment(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
    mode: "CASH",
    expectedVersion: (await Scheme.findById(scheme._id).lean()).version,
  }));
  const finalizePromise = finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId,
    amountPaise: 100_000,
    intent: cancelledIntent,
    paymentId: payment._id,
  });
  await pause.waitUntilPaused();
  await manualPromise;
  pause.resume();
  await finalizePromise;
  pause.disarm();
  assert.equal((await Payment.findById(payment._id).lean()).status, PaymentStatus.UNALLOCATED_PENDING_REVIEW);
  assert.equal((await Scheme.findById(scheme._id).lean()).installments[1].paidPaise, 100_000);
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, type: LedgerEntryType.INSTALLMENT_PAYMENT }), 1);
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, type: LedgerEntryType.UNALLOCATED_PAYMENT }), 1);
  assert.equal(await Alert.countDocuments({ tenantId: tenant._id, entityId: payment._id }), 1);
  const replay = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId,
    amountPaise: 100_000,
    intent: cancelledIntent,
    paymentId: payment._id,
  });
  assert.equal(replay.outcome, "ALREADY_SUCCESS");
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id }), 2);
  assert.equal(await OutboxEvent.countDocuments({ key: payment._id, topic: "payment.unallocated.fixed_reservation_stale" }), 1);
  await assertFixedFinancialInvariants(scheme._id, tenant._id);
});
