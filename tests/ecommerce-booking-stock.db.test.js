/**
 * Stock ownership for advance bookings: a booking hold counts in SKU availability, survives the
 * quote and order expiry paths, and is released or converted only by the booking lifecycle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EcommerceInventory, EcommerceOrder, EcommerceStockReservation } from "../src/models/index.js";
import { withTransaction } from "../src/lib/transaction.js";
import { loadInventoryAvailability } from "../src/lib/ecommerce-inventory.js";
import {
  releaseExpiredStockReservations,
  releaseQuoteReservations,
  reserveStockForQuote,
} from "../src/lib/ecommerce-stock-reserve.js";
import {
  releaseBookingHolds,
  reserveStockForBooking,
  transferBookingHoldsToOrder,
} from "../src/lib/ecommerce-booking-stock.js";
import { consumeOrderStockReservationsOnce } from "../src/lib/ecommerce-order-lifecycle.js";
import { resetTestDb } from "./helpers/db.js";

const TENANT = "stock-tenant";
const HOUR = 3_600_000;
const inFuture = (ms) => new Date(Date.now() + ms);

test.beforeEach(resetTestDb);

async function tracked(productId, quantityOnHand) {
  await EcommerceInventory.create({
    _id: `inv-${productId}`, tenantId: TENANT, productId, stockPolicy: "QUANTITY_TRACKED", quantityOnHand,
  });
}
const availableOf = (productId) =>
  loadInventoryAvailability(TENANT, productId).then((entry) => entry.availableQuantity);
const hold = (bookingId, productId, holdExpiresAt = inFuture(24 * HOUR)) =>
  withTransaction((session) => reserveStockForBooking({ tenantId: TENANT, bookingId, productId, holdExpiresAt, session }));

test("a booking hold takes the only unit and a second booking or a quote cannot reserve it", async () => {
  await tracked("p1", 1);
  const first = await hold("bk1", "p1");
  assert.equal(first.created, true);
  assert.equal(await availableOf("p1"), 0);

  await assert.rejects(hold("bk2", "p1"), { code: "INSUFFICIENT_STOCK" });
  await assert.rejects(
    withTransaction((session) => reserveStockForQuote({
      tenantId: TENANT, quoteId: "q1", lines: [{ productId: "p1", quantity: 1 }], expiresAt: inFuture(HOUR), session,
    })),
    { code: "INSUFFICIENT_STOCK" },
  );
});

test("replaying the same booking hold writes nothing new", async () => {
  await tracked("p1", 3);
  const first = await hold("bk1", "p1");
  const replay = await hold("bk1", "p1");
  assert.equal(replay.created, false);
  assert.equal(replay.reservation._id, first.reservation._id);
  assert.equal(await EcommerceStockReservation.countDocuments({ tenantId: TENANT, bookingId: "bk1" }), 1);
  assert.equal(await availableOf("p1"), 2);
});

test("two bookings racing for the last unit: exactly one holds it", async () => {
  await tracked("p1", 1);
  const results = await Promise.allSettled([hold("bkA", "p1"), hold("bkB", "p1")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1,
    JSON.stringify(results.map((result) => result.reason?.code ?? result.status)));
  assert.equal(await EcommerceStockReservation.countDocuments({ tenantId: TENANT, releasedAt: null }), 1);
});

test("only quantity-tracked SKUs can be held", async () => {
  await EcommerceInventory.create({ _id: "inv-mto", tenantId: TENANT, productId: "mto", stockPolicy: "MADE_TO_ORDER" });
  await assert.rejects(hold("bk1", "mto"), { code: "BOOKING_SKU_NOT_TRACKED" });
  await assert.rejects(hold("bk1", "no-such-sku"), { code: "BOOKING_SKU_NOT_TRACKED" });
});

test("quote and order expiry leave a booking hold alone, even past its expiresAt", async () => {
  await tracked("p1", 1);
  await hold("bk1", "p1", inFuture(-HOUR)); // expiresAt already in the past

  // The time-based sweep that quote reservation runs does not release it.
  await withTransaction((session) => releaseExpiredStockReservations(TENANT, session));
  // Releasing a quote does not release it either.
  await withTransaction((session) => releaseQuoteReservations(TENANT, "q1", session));

  const row = await EcommerceStockReservation.findOne({ tenantId: TENANT, bookingId: "bk1" }).lean();
  assert.equal(row.releasedAt ?? null, null);
  // And it still counts: an overdue booking does not free the SKU for anyone else.
  assert.equal(await availableOf("p1"), 0);
});

test("a quote reservation past its expiresAt stops counting, as before", async () => {
  await tracked("p1", 1);
  await EcommerceStockReservation.create({
    _id: "ersv-q", tenantId: TENANT, productId: "p1", quoteId: "q1", quantity: 1, expiresAt: inFuture(-HOUR),
  });
  assert.equal(await availableOf("p1"), 1);
});

test("releasing a booking frees the SKU and is idempotent", async () => {
  await tracked("p1", 1);
  await hold("bk1", "p1");
  const first = await withTransaction((session) => releaseBookingHolds({ tenantId: TENANT, bookingId: "bk1", session }));
  const second = await withTransaction((session) => releaseBookingHolds({ tenantId: TENANT, bookingId: "bk1", session }));
  assert.equal(first.releasedCount, 1);
  assert.equal(second.releasedCount, 0);
  assert.equal(await availableOf("p1"), 1);
  // The freed unit can be booked again.
  assert.equal((await hold("bk2", "p1")).created, true);
});

test("releasing one booking does not touch another's hold", async () => {
  await tracked("p1", 2);
  await hold("bk1", "p1");
  await hold("bk2", "p1");
  await withTransaction((session) => releaseBookingHolds({ tenantId: TENANT, bookingId: "bk1", session }));
  assert.equal(await availableOf("p1"), 1);
  const other = await EcommerceStockReservation.findOne({ tenantId: TENANT, bookingId: "bk2" }).lean();
  assert.equal(other.releasedAt ?? null, null);
});

test("conversion hands the hold to the order, which then consumes it like any paid order", async () => {
  await tracked("p1", 1);
  // The order created at conversion; consumption writes its evidence onto this document.
  await EcommerceOrder.collection.insertOne({ _id: "ord1", tenantId: TENANT, status: "PENDING_PAYMENT", version: 1 });
  await hold("bk1", "p1");
  await withTransaction((session) => transferBookingHoldsToOrder({
    tenantId: TENANT, bookingId: "bk1", orderId: "ord1", expiresAt: inFuture(HOUR), session,
  }));
  const moved = await EcommerceStockReservation.findOne({ tenantId: TENANT, bookingId: "bk1" }).lean();
  assert.equal(moved.orderId, "ord1");

  // A converted hold is no longer a booking hold: booking release leaves it, order consumption takes it.
  const none = await withTransaction((session) => releaseBookingHolds({ tenantId: TENANT, bookingId: "bk1", session }));
  assert.equal(none.releasedCount, 0);
  await withTransaction((session) => consumeOrderStockReservationsOnce({ tenantId: TENANT, orderId: "ord1", session }));
  const inventory = await EcommerceInventory.findOne({ tenantId: TENANT, productId: "p1" }).lean();
  assert.equal(inventory.quantityOnHand, 0);
  assert.equal(await availableOf("p1"), 0);
  const consumed = await EcommerceStockReservation.findOne({ tenantId: TENANT, bookingId: "bk1" }).lean();
  assert.ok(consumed.releasedAt);

  // Converting a booking that has no live hold is refused rather than creating an order without stock.
  await assert.rejects(
    withTransaction((session) => transferBookingHoldsToOrder({
      tenantId: TENANT, bookingId: "bk1", orderId: "ord2", expiresAt: inFuture(HOUR), session,
    })),
    { code: "BOOKING_HOLD_MISSING" },
  );
});

test("a reservation cannot belong to both a quote and a booking", async () => {
  await assert.rejects(
    EcommerceStockReservation.create({
      _id: "ersv-x", tenantId: TENANT, productId: "p1", quoteId: "q1", bookingId: "bk1", quantity: 1, expiresAt: inFuture(HOUR),
    }),
    /quote or a booking/,
  );
});
