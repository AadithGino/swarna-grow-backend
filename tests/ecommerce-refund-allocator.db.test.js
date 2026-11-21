/**
 * Database-backed checks for payment ownership, refund identity and the refund allocator:
 * the unique indexes, real transactions, and the concurrency guard. The pure allocation rules
 * are covered without a database in ecommerce-refund-allocator.unit.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  EcommerceOrder,
  EcommerceOrderCancellationRequest,
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
} from "../src/models/index.js";
import { withTransaction } from "../src/lib/transaction.js";
import { reserveCaptureRefund, reserveOrderRefunds } from "../src/lib/ecommerce-refund-allocator.js";
import { confirmPaymentExceptionRefundFromProvider } from "../src/services/ecommerce-payment-exception-refund.service.js";
import { claimManualRefund } from "../src/lib/ecommerce-manual-refund.js";
import { resetTestDb } from "./helpers/db.js";

const TENANT = "refund-tenant";
const rupees = (n) => n * 100;

test.beforeEach(resetTestDb);

async function capture(id, amountPaise, fields = {}) {
  return EcommercePaymentAttempt.create({
    _id: id, tenantId: TENANT, customerId: "cust1", amountPaise, status: "SUCCEEDED",
    merchantOrderId: `m-${id}`, providerPaymentId: `pp-${id}`, ...fields,
  });
}
const advanceOf = (id, amountPaise, bookingId = "bk1") =>
  capture(id, amountPaise, { bookingId, purpose: "BOOKING_ADVANCE" });
const balanceOf = (id, amountPaise, bookingId = "bk1") =>
  capture(id, amountPaise, { bookingId, purpose: "BOOKING_BALANCE" });

const bookingOrder = (allocations, totalPaise) => ({
  _id: "ord1", tenantId: TENANT, totalPaise, paymentAllocations: allocations,
});
const reserveInTx = (order, amountPaise, operationId, refundSource = "ORDER_RETURN", extra = {}) =>
  withTransaction((session) =>
    reserveOrderRefunds({ tenantId: TENANT, order, amountPaise, operationId, refundSource, extra, session }));

test("a v17 order (no allocations, no purpose) cancels through the allocator against its one capture", async () => {
  await capture("att1", rupees(40_000), { orderId: "ord0" });
  await EcommercePaymentAttempt.collection.updateOne({ _id: "att1" }, { $unset: { purpose: "" } }); // as stored by v17
  const legacy = { _id: "ord0", tenantId: TENANT, totalPaise: rupees(40_000), successfulPaymentAttemptId: "att1" };

  const first = await reserveInTx(legacy, rupees(40_000), "cancel:c1", "ORDER_CANCELLATION", { cancellationRequestId: "c1" });
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].amountPaise, rupees(40_000));
  const replay = await reserveInTx(legacy, rupees(40_000), "cancel:c1", "ORDER_CANCELLATION", { cancellationRequestId: "c1" });
  assert.equal(replay.created, false);
  assert.equal(await EcommercePaymentExceptionRefund.countDocuments({ tenantId: TENANT }), 1);
});

test("excess-advance refund then cancellation on the same capture: both rows coexist, replays reuse them", async () => {
  await advanceOf("adv", rupees(25_000));
  const order = bookingOrder([{ paymentAttemptId: "adv", purpose: "BOOKING_ADVANCE", appliedPaise: rupees(20_000) }], rupees(20_000));

  const excessArgs = { tenantId: TENANT, paymentAttemptId: "adv", amountPaise: rupees(5_000),
    operationId: "excess:bk1", refundSource: "BOOKING_EXCESS_ADVANCE", orderId: "ord1" };
  await withTransaction((session) => reserveCaptureRefund({ ...excessArgs, session }));
  await reserveInTx(order, rupees(20_000), "cancel:c1", "ORDER_CANCELLATION", { cancellationRequestId: "c1" });

  // Replay both operations: nothing new is written.
  await withTransaction((session) => reserveCaptureRefund({ ...excessArgs, session }));
  await reserveInTx(order, rupees(20_000), "cancel:c1", "ORDER_CANCELLATION", { cancellationRequestId: "c1" });

  const rows = await EcommercePaymentExceptionRefund.find({ tenantId: TENANT, paymentAttemptId: "adv" }).lean();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.refundOperationId).sort(), ["cancel:c1", "excess:bk1"]);
  assert.ok(rows.reduce((sum, row) => sum + row.amountPaise, 0) <= rupees(25_000));

  // The old order+capture unique index is gone: a second operation on the capture is not a duplicate key.
  // Only the same operation on the same capture is.
  await assert.rejects(
    EcommercePaymentExceptionRefund.collection.insertOne({
      _id: "dup", tenantId: TENANT, paymentAttemptId: "adv", orderId: "ord1", amountPaise: 1,
      refundOperationId: "excess:bk1", status: "ASSIGNED",
    }),
    { code: 11000 },
  );
});

test("a return on a booking order refunds the balance first and spans both captures", async () => {
  await advanceOf("adv", rupees(25_000));
  await balanceOf("bal", rupees(75_000));
  const order = bookingOrder([
    { paymentAttemptId: "adv", purpose: "BOOKING_ADVANCE", appliedPaise: rupees(25_000) },
    { paymentAttemptId: "bal", purpose: "BOOKING_BALANCE", appliedPaise: rupees(75_000) },
  ], rupees(100_000));
  const small = await reserveInTx(order, rupees(30_000), "return:r1");
  assert.deepEqual(small.rows.map((row) => [row.paymentAttemptId, row.amountPaise]), [["bal", rupees(30_000)]]);
  const big = await reserveInTx(order, rupees(60_000), "return:r2");
  assert.deepEqual(big.rows.map((row) => [row.paymentAttemptId, row.amountPaise]).sort(),
    [["adv", rupees(15_000)], ["bal", rupees(45_000)]]);
  assert.ok(big.rows.every((row) => row.bookingId === "bk1"));
});

test("two refunds racing for the same capture cannot both succeed", async () => {
  await capture("att1", rupees(1_000), { orderId: "ord0" });
  const order = { _id: "ord0", tenantId: TENANT, totalPaise: rupees(1_000), successfulPaymentAttemptId: "att1" };
  const results = await Promise.allSettled([
    reserveInTx(order, rupees(700), "return:rA"),
    reserveInTx(order, rupees(700), "return:rB"),
  ]);
  const ok = results.filter((result) => result.status === "fulfilled");
  const refused = results.filter((result) => result.status === "rejected");
  assert.equal(ok.length, 1, JSON.stringify(results.map((result) => result.reason?.code ?? result.status)));
  assert.equal(refused[0].reason.code, "REFUND_EXCEEDS_CAPTURED");
  const rows = await EcommercePaymentExceptionRefund.find({ tenantId: TENANT, paymentAttemptId: "att1" }).lean();
  assert.equal(rows.reduce((sum, row) => sum + row.amountPaise, 0), rupees(700));
});

test("booking attempts with no order do not collide, and active attempts stay unique per owner", async () => {
  const pending = (id, fields) => EcommercePaymentAttempt.create({
    _id: id, tenantId: TENANT, customerId: "cust1", amountPaise: 100, status: "PENDING", ...fields,
  });
  // Under the old order-only partial index both of these would have collided on a null orderId.
  await pending("b1-adv", { bookingId: "bk1", purpose: "BOOKING_ADVANCE" });
  await pending("b2-adv", { bookingId: "bk2", purpose: "BOOKING_ADVANCE" });
  // Same booking, different purpose: allowed. Same booking and purpose, both active: refused.
  await pending("b1-bal", { bookingId: "bk1", purpose: "BOOKING_BALANCE" });
  await assert.rejects(pending("b1-adv-2", { bookingId: "bk1", purpose: "BOOKING_ADVANCE" }), { code: 11000 });
  // Ordinary checkout is unchanged: one active attempt per order.
  await pending("o1-a", { orderId: "ord1" });
  await assert.rejects(pending("o1-b", { orderId: "ord1" }), { code: 11000 });
  await EcommercePaymentAttempt.updateOne({ _id: "o1-a" }, { $set: { status: "FAILED" } });
  await pending("o1-c", { orderId: "ord1" });
});

test("payment rows with neither an order nor a booking are refused", async () => {
  await assert.rejects(EcommercePaymentAttempt.create({ tenantId: TENANT, customerId: "c", amountPaise: 100 }), /orderId or a bookingId/);
});

test("refunds are refused against a payment that was never captured", async () => {
  await advanceOf("adv", rupees(25_000), "bk1");
  await EcommercePaymentAttempt.collection.updateOne({ _id: "adv" }, { $set: { status: "PENDING" } });
  const args = { tenantId: TENANT, paymentAttemptId: "adv", amountPaise: rupees(5_000),
    operationId: "expire:bk1", refundSource: "BOOKING_EXPIRY" };
  for (const status of ["PENDING", "INITIATED", "FAILED", "EXPIRED", "CANCELLED"]) {
    await EcommercePaymentAttempt.collection.updateOne({ _id: "adv" }, { $set: { status } });
    await assert.rejects(
      withTransaction((session) => reserveCaptureRefund({ ...args, session })),
      { code: "REFUND_PAYMENT_NOT_CAPTURED" },
      status,
    );
  }
  assert.equal(await EcommercePaymentExceptionRefund.countDocuments({ tenantId: TENANT }), 0);

  // The same applies to an order allocation that points at an uncaptured attempt.
  const order = bookingOrder([{ paymentAttemptId: "adv", purpose: "BOOKING_ADVANCE", appliedPaise: rupees(25_000) }], rupees(25_000));
  await assert.rejects(reserveInTx(order, rupees(1_000), "return:r1"), { code: "REFUND_PAYMENT_NOT_CAPTURED" });

  // Once captured it is refundable.
  await EcommercePaymentAttempt.collection.updateOne({ _id: "adv" }, { $set: { status: "SUCCEEDED" } });
  const ok = await withTransaction((session) => reserveCaptureRefund({ ...args, session }));
  assert.equal(ok.rows.length, 1);
});

test("refund settlements racing across captures still complete the cancellation", async () => {
  await advanceOf("adv", rupees(25_000), "bk1");
  await balanceOf("bal", rupees(75_000), "bk1");
  const order = bookingOrder([
    { paymentAttemptId: "adv", purpose: "BOOKING_ADVANCE", appliedPaise: rupees(25_000) },
    { paymentAttemptId: "bal", purpose: "BOOKING_BALANCE", appliedPaise: rupees(75_000) },
  ], rupees(100_000));
  await EcommerceOrder.collection.insertOne({ _id: "ord1", tenantId: TENANT, status: "REFUND_PENDING", version: 1 });
  const { rows } = await reserveInTx(order, rupees(100_000), "cancel:c1", "ORDER_CANCELLATION", { cancellationRequestId: "c1" });
  assert.equal(rows.length, 2);
  await EcommerceOrderCancellationRequest.collection.insertOne({
    _id: "c1", tenantId: TENANT, orderId: "ord1", status: "APPROVED_PROCESSING",
    onlineRefundId: rows[0]._id, onlineRefundIds: rows.map((row) => row._id), version: 1,
  });
  await EcommerceOrder.collection.updateOne({ _id: "ord1" }, { $set: { activeCancellationRequestId: "c1" } });

  const settle = (row) => withTransaction((session) => confirmPaymentExceptionRefundFromProvider({
    tenantId: TENANT, orderId: "ord1", refundCaseId: row._id, providerRefundId: `rfnd-${row._id}`,
    amountPaise: row.amountPaise, currency: "INR", providerPayload: { id: `rfnd-${row._id}` }, session,
  }));
  const results = await Promise.all(rows.map(settle));
  assert.deepEqual(results.map((result) => result.outcome), ["SUCCEEDED", "SUCCEEDED"]);

  const settled = await EcommercePaymentExceptionRefund.find({ tenantId: TENANT }).lean();
  assert.ok(settled.every((row) => row.status === "SUCCEEDED"));
  const request = await EcommerceOrderCancellationRequest.findById("c1").lean();
  assert.equal(request.status, "COMPLETED");
  const after = await EcommerceOrder.findById("ord1").lean();
  assert.equal(after.status, "REFUNDED");
  assert.equal(after.activeCancellationRequestId, undefined);
});

test("a manual claim on a FAILED refund is refused, and rolled back, if its capacity was taken meanwhile", async () => {
  await capture("att1", rupees(1_000), { orderId: "ord0" });
  const row = (id, status, operationId) => EcommercePaymentExceptionRefund.collection.insertOne({
    _id: id, tenantId: TENANT, orderId: "ord0", paymentAttemptId: "att1", amountPaise: rupees(700), status,
    refundSource: "ORDER_RETURN", refundOperationId: operationId, purpose: "ORDER_CHECKOUT",
  });
  await row("epayref_failed", "FAILED", "return:rA");
  await row("epayref_other", "ASSIGNED", "return:rB"); // took the capacity the failed row freed

  const claim = () => withTransaction((session) => claimManualRefund(session, {
    tenantId: TENANT, orderId: "ord0", refundId: "epayref_failed", reference: "UTR1", userId: "staff1",
  }));
  await assert.rejects(claim(), { code: "REFUND_CAPACITY_CONSUMED" });
  assert.equal((await EcommercePaymentExceptionRefund.findById("epayref_failed").lean()).status, "FAILED");

  // Once the competing refund fails, the same claim succeeds.
  await EcommercePaymentExceptionRefund.collection.updateOne({ _id: "epayref_other" }, { $set: { status: "FAILED" } });
  const claimed = await claim();
  assert.equal(claimed.status, "MANUAL_RECORDED");
});

test("a manual claim on an ASSIGNED refund is unaffected by the capacity check", async () => {
  await capture("att1", rupees(1_000), { orderId: "ord0" });
  await EcommercePaymentExceptionRefund.collection.insertOne({
    _id: "epayref_a", tenantId: TENANT, orderId: "ord0", paymentAttemptId: "att1", amountPaise: rupees(1_000),
    status: "ASSIGNED", refundSource: "ORDER_RETURN", refundOperationId: "return:rA", purpose: "ORDER_CHECKOUT",
  });
  const claimed = await withTransaction((session) => claimManualRefund(session, {
    tenantId: TENANT, orderId: "ord0", refundId: "epayref_a", reference: "UTR2", userId: "staff1",
  }));
  assert.equal(claimed.status, "MANUAL_RECORDED");
});
