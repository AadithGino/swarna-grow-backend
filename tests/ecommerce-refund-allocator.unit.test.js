/**
 * Logic-level tests for payment ownership, order allocations and the refund allocator.
 * They need no database: the refund and attempt models are replaced by an in-memory store, and
 * schema rules are checked through Mongoose validation and index metadata. The index and
 * transaction behaviour itself is covered in ecommerce-refund-allocator.db.test.js.
 *
 * Run alone: NODE_ENV=test node --test tests/ecommerce-refund-allocator.unit.test.js
 */
import test, { afterEach, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  EcommerceOrder,
  EcommercePaymentAttempt,
  EcommercePaymentAttemptEvent,
  EcommercePaymentExceptionRefund,
} from "../src/models/index.js";
import {
  CAPACITY_CONSUMING_REFUND_STATUSES,
  compareCapturesForRefund,
  planRefundAllocations,
  reserveCapacityForRefundRetry,
  reserveCaptureRefund,
  reserveOrderRefunds,
} from "../src/lib/ecommerce-refund-allocator.js";
import {
  ORDER_CHECKOUT_PURPOSE_FILTER,
  isBookingPayment,
  orderOwnsPaymentAttempt,
  resolveOrderPaymentAllocations,
  resolvePaymentPurpose,
} from "../src/lib/ecommerce-payment-allocations.js";

const TENANT = "tenant-a";
const rupees = (n) => n * 100;

// ---------- in-memory stand-ins for the two collections the allocator touches ----------

function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((part) => matches(doc, part));
    if (value && typeof value === "object" && "$in" in value) return value.$in.includes(doc[key]);
    return (doc[key] ?? null) === value;
  });
}

let attempts;
let refunds;

function chain(resolve) {
  const query = {
    session: () => query,
    sort: () => query,
    lean: () => query, // like a Mongoose Query: still chainable, awaited through then()
    then: (ok, fail) => Promise.resolve(resolve()).then(ok, fail),
  };
  return query;
}

beforeEach(() => {
  attempts = new Map();
  refunds = [];
  mock.method(EcommercePaymentAttempt, "findOne", (filter) => chain(() => {
    const row = [...attempts.values()].find((attempt) => matches(attempt, filter));
    return row ? { ...row } : null;
  }));
  mock.method(EcommercePaymentAttempt, "findOneAndUpdate", (filter, update) => chain(() => {
    const row = [...attempts.values()].find((attempt) => matches(attempt, filter));
    if (!row) return null;
    row.refundCapacityLockSeq = (row.refundCapacityLockSeq ?? 0) + (update.$inc?.refundCapacityLockSeq ?? 0);
    return { ...row };
  }));
  mock.method(EcommercePaymentExceptionRefund, "find", (filter) => chain(() =>
    refunds.filter((row) => matches(row, filter)).map((row) => ({ ...row }))));
  mock.method(EcommercePaymentExceptionRefund, "insertMany", async (docs) => {
    for (const doc of docs) {
      const clash = refunds.find((row) => row.refundOperationId === doc.refundOperationId
        && row.paymentAttemptId === doc.paymentAttemptId && row.tenantId === doc.tenantId);
      if (clash) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    }
    refunds.push(...docs.map((doc) => ({ ...doc })));
    return docs.map((doc) => ({ toObject: () => ({ ...doc }) }));
  });
});
afterEach(() => mock.restoreAll());

function addAttempt(id, amountPaise, extra = {}) {
  attempts.set(id, {
    _id: id, tenantId: TENANT, amountPaise, currency: "INR", merchantOrderId: `m-${id}`,
    providerPaymentId: `pp-${id}`, status: "SUCCEEDED", ...extra,
  });
}
const advance = (id, amountPaise) => addAttempt(id, amountPaise, { bookingId: "bk1", purpose: "BOOKING_ADVANCE" });
const balance = (id, amountPaise) => addAttempt(id, amountPaise, { bookingId: "bk1", purpose: "BOOKING_BALANCE" });

const bookingOrder = (allocations, totalPaise) => ({
  _id: "ord1", tenantId: TENANT, totalPaise, paymentAllocations: allocations,
  successfulPaymentAttemptId: allocations.at(-1)?.paymentAttemptId,
});
const reserve = (order, amountPaise, operationId, refundSource = "ORDER_RETURN", extra = {}) =>
  reserveOrderRefunds({ tenantId: TENANT, order, amountPaise, operationId, refundSource, extra, session: {} });
const amounts = (rows) => rows.map((row) => [row.paymentAttemptId, row.amountPaise]);

// ---------- pure planner: balance first, then advance ----------

test("planner refunds the balance capture first and the advance last", () => {
  const captures = [
    { paymentAttemptId: "adv", purpose: "BOOKING_ADVANCE", availablePaise: rupees(25_000) },
    { paymentAttemptId: "bal", purpose: "BOOKING_BALANCE", availablePaise: rupees(75_000) },
  ];
  const partial = planRefundAllocations({ captures, amountPaise: rupees(30_000) });
  assert.deepEqual(partial.allocations.map((a) => [a.paymentAttemptId, a.amountPaise]), [["bal", rupees(30_000)]]);
  assert.equal(partial.shortfallPaise, 0);

  const larger = planRefundAllocations({ captures, amountPaise: rupees(90_000) });
  assert.deepEqual(larger.allocations.map((a) => [a.paymentAttemptId, a.amountPaise]),
    [["bal", rupees(75_000)], ["adv", rupees(15_000)]]);
});

test("planner reports what no capture can cover and skips empty captures", () => {
  const plan = planRefundAllocations({
    captures: [
      { paymentAttemptId: "bal", purpose: "BOOKING_BALANCE", availablePaise: 0 },
      { paymentAttemptId: "adv", purpose: "BOOKING_ADVANCE", availablePaise: 500 },
    ],
    amountPaise: 800,
  });
  assert.deepEqual(plan.allocations.map((a) => [a.paymentAttemptId, a.amountPaise]), [["adv", 500]]);
  assert.equal(plan.shortfallPaise, 300);
});

test("capture ordering is balance, ordinary checkout, then advance, ties broken by id", () => {
  const rows = [
    { paymentAttemptId: "b", purpose: "BOOKING_ADVANCE" },
    { paymentAttemptId: "z", purpose: "ORDER_CHECKOUT" },
    { paymentAttemptId: "a", purpose: "ORDER_CHECKOUT" },
    { paymentAttemptId: "c", purpose: "BOOKING_BALANCE" },
  ];
  assert.deepEqual(rows.sort(compareCapturesForRefund).map((r) => r.paymentAttemptId), ["c", "a", "z", "b"]);
});

test("capacity statuses: pending and unknown outcomes hold capacity, only FAILED frees it", () => {
  assert.deepEqual([...CAPACITY_CONSUMING_REFUND_STATUSES].sort(),
    ["ASSIGNED", "INITIATED", "MANUAL_RECORDED", "PROVIDER_PENDING", "SUCCEEDED"]);
  assert.ok(!CAPACITY_CONSUMING_REFUND_STATUSES.includes("FAILED"));
});

// ---------- legacy orders ----------

test("a v17 order with no allocations and no purpose still resolves one capture and refunds in full", async () => {
  addAttempt("att1", rupees(40_000)); // no purpose field, like every v17 row
  const legacy = { _id: "ord0", tenantId: TENANT, totalPaise: rupees(40_000), successfulPaymentAttemptId: "att1" };

  assert.equal(resolvePaymentPurpose(attempts.get("att1")), "ORDER_CHECKOUT");
  assert.equal(isBookingPayment(attempts.get("att1")), false);
  assert.deepEqual(ORDER_CHECKOUT_PURPOSE_FILTER, { purpose: { $in: [null, "ORDER_CHECKOUT"] } });
  assert.deepEqual(await resolveOrderPaymentAllocations(legacy), [
    { paymentAttemptId: "att1", purpose: "ORDER_CHECKOUT", appliedPaise: rupees(40_000), legacy: true },
  ]);

  const { rows, created } = await reserve(legacy, rupees(40_000), "cancel:c1", "ORDER_CANCELLATION", { cancellationRequestId: "c1" });
  assert.equal(created, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paymentAttemptId, "att1");
  assert.equal(rows[0].amountPaise, rupees(40_000));
  assert.equal(rows[0].orderId, "ord0");
  assert.equal(rows[0].status, "ASSIGNED");
  assert.equal(rows[0].cancellationRequestId, "c1");
  assert.equal(rows[0].bookingId, undefined);
});

test("a legacy order with no captured payment is not refundable online", async () => {
  await assert.rejects(reserve({ _id: "o", tenantId: TENANT, totalPaise: 100 }, 100, "cancel:x"),
    { code: "REFUND_NOT_APPLICABLE" });
});

test("legacy partial returns keep working and cannot exceed the capture", async () => {
  addAttempt("att1", rupees(1_000));
  const legacy = { _id: "ord0", tenantId: TENANT, totalPaise: rupees(1_000), successfulPaymentAttemptId: "att1" };
  await reserve(legacy, rupees(400), "return:r1");
  await reserve(legacy, rupees(500), "return:r2");
  await assert.rejects(reserve(legacy, rupees(200), "return:r3"), { code: "REFUND_EXCEEDS_CAPTURED" });
  assert.equal(refunds.length, 2);
});

// ---------- booking orders: split payments ----------

test("a return on a booking order spans both captures, balance first, and replays do not double up", async () => {
  advance("adv", rupees(25_000));
  balance("bal", rupees(75_000));
  const order = bookingOrder([
    { paymentAttemptId: "adv", purpose: "BOOKING_ADVANCE", appliedPaise: rupees(25_000) },
    { paymentAttemptId: "bal", purpose: "BOOKING_BALANCE", appliedPaise: rupees(75_000) },
  ], rupees(100_000));

  const first = await reserve(order, rupees(30_000), "return:r1");
  assert.deepEqual(amounts(first.rows), [["bal", rupees(30_000)]]);
  assert.equal(first.rows[0].bookingId, "bk1");
  assert.equal(first.rows[0].purpose, "BOOKING_BALANCE");

  // 45,000 is left on the balance, so a 60,000 return takes 45,000 there and 15,000 from the advance.
  const second = await reserve(order, rupees(60_000), "return:r2");
  assert.deepEqual(amounts(second.rows), [["bal", rupees(45_000)], ["adv", rupees(15_000)]]);

  const replay = await reserve(order, rupees(60_000), "return:r2");
  assert.equal(replay.created, false);
  assert.deepEqual(amounts(replay.rows).sort(), amounts(second.rows).sort());
  assert.equal(refunds.length, 3);

  await assert.rejects(reserve(order, rupees(60_000), "return:r2-changed-amount-other-op"), { code: "REFUND_EXCEEDS_CAPTURED" });
  await assert.rejects(reserve(order, rupees(50_000), "return:r2"), { code: "REFUND_OPERATION_AMOUNT_CHANGED" });
});

test("pending refunds hold capacity; a confirmed FAILED row frees it and a retry takes it back", async () => {
  advance("adv", rupees(25_000));
  balance("bal", rupees(75_000));
  const order = bookingOrder([
    { paymentAttemptId: "adv", purpose: "BOOKING_ADVANCE", appliedPaise: rupees(25_000) },
    { paymentAttemptId: "bal", purpose: "BOOKING_BALANCE", appliedPaise: rupees(75_000) },
  ], rupees(100_000));
  await reserve(order, rupees(100_000), "cancel:c1", "ORDER_CANCELLATION", { cancellationRequestId: "c1" });
  assert.equal(refunds.length, 2);

  // Everything is held, whatever the provider outcome so far.
  for (const status of ["ASSIGNED", "INITIATED", "PROVIDER_PENDING", "SUCCEEDED", "MANUAL_RECORDED"]) {
    refunds.forEach((row) => { row.status = status; });
    await assert.rejects(reserve(order, 1, "return:extra"), { code: "REFUND_EXCEEDS_CAPTURED" });
  }

  // The balance refund fails for certain: its capacity is free again.
  refunds.forEach((row) => { row.status = "SUCCEEDED"; });
  const failed = refunds.find((row) => row.paymentAttemptId === "bal");
  failed.status = "FAILED";
  await reserveCapacityForRefundRetry({ tenantId: TENANT, refundRow: failed, session: {} }); // still free: retry allowed

  // Someone else takes the freed capacity first, so the retry must be refused.
  refunds.push({ _id: "other", tenantId: TENANT, paymentAttemptId: "bal", amountPaise: rupees(75_000),
    status: "ASSIGNED", refundSource: "PAYMENT_EXCEPTION", refundOperationId: "exception:bal" });
  await assert.rejects(reserveCapacityForRefundRetry({ tenantId: TENANT, refundRow: failed, session: {} }),
    { code: "REFUND_CAPACITY_CONSUMED" });
});

// ---------- the acceptance regression: excess advance, then cancel on the same capture ----------

test("an excess-advance refund and a later cancellation coexist on one capture within its amount", async () => {
  // 25,000 advance captured, final invoice only 20,000, no balance to pay: 5,000 is excess.
  advance("adv", rupees(25_000));
  const order = bookingOrder([{ paymentAttemptId: "adv", purpose: "BOOKING_ADVANCE", appliedPaise: rupees(20_000) }], rupees(20_000));

  const excess = await reserveCaptureRefund({
    tenantId: TENANT, paymentAttemptId: "adv", amountPaise: rupees(5_000), operationId: "excess:bk1",
    refundSource: "BOOKING_EXCESS_ADVANCE", orderId: "ord1", session: {},
  });
  assert.equal(excess.created, true);
  assert.equal(excess.rows[0].refundOperationId, "excess:bk1");

  // The order is then cancelled: its 20,000 refunds against the same advance capture.
  const cancel = await reserve(order, rupees(20_000), "cancel:c1", "ORDER_CANCELLATION", { cancellationRequestId: "c1" });
  assert.deepEqual(amounts(cancel.rows), [["adv", rupees(20_000)]]);

  const rowsOnCapture = refunds.filter((row) => row.paymentAttemptId === "adv");
  assert.equal(rowsOnCapture.length, 2, "both refund rows coexist on the advance capture");
  assert.deepEqual(rowsOnCapture.map((row) => row.refundOperationId).sort(), ["cancel:c1", "excess:bk1"]);
  assert.equal(rowsOnCapture.reduce((sum, row) => sum + row.amountPaise, 0), rupees(25_000));

  // Replays of both operations reuse their rows.
  const cancelReplay = await reserve(order, rupees(20_000), "cancel:c1", "ORDER_CANCELLATION", { cancellationRequestId: "c1" });
  const excessReplay = await reserveCaptureRefund({
    tenantId: TENANT, paymentAttemptId: "adv", amountPaise: rupees(5_000), operationId: "excess:bk1",
    refundSource: "BOOKING_EXCESS_ADVANCE", orderId: "ord1", session: {},
  });
  assert.equal(cancelReplay.created, false);
  assert.equal(excessReplay.created, false);
  assert.equal(refunds.filter((row) => row.paymentAttemptId === "adv").length, 2, "replays reuse the rows");

  // The capture is fully refunded: nothing more can come out of it, by either path.
  await assert.rejects(reserve(order, 1, "return:late"), { code: "REFUND_EXCEEDS_CAPTURED" });
  await assert.rejects(reserveCaptureRefund({
    tenantId: TENANT, paymentAttemptId: "adv", amountPaise: 1, operationId: "excess:other",
    refundSource: "BOOKING_EXCESS_ADVANCE", session: {},
  }), { code: "REFUND_EXCEEDS_CAPTURED" });
});

test("cancelling first and refunding the excess second also stays within the capture", async () => {
  advance("adv", rupees(25_000));
  const order = bookingOrder([{ paymentAttemptId: "adv", purpose: "BOOKING_ADVANCE", appliedPaise: rupees(20_000) }], rupees(20_000));
  await reserve(order, rupees(20_000), "cancel:c1", "ORDER_CANCELLATION", { cancellationRequestId: "c1" });
  await reserveCaptureRefund({ tenantId: TENANT, paymentAttemptId: "adv", amountPaise: rupees(5_000),
    operationId: "excess:bk1", refundSource: "BOOKING_EXCESS_ADVANCE", session: {} });
  await assert.rejects(reserveCaptureRefund({ tenantId: TENANT, paymentAttemptId: "adv", amountPaise: 1,
    operationId: "excess:again", refundSource: "BOOKING_EXCESS_ADVANCE", session: {} }), { code: "REFUND_EXCEEDS_CAPTURED" });
});

test("a booking that expires before conversion refunds the advance capture once", async () => {
  advance("adv", rupees(25_000));
  const args = { tenantId: TENANT, paymentAttemptId: "adv", amountPaise: rupees(25_000), operationId: "booking-expiry:bk1",
    refundSource: "BOOKING_EXPIRY", session: {} };
  const first = await reserveCaptureRefund(args);
  const replay = await reserveCaptureRefund(args);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].orderId, undefined, "no order exists yet");
  assert.equal(refunds[0].bookingId, "bk1");
});

test("legacy rows are found by the legacy lookup before the backfill has run", async () => {
  addAttempt("att1", rupees(500));
  refunds.push({ _id: "old", tenantId: TENANT, orderId: "ord0", paymentAttemptId: "att1", amountPaise: rupees(500),
    status: "ASSIGNED", refundSource: "ORDER_RETURN", returnRequestId: "r1" }); // no refundOperationId yet
  const legacy = { _id: "ord0", tenantId: TENANT, totalPaise: rupees(500), successfulPaymentAttemptId: "att1" };
  const result = await reserveOrderRefunds({
    tenantId: TENANT, order: legacy, amountPaise: rupees(500), operationId: "return:r1",
    refundSource: "ORDER_RETURN", extra: { returnRequestId: "r1" },
    legacyLookup: { orderId: "ord0", returnRequestId: "r1" }, session: {},
  });
  assert.equal(result.created, false);
  assert.equal(result.rows[0]._id, "old");
  assert.equal(refunds.length, 1);
});

test("refund amounts must be positive whole paise", async () => {
  addAttempt("att1", 1000);
  const legacy = { _id: "o", tenantId: TENANT, totalPaise: 1000, successfulPaymentAttemptId: "att1" };
  for (const bad of [0, -5, 10.5, Number.NaN]) {
    await assert.rejects(reserve(legacy, bad, `x:${bad}`), { code: "VALIDATION_FAILED" });
  }
});

test("orderOwnsPaymentAttempt recognises allocations as well as the compatibility field", () => {
  const order = bookingOrder([
    { paymentAttemptId: "adv", purpose: "BOOKING_ADVANCE", appliedPaise: 1 },
    { paymentAttemptId: "bal", purpose: "BOOKING_BALANCE", appliedPaise: 1 },
  ], 2);
  assert.equal(orderOwnsPaymentAttempt(order, "adv"), true);
  assert.equal(orderOwnsPaymentAttempt(order, "bal"), true);
  assert.equal(orderOwnsPaymentAttempt(order, "other"), false);
  assert.equal(orderOwnsPaymentAttempt({ successfulPaymentAttemptId: "x" }, "x"), true);
});

// ---------- schema rules (Mongoose validation and index metadata, no database) ----------

const validationError = async (doc) => doc.validate().then(() => null, (error) => error);

test("payment rows need an order or a booking owner", async () => {
  const base = { tenantId: TENANT, customerId: "c1", amountPaise: 100 };
  assert.match((await validationError(new EcommercePaymentAttempt({ ...base })))?.message ?? "", /orderId or a bookingId/);
  assert.equal(await validationError(new EcommercePaymentAttempt({ ...base, orderId: "o1" })), null);
  assert.equal(await validationError(new EcommercePaymentAttempt({ ...base, bookingId: "b1", purpose: "BOOKING_ADVANCE" })), null);

  assert.match((await validationError(new EcommercePaymentAttemptEvent({ tenantId: TENANT, paymentAttemptId: "a" })))?.message ?? "", /orderId or a bookingId/);
  assert.equal(await validationError(new EcommercePaymentAttemptEvent({ tenantId: TENANT, paymentAttemptId: "a", bookingId: "b1" })), null);

  const refund = { tenantId: TENANT, paymentAttemptId: "a", amountPaise: 100 };
  assert.match((await validationError(new EcommercePaymentExceptionRefund(refund)))?.message ?? "", /orderId or a bookingId/);
  assert.equal(await validationError(new EcommercePaymentExceptionRefund({ ...refund, bookingId: "b1" })), null);
  assert.equal(await validationError(new EcommercePaymentExceptionRefund({ ...refund, orderId: "o1" })), null);
});

test("legacy attempts default to ORDER_CHECKOUT and an active booking attempt cannot carry an orderId", async () => {
  const attempt = new EcommercePaymentAttempt({ tenantId: TENANT, customerId: "c1", amountPaise: 100, orderId: "o1" });
  assert.equal(attempt.purpose, "ORDER_CHECKOUT");
  const active = new EcommercePaymentAttempt({ tenantId: TENANT, customerId: "c1", amountPaise: 100, bookingId: "b1",
    purpose: "BOOKING_ADVANCE", orderId: "o1", status: "PENDING" });
  assert.match((await validationError(active))?.message ?? "", /active booking payment attempt/);
  const settled = new EcommercePaymentAttempt({ tenantId: TENANT, customerId: "c1", amountPaise: 100, bookingId: "b1",
    purpose: "BOOKING_BALANCE", orderId: "o1", status: "SUCCEEDED" });
  assert.equal(await validationError(settled), null);
});

test("order paymentAllocations must be unique by capture and sum to the invoice total", async () => {
  const base = { tenantId: TENANT, customerId: "c1", orderNumber: "ORD-1", totalPaise: 10_000 };
  const entry = (id, purpose, appliedPaise) => ({ paymentAttemptId: id, purpose, appliedPaise });
  assert.equal(await validationError(new EcommerceOrder({ ...base })), null, "legacy order without allocations");
  assert.equal(await validationError(new EcommerceOrder({ ...base,
    paymentAllocations: [entry("a", "BOOKING_ADVANCE", 2_500), entry("b", "BOOKING_BALANCE", 7_500)] })), null);
  assert.match((await validationError(new EcommerceOrder({ ...base,
    paymentAllocations: [entry("a", "BOOKING_ADVANCE", 2_500), entry("b", "BOOKING_BALANCE", 7_000)] })))?.message ?? "", /sum to the order total/);
  assert.match((await validationError(new EcommerceOrder({ ...base,
    paymentAllocations: [entry("a", "BOOKING_ADVANCE", 5_000), entry("a", "BOOKING_BALANCE", 5_000)] })))?.message ?? "", /unique/);
  // A zero-balance booking converts on the advance alone.
  assert.equal(await validationError(new EcommerceOrder({ ...base,
    paymentAllocations: [entry("a", "BOOKING_ADVANCE", 10_000)] })), null);
});

const indexByName = (model) => new Map(model.schema.indexes().map(([key, options]) => [options?.name, { key, options }]));

test("the retired unique refund indexes are gone and the operation-per-capture index replaces them", () => {
  const refundIndexes = indexByName(EcommercePaymentExceptionRefund);
  assert.ok(!refundIndexes.has("ecommerce_capture_refund_without_return_unique"));
  assert.ok(!refundIndexes.has("ecommerce_return_refund_unique"));
  const replacement = refundIndexes.get("ecommerce_refund_operation_capture_unique");
  assert.deepEqual(replacement.key, { tenantId: 1, refundOperationId: 1, paymentAttemptId: 1 });
  assert.equal(replacement.options.unique, true);
  const uniqueOthers = [...refundIndexes.values()].filter(({ options }) => options?.unique && options.name !== replacement.options.name);
  assert.deepEqual(uniqueOthers.map(({ key }) => key), [{ tenantId: 1, providerRefundId: 1 }]);
});

test("attempt indexes: active order index covers only order-owned attempts, plus a booking-purpose index", () => {
  const attemptIndexes = indexByName(EcommercePaymentAttempt);
  const order = attemptIndexes.get("ecommerce_attempt_active_order_unique");
  assert.deepEqual(order.options.partialFilterExpression.orderId, { $type: "string" });
  assert.deepEqual(order.options.partialFilterExpression.status, { $in: ["PENDING", "INITIATED"] });
  const booking = attemptIndexes.get("ecommerce_attempt_active_booking_purpose_unique");
  assert.deepEqual(booking.key, { tenantId: 1, bookingId: 1, purpose: 1 });
  assert.deepEqual(booking.options.partialFilterExpression.bookingId, { $type: "string" });
  // No unique index may still be keyed on the order alone without the orderId guard.
  const unguarded = [...attemptIndexes.values()].filter(({ key, options }) =>
    options?.unique && JSON.stringify(key) === JSON.stringify({ tenantId: 1, orderId: 1 })
    && !options.partialFilterExpression?.orderId);
  assert.equal(unguarded.length, 0);
});

test("capacity is never reserved against a payment that was not captured", async () => {
  addAttempt("pend", rupees(25_000), { bookingId: "bk1", purpose: "BOOKING_ADVANCE", status: "PENDING" });
  await assert.rejects(
    reserveCaptureRefund({ tenantId: TENANT, paymentAttemptId: "pend", amountPaise: rupees(5_000),
      operationId: "expire:bk1", refundSource: "BOOKING_EXPIRY", session: {} }),
    { code: "REFUND_PAYMENT_NOT_CAPTURED" },
  );
  await assert.rejects(
    reserve(bookingOrder([{ paymentAttemptId: "pend", purpose: "BOOKING_ADVANCE", appliedPaise: rupees(25_000) }], rupees(25_000)),
      rupees(1_000), "return:r1"),
    { code: "REFUND_PAYMENT_NOT_CAPTURED" },
  );
  assert.equal(refunds.length, 0);
});

test("a late-capture exception refund can still be retried while its attempt is not SUCCEEDED", async () => {
  addAttempt("late", rupees(1_000), { orderId: "o1", status: "EXPIRED" });
  const row = { _id: "r1", tenantId: TENANT, paymentAttemptId: "late", amountPaise: rupees(1_000), providerPaymentId: "pp-late",
    status: "FAILED", refundOperationId: "exception:late" };
  refunds.push(row);
  await reserveCapacityForRefundRetry({ tenantId: TENANT, refundRow: row, session: {} });
});
