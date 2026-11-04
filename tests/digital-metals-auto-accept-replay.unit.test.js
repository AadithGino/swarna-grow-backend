import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { DigitalMetalPayable, DigitalMetalPayout, DigitalMetalSellOrder } from "../src/models/index.js";
import { finalizeReservedSellOrder, createSellOrder } from "../src/services/digital-metals-sell.service.js";
import { hashDigitalMetalsOrderBody } from "../src/lib/digital-metals-customer-idempotency.js";

const order = { _id: "sell_1", tenantId: "tenant_a", customerId: "customer_a", status: "PAYABLE_OPEN", bankDestinationId: "bank_1", payoutMethod: "BANK", payableId: "payable_1", quantityUg: 1000000, settlementPaise: 50000, version: 3 };
const req = { auth: { type: "CUSTOMER", tenantId: "tenant_a", id: "customer_a" }, body: { quoteId: "quote_1" }, headers: { "x-idempotency-key": "create_1" } };
function query(value) {
  return { session() { return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}
function fixture(t, { row = order, payable = { _id: "payable_1", status: "OPEN", amountPaise: 50000, outstandingPaise: 50000 }, payouts = [] } = {}) {
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (work) => work(), endSession: async () => {} }));
  t.mock.method(DigitalMetalSellOrder, "findOne", (filter) => {
    assert.equal(filter.tenantId, "tenant_a");
    return query(row);
  });
  t.mock.method(DigitalMetalPayable, "findOne", (filter) => {
    assert.equal(filter.tenantId, "tenant_a");
    assert.equal(filter.sellOrderId, "sell_1");
    return query(payable);
  });
  t.mock.method(DigitalMetalPayout, "find", () => query(payouts));
  t.mock.method(DigitalMetalSellOrder, "create", () => { throw new Error("Replay must not create an order"); });
  t.mock.method(DigitalMetalPayable, "create", () => { throw new Error("Replay must not create a payable"); });
}
const finalize = () => finalizeReservedSellOrder(req, { orderId: "sell_1", bankDestinationId: "bank_1" });

test("accepted replay returns its existing unpaid obligation without executing again", async (t) => {
  fixture(t);
  const dto = await finalize();
  assert.equal(dto.id, "sell_1");
  assert.equal(dto.payable.id, "payable_1");
  assert.equal(dto.paymentDisplayState.key, "UNPAID");
  assert.deepEqual(dto.permittedActions, ["RECORD_PAYMENT"]);
});
test("accepted replay returns paid state after payment rather than reopening debt", async (t) => {
  fixture(t, { payable: { _id: "payable_1", status: "SETTLED", amountPaise: 50000, outstandingPaise: 0 } });
  const dto = await finalize();
  assert.equal(dto.paymentDisplayState.key, "PAID");
  assert.deepEqual(dto.permittedActions, []);
});
test("accepted replay refuses a changed bank destination", async (t) => {
  fixture(t);
  await assert.rejects(finalizeReservedSellOrder(req, { orderId: "sell_1", bankDestinationId: "bank_2" }), { code: "SELL_DESTINATION_MISMATCH" });
});
test("accepted replay fails closed when its payable is missing", async (t) => {
  fixture(t, { payable: null });
  await assert.rejects(finalize(), { code: "SELL_PAYABLE_MISSING" });
});
test("accepted replay cannot return another customer's sale", async (t) => {
  fixture(t, { row: { ...order, customerId: "customer_b" } });
  await assert.rejects(finalize(), { statusCode: 404 });
});
test("counter placement durable retry returns the committed order without a live quote lookup", async (t) => {
  const opts = { assisted: { byUserId: "staff_1" }, payoutMethod: "BANK", bankDestinationId: "bank_1", finalizeImmediately: true };
  const creationBodyHash = hashDigitalMetalsOrderBody({ ...req.body, assistedPayout: { method: "BANK", bankDestinationId: "bank_1" } });
  fixture(t, { row: { ...order, creationBodyHash } });
  assert.equal((await createSellOrder(req, opts)).payable.id, "payable_1");
});
test("counter placement durable retry binds payout method and destination", async (t) => {
  const creationBodyHash = hashDigitalMetalsOrderBody({ ...req.body, assistedPayout: { method: "BANK", bankDestinationId: "bank_1" } });
  fixture(t, { row: { ...order, creationBodyHash } });
  await assert.rejects(createSellOrder(req, { assisted: {}, payoutMethod: "CASH", finalizeImmediately: true }), { code: "IDEMPOTENCY_KEY_REUSED" });
});
