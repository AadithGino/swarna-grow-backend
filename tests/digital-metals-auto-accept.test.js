import { runReservationExpiryBatch } from "../src/services/digital-metals-reservation-expiry.service.js";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId } from "../src/lib/ids.js";
import { seal } from "../src/lib/crypto.js";
import { withTransaction } from "../src/lib/transaction.js";
import { DIGITAL_METAL_OUTBOX_TOPICS } from "../src/lib/digital-metals-outbox.js";
import { armPauseAfterDigitalMetalSellDebitForTests, clearDigitalMetalSellFinalizeTestHooksForTests } from "../src/lib/digital-metals-sell-finalize-test-hooks.js";
import { creditWalletForTest } from "../src/services/digital-metals-ledger.service.js";
import { Customer, DigitalMetalBankDestination, DigitalMetalCustomerRiskHold, DigitalMetalJournal, DigitalMetalOutboxEvent, DigitalMetalPayable, DigitalMetalPayout, DigitalMetalReservation, DigitalMetalSellOrder, DigitalMetalWallet } from "../src/models/index.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { customerToken, enableDigitalMetalsPlan } from "./helpers/digital-metals-sell-flow.js";
import { makeTenantQuoteReady } from "./helpers/digital-metals-live-ready.js";

const app = createApp();
test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });
test.afterEach(() => { clearDigitalMetalSellFinalizeTestHooksForTests(); });

function post(path, token, body) {
  return request(app).post(`/api/v1${path}`).set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID()).send(body);
}

async function reservedSale() {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enableDigitalMetalsPlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  await withTransaction((session) => creditWalletForTest(session, {
    tenantId: tenant._id, customerId: customer._id, metal: "GOLD", finenessPpm: 999000,
    quantityUg: 2_000_000, idempotencyKey: randomUUID(),
  }));
  const token = await customerToken({ tenant, branch, customer });
  const quote = await post("/app/digital-metals/quotes/sell", token, { metal: "GOLD", finenessPpm: 999000, quantityUg: 1_000_000 });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const created = await post("/app/digital-metals/sell-orders", token, {
    quoteId: quote.body.data.quoteId, termsVersionAccepted: quote.body.data.termsVersion,
    termsContentHashAccepted: quote.body.data.termsContentHash,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.status, "RESERVED");
  const dest = await DigitalMetalBankDestination.create({
    _id: createId("dmbd"), tenantId: tenant._id, customerId: customer._id,
    accountHolderName: "Test User", accountNumberSealed: seal("123456789012"),
    accountLast4: "9012", ifsc: "HDFC0001234", status: "ACTIVE", verifiedAt: new Date(),
  });
  const orderId = created.body.data.id;
  const confirm = (bankDestinationId = dest._id) => post(`/app/digital-metals/sell-orders/${orderId}/confirm`, token, { bankDestinationId });
  return { tenant, user, customer, token, orderId, dest, confirm };
}

async function assertOneAcceptance(orderId) {
  const order = await DigitalMetalSellOrder.findById(orderId).lean();
  assert.equal(order.status, "PAYABLE_OPEN");
  assert.equal(order.approvalExpiresAt, null);
  assert.equal(await DigitalMetalPayable.countDocuments({ sellOrderId: orderId }), 1);
  assert.equal(await DigitalMetalJournal.countDocuments({ idempotencyKey: `sell-debit:${orderId}` }), 1);
  assert.equal(await DigitalMetalPayout.countDocuments({ sellOrderId: orderId }), 0);
  assert.equal(await DigitalMetalOutboxEvent.countDocuments({ topic: DIGITAL_METAL_OUTBOX_TOPICS.SELL_EXECUTED, key: orderId }), 1);
  assert.equal((await DigitalMetalReservation.findById(order.reservationId).lean()).status, "COMMITTED");
  const payable = await DigitalMetalPayable.findById(order.payableId).lean();
  assert.equal(payable.status, "OPEN");
  assert.equal(payable.outstandingPaise, order.settlementPaise);
}

test("customer confirmation accepts once without an administrator and leaves all payment due", async () => {
  const { confirm, orderId } = await reservedSale();
  const result = await confirm();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.paymentDisplayState.key, "UNPAID");
  assert.ok(!result.body.data.permittedActions.includes("ACCEPT_SALE"));
  await assertOneAcceptance(orderId);
});

test("concurrent confirmations and new-key retries produce one debit, payable and notice", async () => {
  const { confirm, orderId } = await reservedSale();
  const responses = await Promise.all([confirm(), confirm(), confirm()]);
  for (const result of responses) assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(new Set(responses.map((r) => r.body.data.payable.id)).size, 1);
  await assertOneAcceptance(orderId);
});

test("committed confirmation replays after bank deactivation but cannot change destination", async () => {
  const { confirm, dest, orderId } = await reservedSale();
  assert.equal((await confirm()).status, 200);
  await DigitalMetalBankDestination.updateOne({ _id: dest._id }, { $set: { status: "PENDING_VERIFICATION" } });
  assert.equal((await confirm()).status, 200);
  const changed = await confirm(createId("dmbd"));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, "SELL_DESTINATION_MISMATCH");
  await assertOneAcceptance(orderId);
});

test("failed execution rolls back debit, payable and notice; same sale can safely retry", async () => {
  const { confirm, orderId, customer } = await reservedSale();
  const before = await DigitalMetalWallet.findOne({ customerId: customer._id }).lean();
  armPauseAfterDigitalMetalSellDebitForTests();
  assert.equal((await confirm()).status, 500);
  clearDigitalMetalSellFinalizeTestHooksForTests();
  const after = await DigitalMetalWallet.findOne({ customerId: customer._id }).lean();
  assert.equal(String(after.heldUg), String(before.heldUg));
  assert.equal(String(after.reservedUg), String(before.reservedUg));
  assert.equal((await DigitalMetalSellOrder.findById(orderId).lean()).status, "RESERVED");
  assert.equal(await DigitalMetalPayable.countDocuments({ sellOrderId: orderId }), 0);
  assert.equal(await DigitalMetalJournal.countDocuments({ idempotencyKey: `sell-debit:${orderId}` }), 0);
  assert.equal(await DigitalMetalOutboxEvent.countDocuments({ topic: DIGITAL_METAL_OUTBOX_TOPICS.SELL_EXECUTED, key: orderId }), 0);
  assert.equal((await confirm()).status, 200);
  await assertOneAcceptance(orderId);
});

test("risk hold and inactive customer still block new automatic execution", async () => {
  const { tenant, customer, confirm, orderId } = await reservedSale();
  await DigitalMetalCustomerRiskHold.create({ _id: createId("dmrh"), tenantId: tenant._id, customerId: customer._id, status: "ACTIVE", reasonCode: "CHARGEBACK", exposurePaise: 5000 });
  const held = await confirm();
  assert.equal(held.status, 409);
  assert.equal(held.body.error.code, "DIGITAL_METALS_RISK_HOLD");
  await DigitalMetalCustomerRiskHold.deleteMany({ customerId: customer._id });
  await Customer.updateOne({ _id: customer._id }, { $set: { status: "INACTIVE" } });
  const inactive = await confirm();
  assert.ok([401, 403, 409].includes(inactive.status), JSON.stringify(inactive.body));
  assert.equal(await DigitalMetalPayable.countDocuments({ sellOrderId: orderId }), 0);
});

test("accepted sales cannot be cancelled to restore debited metal", async () => {
  const { confirm, token, orderId } = await reservedSale();
  assert.equal((await confirm()).status, 200);
  const cancelled = await post(`/app/digital-metals/sell-orders/${orderId}/cancel`, token, {});
  assert.equal(cancelled.status, 409);
  await assertOneAcceptance(orderId);
});

test("another customer's bank cannot be used to automatically accept a sale", async () => {
  const { tenant, customer, dest, confirm, orderId } = await reservedSale();
  const other = await seedCustomer({
    tenantId: tenant._id,
    branchId: customer.branchId,
    mobile: "+918800000002",
  });
  await DigitalMetalBankDestination.updateOne({ _id: dest._id }, { $set: { customerId: other._id } });
  const result = await confirm();
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "BANK_DESTINATION_NOT_VERIFIED");
  assert.equal(await DigitalMetalPayable.countDocuments({ sellOrderId: orderId }), 0);
  assert.equal(await DigitalMetalJournal.countDocuments({ idempotencyKey: `sell-debit:${orderId}` }), 0);
});

test("an expired unconfirmed quote cannot auto execute or create payment due", async () => {
  const { confirm, orderId } = await reservedSale();
  await DigitalMetalSellOrder.updateOne({ _id: orderId }, { $set: { quoteExpiresAt: new Date(Date.now() - 60000) } });
  const result = await confirm();
  assert.equal(result.status, 409);
  assert.equal((await DigitalMetalSellOrder.findById(orderId).lean()).status, "EXPIRED");
  assert.equal(await DigitalMetalPayable.countDocuments({ sellOrderId: orderId }), 0);
  assert.equal(await DigitalMetalJournal.countDocuments({ idempotencyKey: `sell-debit:${orderId}` }), 0);
});


test("R06 maintenance batch releases abandoned RESERVED sale and preserves accepted unpaid sale", async () => {
  const { orderId, customer } = await reservedSale();
  await DigitalMetalSellOrder.updateOne({ _id: orderId }, { $set: { quoteExpiresAt: new Date(Date.now() - 60000) } });
  await runReservationExpiryBatch({ kind: "sell" });
  assert.equal((await DigitalMetalSellOrder.findById(orderId).lean()).status, "EXPIRED");
  assert.equal((await DigitalMetalWallet.findOne({ customerId: customer._id }).lean()).reservedUg, 0);
  // A separate fixture is unnecessary: restore the reserved setup using a reset.
  await resetTestDb();
  const accepted = await reservedSale();
  assert.equal((await accepted.confirm()).status, 200);
  await DigitalMetalSellOrder.updateOne({ _id: accepted.orderId }, { $set: { quoteExpiresAt: new Date(Date.now() - 60000) } });
  await runReservationExpiryBatch({ kind: "sell" });
  const row = await DigitalMetalSellOrder.findById(accepted.orderId).lean();
  assert.equal(row.status, "PAYABLE_OPEN");
  assert.equal((await DigitalMetalPayable.findById(row.payableId).lean()).outstandingPaise, row.settlementPaise);
});
