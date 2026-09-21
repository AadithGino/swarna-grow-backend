import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { connectRedis } from "../src/config/redis.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { sumActiveFixedReservationPaise } from "../src/lib/fixed-payment-reservation.js";
import { createId } from "../src/lib/ids.js";
import {
  Customer,
  IdempotencyRecord,
  Payment,
  PaymentIntent,
  PaymentLink,
  Scheme,
  Tenant,
} from "../src/models/index.js";
import {
  IdempotencyState,
  LinkStatus,
  PaymentIntentStatus,
  PaymentStatus,
  SchemeStatus,
  TenantRole,
} from "../src/constants/enums.js";
import { applyTerminalGatewayFailure } from "../src/services/gateway-terminal-failure.service.js";
import { finalizeGatewaySuccess } from "../src/services/finalize-gateway-success.service.js";
import { runPaymentExpiry } from "../src/services/payment-expiry.service.js";
import {
  cancelPaymentLink,
  createPaymentLink,
} from "../src/services/payment.service.js";
import { payableRange } from "../src/services/scheme.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();
const redirectUrl = "http://localhost:5173/pay/return";

test.before(async () => {
  await connectRedis();
  await startTestDb();
});
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function enableTenantPayments(tenantId) {
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "operations.customerAppPaymentsEnabled": true,
        "operations.customerAppWriteEnabled": true,
        integrationSecrets: {
          phonepe: {
            clientId: "TEST",
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

async function seedFixedScheme({ status = SchemeStatus.ACTIVE } = {}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await enableTenantPayments(tenant._id);
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Fixed Public",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-P-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      paymentRules: { partialPaymentAllowed: false, advancePaymentAllowed: false },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status,
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
  return {
    tenant,
    user,
    scheme,
    customer,
  };
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

async function postInitiate(token, body = { redirectUrl }) {
  return request(app)
    .post(`/api/v1/public/pay/${token}/initiate`)
    .set("x-idempotency-key", randomUUID())
    .send(body);
}

test("fixed public link: valid initiation creates one pending payment bound to reservation", async () => {
  const { scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const res = await postInitiate(link.token);
  assert.notEqual(res.status, 500);
  assert.equal(res.status, 200);
  assert.equal(await PaymentIntent.countDocuments({ schemeId: scheme._id }), 1);
  assert.equal(await Payment.countDocuments({ schemeId: scheme._id, status: PaymentStatus.PENDING }), 1);
  const stored = await PaymentLink.findById(link.id).lean();
  assert.ok(stored.paymentId);
  assert.equal(stored.paymentIntentId, (await PaymentIntent.findOne({ schemeId: scheme._id }))._id);
});

test("fixed public HTTP matrix: token and link edge cases avoid 500", async () => {
  const malformed = await request(app).get("/api/v1/public/pay/not-valid");
  assert.notEqual(malformed.status, 500);
  const { scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  await cancelPaymentLink({ ...staffReq(scheme, user), params: { linkId: link.id } });
  const cancelled = await request(app).get(`/api/v1/public/pay/${link.token}`);
  assert.notEqual(cancelled.status, 500);
  assert.equal(cancelled.body.data?.canPay, false);
  await PaymentLink.updateOne({ _id: link.id }, { $set: { expiresAt: new Date(Date.now() - 60_000), status: LinkStatus.OPENED } });
  const expired = await request(app).get(`/api/v1/public/pay/${link.token}`);
  assert.equal(expired.status, 410);
});

test("fixed public link: missing scheme returns controlled error", async () => {
  const { scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  await Scheme.deleteOne({ _id: scheme._id });
  const missingScheme = await request(app).get(`/api/v1/public/pay/${link.token}`);
  assert.notEqual(missingScheme.status, 500);
});

test("fixed public link: missing customer returns controlled error", async () => {
  const { scheme, user, customer } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  await Customer.deleteOne({ _id: customer._id });
  const res = await request(app).get(`/api/v1/public/pay/${link.token}`);
  assert.notEqual(res.status, 500);
});

test("fixed public link: concurrent initiation resolves to one pending payment", async () => {
  const { scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const [a, b] = await Promise.all([postInitiate(link.token), postInitiate(link.token)]);
  assert.notEqual(a.status, 500);
  assert.notEqual(b.status, 500);
  assert.equal(await Payment.countDocuments({ schemeId: scheme._id }), 1);
  if (a.status === 200 && b.status === 200) {
    assert.equal(a.body.data.paymentId, b.body.data.paymentId);
  }
});

test("fixed public link: consumed paid link is not payable", async () => {
  const { tenant, scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const init = await postInitiate(link.token);
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  const storedLink = await PaymentLink.findById(link.id).lean();
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 100_000,
    intent,
    link: storedLink,
    paymentId: init.body.data.paymentId,
  });
  const page = await request(app).get(`/api/v1/public/pay/${link.token}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.data.canPay, false);
  assert.equal((await PaymentLink.findById(link.id).lean()).status, LinkStatus.PAID);
});

test("fixed public link: repeated initiation reuses same payment", async () => {
  const { scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const first = await postInitiate(link.token);
  const second = await postInitiate(link.token);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.data.paymentId, second.body.data.paymentId);
  assert.equal(await Payment.countDocuments({ schemeId: scheme._id }), 1);
  assert.equal(await PaymentIntent.countDocuments({ schemeId: scheme._id }), 1);
});

test("fixed public link: transient provider failure then retry reuses reservation", async () => {
  const { scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const original = phonePeProvider.createPayment.bind(phonePeProvider);
  let calls = 0;
  phonePeProvider.createPayment = async (args) => {
    calls += 1;
    if (calls === 1) throw new Error("mock transient provider error");
    return original(args);
  };
  try {
    const fail = await postInitiate(link.token);
    assert.notEqual(fail.status, 500);
    assert.equal(fail.status, 503);
    assert.equal(await PaymentIntent.countDocuments({ schemeId: scheme._id, status: PaymentIntentStatus.PENDING }), 1);
    const ok = await postInitiate(link.token);
    assert.equal(ok.status, 200);
    assert.equal(await Payment.countDocuments({ schemeId: scheme._id }), 1);
    assert.equal(await PaymentLink.countDocuments({ schemeId: scheme._id }), 1);
    const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
    assert.equal(intent.status, PaymentIntentStatus.PENDING);
    assert.equal(await IdempotencyRecord.countDocuments({ state: IdempotencyState.PROCESSING }), 0);
  } finally {
    phonePeProvider.createPayment = original;
  }
});

test("fixed public link: terminal provider failure releases reservation capacity", async () => {
  const { tenant, scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const init = await postInitiate(link.token);
  assert.equal(init.status, 200);
  const paymentId = init.body.data.paymentId;
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  await applyTerminalGatewayFailure({
    tenantId: tenant._id,
    paymentId,
    reference: intent._id,
    providerPayload: { test: true },
  });
  assert.equal((await sumActiveFixedReservationPaise(tenant._id, scheme._id)).reservedPaise, 0);
  assert.equal((await PaymentIntent.findById(intent._id).lean()).status, PaymentIntentStatus.FAILED);
});

test("fixed public link: success callback and replay are idempotent", async () => {
  const { tenant, scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const init = await postInitiate(link.token);
  const paymentId = init.body.data.paymentId;
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  const txn = `TX-${createId("tx")}`;
  const args = {
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: txn,
    amountPaise: 100_000,
    intent,
    paymentId,
  };
  await finalizeGatewaySuccess(args);
  const replay = await finalizeGatewaySuccess(args);
  assert.equal(replay.outcome, "ALREADY_SUCCESS");
  assert.equal((await Scheme.findById(scheme._id).lean()).installments[0].status, "PAID");
});

test("fixed public link: amount mismatch and tampered callback do not allocate", async () => {
  const { tenant, scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const init = await postInitiate(link.token);
  const paymentId = init.body.data.paymentId;
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  await PaymentIntent.updateOne({ _id: intent._id }, { $set: { paymentId } });
  const bad = await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 99_000,
    intent: await PaymentIntent.findById(intent._id).lean(),
    paymentId,
  });
  assert.equal(bad.outcome, "AMOUNT_MISMATCH");
  assert.equal((await Scheme.findById(scheme._id).lean()).installments[0].paidPaise, 0);
});

test("fixed payment expiry job expires intent and link and restores payable capacity", async () => {
  const now = new Date();
  const past = new Date(now.getTime() - 120_000);
  const { tenant, scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const stored = await PaymentLink.findById(link.id).lean();
  await PaymentIntent.updateOne(
    { _id: stored.paymentIntentId },
    { $set: { reservationExpiresAt: past } },
  );
  await PaymentLink.updateOne({ _id: link.id }, { $set: { expiresAt: past, status: LinkStatus.OPENED } });
  const first = await runPaymentExpiry(now, { maxBatches: 3, batchSize: 20 });
  assert.ok(first.expired >= 1);
  assert.equal((await PaymentIntent.findById(stored.paymentIntentId).lean()).status, PaymentIntentStatus.EXPIRED);
  assert.equal((await PaymentLink.findById(link.id).lean()).status, LinkStatus.EXPIRED);
  assert.equal((await sumActiveFixedReservationPaise(tenant._id, scheme._id)).reservedPaise, 0);
  const quote = await payableRange({ query: {}, body: {} }, (await Scheme.findById(scheme._id)).toObject());
  assert.equal(quote.payable, true);
  assert.equal(quote.maxPayablePaise, 100_000);
  assert.equal((await Scheme.findById(scheme._id).lean()).status, SchemeStatus.ACTIVE);
  const second = await runPaymentExpiry(now, { maxBatches: 3, batchSize: 20 });
  assert.equal(second.expired, 0);
});

test("fixed expiry: success before expiry is preserved; success after expiry is review once", async () => {
  const { tenant, scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const init = await postInitiate(link.token);
  const paymentId = init.body.data.paymentId;
  const intent = await PaymentIntent.findOne({ schemeId: scheme._id }).lean();
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 100_000,
    intent,
    paymentId,
  });
  await PaymentIntent.updateOne({ _id: intent._id }, { $set: { reservationExpiresAt: new Date(Date.now() - 60_000) } });
  await runPaymentExpiry(new Date(), { maxBatches: 2, batchSize: 10 });
  assert.equal((await Payment.findById(paymentId).lean()).status, PaymentStatus.SUCCESS);
});

test("fixed expiry: provider success after reservation expiry is UNALLOCATED once", async () => {
  const { tenant, scheme, user } = await seedFixedScheme();
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const stored = await PaymentLink.findById(link.id).lean();
  const init = await postInitiate(link.token);
  await PaymentIntent.updateOne(
    { _id: stored.paymentIntentId },
    { $set: { reservationExpiresAt: new Date(Date.now() - 60_000) } },
  );
  await runPaymentExpiry(new Date(), { maxBatches: 2, batchSize: 10 });
  const intent = await PaymentIntent.findById(stored.paymentIntentId).lean();
  await finalizeGatewaySuccess({
    tenantId: tenant._id,
    reference: intent._id,
    transactionId: `TX-${createId("tx")}`,
    amountPaise: 100_000,
    intent,
    paymentId: init.body.data.paymentId,
  });
  assert.equal((await Payment.findById(init.body.data.paymentId).lean()).status, PaymentStatus.UNALLOCATED_PENDING_REVIEW);
});

test("PENDING_PAYMENT enrollment expires when mandatory first-payment reservation expires", async () => {
  const now = new Date();
  const past = new Date(now.getTime() - 120_000);
  const { scheme, user } = await seedFixedScheme({ status: SchemeStatus.PENDING_PAYMENT });
  const link = await createPaymentLink(staffReq(scheme, user, {
    schemeId: scheme._id,
    amountPaise: 100_000,
  }));
  const stored = await PaymentLink.findById(link.id).lean();
  await PaymentIntent.updateOne(
    { _id: stored.paymentIntentId },
    { $set: { reservationExpiresAt: past } },
  );
  await PaymentLink.updateOne({ _id: link.id }, { $set: { expiresAt: past } });
  await runPaymentExpiry(now, { maxBatches: 3, batchSize: 20 });
  assert.equal((await Scheme.findById(scheme._id).lean()).status, SchemeStatus.ENROLMENT_EXPIRED);
});
