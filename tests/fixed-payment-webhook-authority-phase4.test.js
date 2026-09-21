import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import {
  Customer,
  LedgerEntry,
  Payment,
  PaymentIntent,
  PaymentLink,
  Scheme,
} from "../src/models/index.js";
import {
  LedgerEntryType,
  PaymentIntentStatus,
  PaymentMode,
  PaymentStatus,
  TenantRole,
} from "../src/constants/enums.js";
import {
  finalizeGatewaySuccess,
  GatewayFinalizeOutcome,
} from "../src/services/finalize-gateway-success.service.js";
import {
  cancelPaymentLink,
  createPaymentLink,
} from "../src/services/payment.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedFixedScheme() {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Webhook",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-WH-${Date.now()}`,
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
    installments: [{
      number: 1,
      dueDate: "2026-01-05",
      amountPaise: 100_000,
      paidPaise: 0,
      status: "DUE",
      graceEndsAt: "2026-01-10",
    }],
    version: 1,
    createdBy: user._id,
  });
  return { tenant, user, scheme, customer, branch };
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

const tamperedPayload = {
  schemeId: "sch_tampered",
  customerId: "cus_tampered",
  branchId: "brn_tampered",
  fixedFromInstallment: 9,
  fixedThroughInstallment: 9,
  amountPaise: 1,
};

test("gateway success ignores tampered provider payload identity fields", async () => {
  const { tenant, scheme, user, customer, branch } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const storedLink = await PaymentLink.findById(link.id).lean();
  const intent = await PaymentIntent.findById(storedLink.paymentIntentId).lean();
  const payment = await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${intent._id}`,
    amountPaise: 100_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentIntent.updateOne({ _id: intent._id }, { $set: { paymentId: payment._id } });
  const poisonedIntent = {
    ...intent,
    schemeId: "sch_tampered",
    customerId: "cus_tampered",
    branchId: "brn_tampered",
    fixedFromInstallment: 9,
    fixedThroughInstallment: 9,
  };
  const txn = `TX-${createId("tx")}`;
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: txn,
    amountPaise: 100_000,
    providerPayload: tamperedPayload,
    intent: poisonedIntent,
    paymentId: payment._id,
  });
  const pay = await Payment.findById(payment._id).lean();
  assert.equal(pay.schemeId, scheme._id);
  assert.equal(pay.customerId, customer._id);
  assert.equal(pay.branchId, branch._id);
  assert.equal(pay.status, PaymentStatus.SUCCESS);
  assert.equal((await Scheme.findById(scheme._id).lean()).installments[0].status, "PAID");
  assert.equal(await LedgerEntry.countDocuments({ paymentId: payment._id, type: LedgerEntryType.INSTALLMENT_PAYMENT }), 1);
});

test("callback amount mismatch cannot change allocation", async () => {
  const { tenant, scheme, user, customer, branch } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const intent = await PaymentIntent.findById((await PaymentLink.findById(link.id).lean()).paymentIntentId).lean();
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${intent._id}`,
    amountPaise: 100_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentIntent.updateOne({ _id: intent._id }, { $set: { paymentId } });
  const result = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 50_000,
    providerPayload: { ...tamperedPayload, amountPaise: 50_000 },
    intent: await PaymentIntent.findById(intent._id).lean(),
    paymentId,
  });
  assert.equal(result.outcome, GatewayFinalizeOutcome.AMOUNT_MISMATCH);
  assert.equal((await Scheme.findById(scheme._id).lean()).installments[0].paidPaise, 0);
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id }), 0);
});

test("unknown provider reference creates no allocation", async () => {
  const { tenant } = await seedFixedScheme();
  const result = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: createId("paymentIntent"),
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 100_000,
    providerPayload: tamperedPayload,
    intent: null,
    link: null,
  });
  assert.equal(result.outcome, GatewayFinalizeOutcome.NO_SOURCE);
  assert.equal(await Payment.countDocuments({ tenantId: tenant._id, status: PaymentStatus.SUCCESS }), 0);
  assert.equal(await LedgerEntry.countDocuments({ tenantId: tenant._id }), 0);
});

test("valid reference-matched callback succeeds and replay stays idempotent", async () => {
  const { tenant, scheme, user, customer, branch } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const intent = await PaymentIntent.findById((await PaymentLink.findById(link.id).lean()).paymentIntentId).lean();
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    receiptNumber: `PENDING-${intent._id}`,
    amountPaise: 100_000,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: PaymentStatus.PENDING,
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentIntent.updateOne({ _id: intent._id }, { $set: { paymentId } });
  const args = {
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 100_000,
    providerPayload: { provider: "PHONEPE" },
    intent: await PaymentIntent.findById(intent._id).lean(),
    paymentId,
  };
  const first = await finalizeGatewaySuccess(args);
  const second = await finalizeGatewaySuccess(args);
  assert.equal(first.outcome, GatewayFinalizeOutcome.SUCCESS);
  assert.equal(second.outcome, GatewayFinalizeOutcome.ALREADY_SUCCESS);
  assert.equal(await LedgerEntry.countDocuments({ schemeId: scheme._id, type: LedgerEntryType.INSTALLMENT_PAYMENT }), 1);
  assert.equal((await PaymentIntent.findById(intent._id).lean()).status, PaymentIntentStatus.SUCCEEDED);
});

test("cancelled reservation success does not allocate instalment", async () => {
  const { tenant, scheme, user, customer, branch } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const intent = await PaymentIntent.findById((await PaymentLink.findById(link.id).lean()).paymentIntentId).lean();
  await cancelPaymentLink({ ...staffReq(scheme, user), params: { linkId: link.id } });
  const paymentId = createId("payment");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
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
    providerPayload: tamperedPayload,
    intent: await PaymentIntent.findById(intent._id).lean(),
    paymentId,
  });
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.UNALLOCATED_PENDING_REVIEW);
  assert.equal((await Scheme.findById(scheme._id).lean()).installments[0].status, "DUE");
});
