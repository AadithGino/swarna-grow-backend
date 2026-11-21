/**
 * Booking lifecycle end to end. Captures arrive through the real webhook and provider-poll paths
 * and are applied by the real booking handlers, so expiry, initiation, reconciliation, finalization,
 * stock and refunds are exercised together rather than one at a time.
 */
import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  EcommerceBooking,
  EcommerceFulfilmentSettings,
  EcommerceGoldRate,
  EcommerceInventory,
  EcommerceOrder,
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
  EcommerceProduct,
  EcommerceStockReservation,
  EcommerceTaxSettings,
  Tenant,
  Branch,
} from "../src/models/index.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import { resetBookingPaymentHandlers } from "../src/lib/ecommerce-booking-payment-handlers.js";
import { processEcommercePhonePeWebhook } from "../src/services/ecommerce-payment-finalize.service.js";
import { processEcommercePhonePeRefundWebhook } from "../src/services/ecommerce-payment-exception-refund.service.js";
import { createPolicyDraft, publishPolicyVersion, setPolicyAssignment } from "../src/services/ecommerce-booking-policy.service.js";
import {
  cancelBooking,
  createBalanceQuote,
  createBooking,
  previewBooking,
  installBookingPaymentHandlers,
  renewBookingPaymentAttempt,
} from "../src/services/ecommerce-booking.service.js";
import { expireBooking, runEcommerceBookingExpiry } from "../src/services/ecommerce-booking-expiry.service.js";
import { claimManualRefund } from "../src/lib/ecommerce-manual-refund.js";
import { withTransaction } from "../src/lib/transaction.js";
import { resetTestDb } from "./helpers/db.js";
import { taxReadyCatalogBody, taxReadyCheckoutTaxConfig, taxReadyStorePolicies } from "./helpers/ecommerce-checkout-fixtures.js";

const T = "booklife-tenant";
const BR = "br1";
const HOUR = 3_600_000;
const rupees = (n) => n * 100;

// FIXED product: pre-tax 1,00,000.00 + 3% tax = 1,03,000.00. A 25% advance is 25,750.00.
const FIXED_TOTAL = rupees(103_000);
const FIXED_ADVANCE = rupees(25_750);

test.beforeEach(async () => {
  await resetTestDb();
  resetBookingPaymentHandlers();
  installBookingPaymentHandlers();
  await Tenant.collection.insertOne({ _id: T, name: "t", status: "ACTIVE" });
  await Branch.collection.insertOne({ _id: BR, tenantId: T, name: "Main branch" });
  await EcommerceTaxSettings.create({ tenantId: T, ...taxReadyCatalogBody() });
  await EcommerceFulfilmentSettings.create({
    tenantId: T, pickupEnabled: true, pickupBranchIds: [BR], pendingPaymentWindowMinutes: 30,
    checkoutTaxConfig: taxReadyCheckoutTaxConfig(), storePolicies: taxReadyStorePolicies(),
  });
});
afterEach(() => { mock.restoreAll(); resetBookingPaymentHandlers(); });

let seq = 0;
async function product(over = {}) {
  seq += 1;
  const p = await EcommerceProduct.create({
    tenantId: T, name: `Ring ${seq}`, slug: `ring-${seq}`, sku: `R-${seq}`, status: "PUBLISHED",
    priceMode: "FIXED", fixedPricing: { basePricePaise: rupees(100_000) },
    taxClassification: "GST_3", hsnSacCode: "7113", hsnSacType: "HSN", ...over,
  });
  await EcommerceInventory.create({ tenantId: T, productId: p._id, stockPolicy: "QUANTITY_TRACKED", quantityOnHand: 1 });
  return p.toObject();
}
const goldProduct = () => product({
  priceMode: "GOLD_RATE_BASED", fixedPricing: undefined, purity: "22K", goldWeightMg: 10_000,
  makingChargeMode: "PERCENT_OF_GOLD", makingCharge: { percentBps: 1000 },
});
const rate = (ratePerGramPaise, minutesAgo) =>
  EcommerceGoldRate.create({ tenantId: T, purity: "22K", ratePerGramPaise, effectiveAt: new Date(Date.now() - minutesAgo * 60_000) });

async function policy(over = {}) {
  const draft = await createPolicyDraft({
    tenantId: T, policyKey: `p${seq}-${Math.random()}`, name: "Standard",
    fields: {
      advance: { mode: "PERCENT", percentBps: 2500, minPaise: 0 }, rateRule: "BOOKED_RATE", rateProtectionHours: 48,
      advanceWindowMinutes: 30, balanceWindowHours: 72, eligiblePickupBranchIds: [], cancellationFeeBps: 1000,
      terms: { text: "Terms" }, ...over,
    },
  });
  const v = await publishPolicyVersion({ tenantId: T, policyVersionId: draft._id });
  await setPolicyAssignment({ tenantId: T, scopeType: "BRANCH", scopeId: BR, bookingEnabled: true, policyVersionId: v._id });
  return v;
}

let key = 0;
async function book(p, v, customerId = "cust1") {
  key += 1;
  const quote = await previewBooking({ tenantId: T, productId: p._id, pickupBranchId: BR });
  return createBooking({
    tenantId: T, customerId, productId: p._id, pickupBranchId: BR, acceptedPolicyVersionId: v._id,
    acceptedAdvancePaise: quote.advanceRequiredPaise, acceptedEstimateTotalPaise: quote.estimateTotalPaise,
    acceptedRatePerGramPaise: quote.ratePerGramPaise, idempotencyKey: `k${key}`,
  });
}
let hook = 0;
const completed = (attempt, extra = {}) => processEcommercePhonePeWebhook({
  tenantId: T, webhookEventId: `wh-${attempt._id}-${hook += 1}`,
  normalized: { reference: attempt._id, transactionId: `tx-${attempt._id}`, payload: { amount: attempt.amountPaise }, completed: true, failed: false, ...extra },
});
const reload = (id) => EcommerceBooking.findById(id).lean();
const holds = (bookingId) => EcommerceStockReservation.find({ tenantId: T, bookingId }).lean();
const refunds = (bookingId) => EcommercePaymentExceptionRefund.find({ tenantId: T, bookingId }).lean();
const pastDue = (id, field = "expiryAt") => EcommerceBooking.collection.updateOne({ _id: id }, { $set: { [field]: new Date(Date.now() - HOUR) } });

async function confirmed(p, v, customerId) {
  const { booking, attempt } = await book(p, v, customerId);
  await completed(attempt);
  return { id: booking._id, advanceAttempt: attempt };
}

test("create: idempotent, takes the stock hold, opens one advance attempt, rejects stale terms and ineligible branches", async () => {
  const p = await product(); const v = await policy();
  const first = await book(p, v);
  assert.equal(first.created, true);
  assert.equal(first.booking.status, "PENDING_ADVANCE");
  assert.equal(first.booking.advance.requiredPaise, FIXED_ADVANCE);
  assert.equal(first.attempt.purpose, "BOOKING_ADVANCE");
  assert.equal(first.attempt.amountPaise, FIXED_ADVANCE);
  assert.equal(first.attempt.orderId, undefined);
  assert.equal((await holds(first.booking._id)).length, 1);

  const replay = await createBooking({ tenantId: T, customerId: "cust1", productId: p._id, pickupBranchId: BR,
    acceptedPolicyVersionId: v._id, acceptedAdvancePaise: FIXED_ADVANCE, acceptedEstimateTotalPaise: FIXED_TOTAL, acceptedRatePerGramPaise: null, idempotencyKey: `k${key}` });
  assert.equal(replay.created, false);
  assert.equal(replay.booking._id, first.booking._id);
  assert.equal(await EcommercePaymentAttempt.countDocuments({ tenantId: T, bookingId: first.booking._id }), 1);

  const p2 = await product();
  await assert.rejects(() => createBooking({ tenantId: T, customerId: "c2", productId: p2._id, pickupBranchId: BR,
    acceptedPolicyVersionId: "epolv_old", acceptedAdvancePaise: FIXED_ADVANCE, acceptedEstimateTotalPaise: FIXED_TOTAL, acceptedRatePerGramPaise: null, idempotencyKey: "stale" }), (e) => e.code === "BOOKING_POLICY_CHANGED");
  await assert.rejects(() => createBooking({ tenantId: T, customerId: "c2", productId: p2._id, pickupBranchId: "other",
    acceptedPolicyVersionId: v._id, acceptedAdvancePaise: FIXED_ADVANCE, acceptedEstimateTotalPaise: FIXED_TOTAL, acceptedRatePerGramPaise: null, idempotencyKey: "br" }), (e) => ["PICKUP_BRANCH_NOT_AVAILABLE", "BOOKING_NOT_AVAILABLE", "CHECKOUT_NOT_READY"].includes(e.code));
  assert.equal(await EcommerceBooking.countDocuments({ tenantId: T }), 1, "failed creates leave nothing behind");
  assert.equal((await EcommerceStockReservation.countDocuments({ tenantId: T })), 1);
});

test("a product-level 'booking off' wins over the branch policy", async () => {
  const p = await product(); const v = await policy();
  await setPolicyAssignment({ tenantId: T, scopeType: "PRODUCT", scopeId: String(p._id), bookingEnabled: false });
  await assert.rejects(() => book(p, v), (e) => e.code === "BOOKING_NOT_AVAILABLE" && e.details.reason === "PRODUCT_OFF");
});

test("the last unit: a second booking cannot take a held unit", async () => {
  const p = await product(); const v = await policy();
  await book(p, v, "cust1");
  await assert.rejects(() => book(p, v, "cust2"));
  assert.equal(await EcommerceBooking.countDocuments({ tenantId: T }), 1);
});

test("advance capture confirms through the webhook; replay and a wrong amount change nothing", async () => {
  const p = await product(); const v = await policy();
  const { booking, attempt } = await book(p, v);
  const wrong = await completed(attempt, { payload: { amount: attempt.amountPaise - 1 } });
  assert.notEqual(wrong.result.outcome, "SUCCESS");
  assert.equal((await reload(booking._id)).status, "PENDING_ADVANCE");

  const ok = await completed(attempt);
  assert.equal(ok.result.outcome, "SUCCESS");
  const b = await reload(booking._id);
  assert.equal(b.status, "CONFIRMED");
  assert.equal(b.paymentStatus, "ADVANCE_PAID");
  assert.equal(b.advance.capturedPaise, FIXED_ADVANCE);
  assert.equal(b.advance.attemptId, attempt._id);
  assert.ok(new Date(b.balanceDueAt) > new Date(Date.now() + 71 * HOUR));
  assert.equal(String(b.expiryAt), String(b.balanceDueAt));
  assert.equal((await holds(booking._id)).filter((h) => !h.releasedAt).length, 1, "hold kept while confirmed");

  await completed(attempt);
  assert.equal((await reload(booking._id)).version, b.version, "replay is a no-op");
  assert.equal((await refunds(booking._id)).length, 0);
});

test("advance captured, order never created: reconcile confirms, hold survives, expiry refunds exactly once, replays change nothing", async () => {
  const p = await product(); const v = await policy();
  const { booking, attempt } = await book(p, v);
  // Initiation happened and the customer paid, but we only learn of it by polling after the deadline.
  await EcommercePaymentAttempt.collection.updateOne({ _id: attempt._id }, {
    $set: { status: "INITIATED", providerOrderId: "po-1", expiresAt: new Date(Date.now() - 2 * HOUR) },
  });
  await pastDue(booking._id);
  mock.method(phonePeProvider, "getOrderStatus", async () => ({
    state: "COMPLETED", amount: attempt.amountPaise, paymentDetails: [{ state: "COMPLETED", transactionId: "tx-po-1" }],
  }));

  const first = await runEcommerceBookingExpiry();
  assert.equal(first.counts.CHANGED_NOT_DUE, 1, "the poll found a capture, so the booking is confirmed, not expired");
  const confirmedBooking = await reload(booking._id);
  assert.equal(confirmedBooking.status, "CONFIRMED");
  assert.equal((await holds(booking._id)).filter((h) => !h.releasedAt).length, 1);
  assert.equal((await refunds(booking._id)).length, 0);

  // The balance never arrives and no order is created. Later the deadline passes.
  await pastDue(booking._id);
  const expired = await runEcommerceBookingExpiry();
  assert.equal(expired.counts.EXPIRED, 1);
  const b = await reload(booking._id);
  assert.equal(b.status, "EXPIRED");
  assert.equal(b.refundStatus, "PENDING");
  assert.equal((await holds(booking._id)).filter((h) => !h.releasedAt).length, 0, "hold released");
  const rows = await refunds(booking._id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountPaise, FIXED_ADVANCE);
  assert.equal(rows[0].paymentAttemptId, attempt._id);
  assert.equal(rows[0].refundSource, "BOOKING_EXPIRY");
  assert.equal(await EcommerceOrder.countDocuments({ tenantId: T }), 0);

  // Replay both jobs and the provider callback.
  assert.equal((await expireBooking({ tenantId: T, bookingId: booking._id })).outcome, "NOT_OPEN");
  assert.equal((await runEcommerceBookingExpiry()).scanned, 0);
  await completed(attempt);
  assert.equal((await refunds(booking._id)).length, 1, "still exactly one refund entitlement");
  assert.equal((await reload(booking._id)).status, "EXPIRED");
});

test("an unpaid booking expires without a refund, and a late capture afterwards is refunded in full", async () => {
  const p = await product(); const v = await policy();
  const { booking, attempt } = await book(p, v);
  await EcommercePaymentAttempt.collection.updateOne({ _id: attempt._id }, { $set: { expiresAt: new Date(Date.now() - HOUR) } });
  await pastDue(booking._id);
  assert.equal((await expireBooking({ tenantId: T, bookingId: booking._id })).outcome, "EXPIRED");
  const b = await reload(booking._id);
  assert.equal(b.status, "EXPIRED");
  assert.equal((await holds(booking._id)).filter((h) => !h.releasedAt).length, 0);
  assert.equal((await refunds(booking._id)).length, 0);
  assert.equal((await EcommercePaymentAttempt.findById(attempt._id).lean()).status, "EXPIRED");

  const late = await completed(attempt);
  assert.equal(late.result.outcome, "LATE_CAPTURE_REFUND_ASSIGNED");
  const rows = await refunds(booking._id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountPaise, FIXED_ADVANCE);
  assert.equal((await reload(booking._id)).status, "EXPIRED", "a late capture never revives the booking");
  await completed(attempt);
  assert.equal((await refunds(booking._id)).length, 1);
});

test("an unresolved provider poll defers expiry instead of expiring or refunding", async () => {
  const p = await product(); const v = await policy();
  const { booking, attempt } = await book(p, v);
  await EcommercePaymentAttempt.collection.updateOne({ _id: attempt._id }, {
    $set: { status: "INITIATED", providerOrderId: "po-2", expiresAt: new Date(Date.now() - 2 * HOUR) },
  });
  await pastDue(booking._id);
  mock.method(phonePeProvider, "getOrderStatus", async () => { throw new Error("PhonePe 503"); });
  const res = await expireBooking({ tenantId: T, bookingId: booking._id });
  assert.equal(res.outcome, "DEFERRED");
  assert.equal((await reload(booking._id)).status, "PENDING_ADVANCE");
  assert.equal((await holds(booking._id)).filter((h) => !h.releasedAt).length, 1);
});

test("renewing gives a new attempt and keeps the old one; either capture is matched, and the second is refunded", async () => {
  const p = await product(); const v = await policy();
  const { booking, attempt: first } = await book(p, v);

  const same = await renewBookingPaymentAttempt({ tenantId: T, bookingId: booking._id });
  assert.equal(same.created, false, "an active attempt is kept");
  assert.equal(same.attempt._id, first._id);

  await EcommercePaymentAttempt.collection.updateOne({ _id: first._id }, { $set: { status: "FAILED" } });
  const renewed = await renewBookingPaymentAttempt({ tenantId: T, bookingId: booking._id });
  assert.equal(renewed.created, true);
  assert.notEqual(renewed.attempt._id, first._id);
  assert.equal(renewed.attempt.merchantOrderId, renewed.attempt._id);
  assert.equal(await EcommercePaymentAttempt.countDocuments({ tenantId: T, bookingId: booking._id }), 2, "old attempt retained");

  // The customer actually paid the first provider order after we gave up on it.
  assert.equal((await completed(first)).result.outcome, "SUCCESS");
  assert.equal((await reload(booking._id)).advance.attemptId, first._id);
  // Then also paid the second: the booking cannot take it twice, so it is refunded in full.
  assert.equal((await completed(renewed.attempt)).result.outcome, "LATE_CAPTURE_REFUND_ASSIGNED");
  const rows = await refunds(booking._id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paymentAttemptId, renewed.attempt._id);
  assert.equal(rows[0].amountPaise, FIXED_ADVANCE);
  assert.equal((await reload(booking._id)).advance.capturedPaise, FIXED_ADVANCE, "advance counted once");
});

test("renew is refused once the window closed or while the earlier attempt may still be paid", async () => {
  const p = await product(); const v = await policy();
  const { booking, attempt } = await book(p, v);
  await EcommercePaymentAttempt.collection.updateOne({ _id: attempt._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(() => renewBookingPaymentAttempt({ tenantId: T, bookingId: booking._id }), (e) => e.code === "BOOKING_ATTEMPT_PENDING_RECONCILIATION");
  await pastDue(booking._id);
  await assert.rejects(() => renewBookingPaymentAttempt({ tenantId: T, bookingId: booking._id }), (e) => e.code === "BOOKING_PAYMENT_WINDOW_CLOSED");
});

test("balance: freezes the invoice, converts to one paid order on capture, one stock deduction, replay-safe", async () => {
  const p = await product(); const v = await policy();
  const { id, advanceAttempt } = await confirmed(p, v);
  const quote = await createBalanceQuote({ tenantId: T, bookingId: id });
  assert.equal(quote.booking.status, "BALANCE_PENDING");
  assert.equal(quote.booking.finalBilling.totalPaise, FIXED_TOTAL);
  assert.equal(quote.booking.finalBilling.balancePaise, FIXED_TOTAL - FIXED_ADVANCE);
  assert.equal(quote.attempt.purpose, "BOOKING_BALANCE");
  assert.equal(quote.attempt.amountPaise, FIXED_TOTAL - FIXED_ADVANCE);
  assert.equal((await createBalanceQuote({ tenantId: T, bookingId: id })).created, false, "quote is idempotent");

  const paid = await completed(quote.attempt);
  assert.equal(paid.result.outcome, "SUCCESS");
  const b = await reload(id);
  assert.equal(b.status, "CONVERTED");
  assert.equal(b.paymentStatus, "FULLY_PAID");
  const orders = await EcommerceOrder.find({ tenantId: T, bookingId: id }).lean();
  assert.equal(orders.length, 1);
  assert.equal(b.convertedOrderId, orders[0]._id);
  assert.equal(orders[0].status, "PAID");
  assert.equal(orders[0].totalPaise, FIXED_TOTAL);
  assert.deepEqual(
    orders[0].paymentAllocations.map((a) => [a.paymentAttemptId, a.purpose, a.appliedPaise]),
    [[advanceAttempt._id, "BOOKING_ADVANCE", FIXED_ADVANCE], [quote.attempt._id, "BOOKING_BALANCE", FIXED_TOTAL - FIXED_ADVANCE]],
  );
  assert.equal(orders[0].paymentAllocations.reduce((s, a) => s + a.appliedPaise, 0), orders[0].totalPaise);
  const inv = await EcommerceInventory.findOne({ tenantId: T, productId: p._id }).lean();
  assert.equal(inv.quantityOnHand, 0, "exactly one unit deducted");
  assert.equal((await holds(id)).filter((h) => !h.releasedAt).length, 0);
  const attempts = await EcommercePaymentAttempt.find({ tenantId: T, bookingId: id }).lean();
  assert.ok(attempts.every((a) => a.orderId === orders[0]._id));

  await completed(quote.attempt);
  assert.equal(await EcommerceOrder.countDocuments({ tenantId: T, bookingId: id }), 1);
  assert.equal((await EcommerceInventory.findOne({ tenantId: T, productId: p._id }).lean()).quantityOnHand, 0);
  assert.equal((await refunds(id)).length, 0);
  // A converted booking is not expirable.
  await pastDue(id);
  assert.equal((await expireBooking({ tenantId: T, bookingId: id })).outcome, "NOT_OPEN");
});

test("a balance capture with the wrong amount is refunded, not converted", async () => {
  const p = await product(); const v = await policy();
  const { id } = await confirmed(p, v);
  const { attempt } = await createBalanceQuote({ tenantId: T, bookingId: id });
  await EcommercePaymentAttempt.collection.updateOne({ _id: attempt._id }, { $set: { amountPaise: attempt.amountPaise - 100 } });
  const res = await completed({ ...attempt, amountPaise: attempt.amountPaise - 100 });
  assert.equal(res.result.outcome, "LATE_CAPTURE_REFUND_ASSIGNED");
  assert.equal((await reload(id)).status, "BALANCE_PENDING");
  assert.equal(await EcommerceOrder.countDocuments({ tenantId: T }), 0);
  assert.equal((await refunds(id)).length, 1);
});

test("zero balance: an advance equal to the invoice converts at billing with no balance attempt and no refund", async () => {
  const p = await product();
  const v = await policy({ advance: { mode: "FIXED", fixedPaise: rupees(500_000) } }); // capped at the total
  const { booking, attempt } = await book(p, v);
  assert.equal(booking.advance.requiredPaise, FIXED_TOTAL);
  await completed(attempt);
  const res = await createBalanceQuote({ tenantId: T, bookingId: booking._id });
  assert.equal(res.booking.status, "CONVERTED");
  assert.equal(res.order.paymentAllocations.length, 1);
  assert.equal(res.order.paymentAllocations[0].appliedPaise, FIXED_TOTAL);
  assert.equal(await EcommercePaymentAttempt.countDocuments({ tenantId: T, bookingId: booking._id, purpose: "BOOKING_BALANCE" }), 0);
  assert.equal((await refunds(booking._id)).length, 0);
  assert.equal((await EcommerceInventory.findOne({ tenantId: T, productId: p._id }).lean()).quantityOnHand, 0);
});

test("excess advance: gold fell, the order takes only the invoice from the advance and the excess is refunded once", async () => {
  const p = await goldProduct();
  await rate(700_000, 120);
  const v = await policy({ advance: { mode: "PERCENT", percentBps: 9000, minPaise: 0 }, rateRule: "BILLING_DAY" });
  const { booking, attempt } = await book(p, v);
  await completed(attempt);
  const advance = (await reload(booking._id)).advance.capturedPaise;
  await rate(560_000, 1); // gold fell 20%

  const res = await createBalanceQuote({ tenantId: T, bookingId: booking._id });
  const fb = res.booking.finalBilling;
  assert.equal(res.booking.status, "CONVERTED", "advance covers the whole invoice");
  assert.ok(fb.totalPaise < advance);
  assert.equal(fb.excessAdvancePaise, advance - fb.totalPaise);
  assert.equal(fb.balancePaise, 0);
  assert.equal(fb.rateSource, "BILLING_DAY");
  assert.deepEqual(res.order.paymentAllocations.map((a) => a.appliedPaise), [fb.totalPaise]);
  const rows = await refunds(booking._id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountPaise, fb.excessAdvancePaise);
  assert.equal(rows[0].refundSource, "BOOKING_EXCESS_ADVANCE");
  assert.equal(rows[0].orderId, res.order._id);
  assert.equal((await reload(booking._id)).refundStatus, "PENDING");
});

test("rate rules at billing: protected booked rate, expired protection, stale and missing live rates", async () => {
  const p = await goldProduct();
  await rate(700_000, 120);
  const v = await policy({ rateRule: "BOOKED_RATE", rateProtectionHours: 48 });
  const a = await confirmed(p, v);
  await rate(900_000, 1); // gold rose; protection still applies
  const quote = await createBalanceQuote({ tenantId: T, bookingId: a.id });
  assert.equal(quote.booking.finalBilling.rateSource, "BOOKED");
  assert.equal(quote.booking.bookedRate.ratePerGramPaise, 700_000);

  // Protection over, live rate stale: billing is blocked, nothing is frozen.
  const p2 = await goldProduct();
  const b = await confirmed(p2, v, "cust2");
  await EcommerceBooking.collection.updateOne({ _id: b.id }, { $set: { "bookedRate.protectedUntil": new Date(Date.now() - HOUR) } });
  await EcommerceGoldRate.collection.updateMany({ tenantId: T }, { $set: { effectiveAt: new Date(Date.now() - 400 * HOUR) } });
  await assert.rejects(() => createBalanceQuote({ tenantId: T, bookingId: b.id }), (e) => e.code === "PRICE_NOT_COMPUTABLE");
  const stuck = await reload(b.id);
  assert.equal(stuck.status, "CONFIRMED");
  assert.equal(stuck.finalBilling?.totalPaise, undefined);

  // A fresh rate unblocks it, and the live rate is used.
  await rate(950_000, 1);
  const ok = await createBalanceQuote({ tenantId: T, bookingId: b.id });
  assert.equal(ok.booking.finalBilling.rateSource, "BILLING_DAY");
});

test("cancel before the advance is paid: hold released, nothing to refund; a late capture is then refunded in full", async () => {
  const p = await product(); const v = await policy();
  const { booking, attempt } = await book(p, v);
  const res = await cancelBooking({ tenantId: T, bookingId: booking._id, customerId: "cust1", actorId: "cust1" });
  assert.equal(res.booking.status, "CANCELLED");
  assert.equal((await holds(booking._id)).filter((h) => !h.releasedAt).length, 0);
  assert.equal((await refunds(booking._id)).length, 0);

  assert.equal((await completed(attempt)).result.outcome, "LATE_CAPTURE_REFUND_ASSIGNED");
  const rows = await refunds(booking._id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountPaise, FIXED_ADVANCE);
  assert.equal((await reload(booking._id)).status, "CANCELLED");
});

test("cancel after the advance: fee kept, remainder refunded once; staff may waive the fee; replay is safe", async () => {
  const p = await product(); const v = await policy(); const p2 = await product();
  const { id } = await confirmed(p, v);
  const res = await cancelBooking({ tenantId: T, bookingId: id, customerId: "cust1", actorId: "cust1" });
  assert.equal(res.feePaise, FIXED_ADVANCE / 10);
  assert.equal(res.refundPaise, FIXED_ADVANCE - FIXED_ADVANCE / 10);
  assert.equal((await reload(id)).refundStatus, "PENDING");
  const again = await cancelBooking({ tenantId: T, bookingId: id, customerId: "cust1", actorId: "cust1" });
  assert.equal(again.replayed, true);
  const rows = await refunds(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].refundSource, "BOOKING_CANCELLATION");
  assert.equal(rows[0].amountPaise, res.refundPaise);

  const other = await confirmed(p2, v, "cust2");
  const waived = await cancelBooking({ tenantId: T, bookingId: other.id, actorId: "staff1", staff: true, waiveFee: true });
  assert.equal(waived.refundPaise, FIXED_ADVANCE);
  // A customer cannot cancel someone else's booking.
  await assert.rejects(() => cancelBooking({ tenantId: T, bookingId: other.id, customerId: "intruder", actorId: "x" }), (e) => e.code === "RESOURCE_NOT_FOUND");
});

test("a cancelled booking cannot be billed, and a converted booking cannot be cancelled", async () => {
  const p = await product(); const v = await policy(); const p2 = await product();
  const a = await confirmed(p, v);
  await cancelBooking({ tenantId: T, bookingId: a.id, actorId: "s", staff: true });
  await assert.rejects(() => createBalanceQuote({ tenantId: T, bookingId: a.id }), (e) => e.code === "BOOKING_NOT_CONFIRMED");

  const b = await confirmed(p2, v, "cust2");
  const q = await createBalanceQuote({ tenantId: T, bookingId: b.id });
  await completed(q.attempt);
  await assert.rejects(() => cancelBooking({ tenantId: T, bookingId: b.id, actorId: "s", staff: true }), (e) => e.code === "BOOKING_NOT_CANCELLABLE");
});

test("webhook and expiry racing on the same advance: exactly one outcome, never both a booking and a refund", async () => {
  const p = await product(); const v = await policy();
  const { booking, attempt } = await book(p, v);
  await EcommercePaymentAttempt.collection.updateOne({ _id: attempt._id }, { $set: { expiresAt: new Date(Date.now() - HOUR) } });
  await pastDue(booking._id);
  await Promise.allSettled([completed(attempt), expireBooking({ tenantId: T, bookingId: booking._id })]);
  await expireBooking({ tenantId: T, bookingId: booking._id }).catch(() => {});
  const b = await reload(booking._id);
  const rows = await refunds(booking._id);
  const heldNow = (await holds(booking._id)).filter((h) => !h.releasedAt).length;
  if (b.status === "CONFIRMED") {
    assert.equal(rows.length, 0);
    assert.equal(heldNow, 1);
  } else {
    assert.equal(b.status, "EXPIRED");
    assert.equal(rows.length, 1, "a capture that lost the race is refunded, once");
    assert.equal(heldNow, 0);
  }
});

test("a booking whose provider poll is unresolved does not block expiry of other bookings (batch of one)", async () => {
  const p1 = await product(); const p2 = await product(); const v = await policy();
  const older = await book(p1, v, "cust1");
  const newer = await book(p2, v, "cust2");
  // Older: initiated at the provider, deadline long past, provider keeps failing.
  await EcommercePaymentAttempt.collection.updateOne({ _id: older.attempt._id }, {
    $set: { status: "INITIATED", providerOrderId: "po-stuck", expiresAt: new Date(Date.now() - 3 * HOUR) },
  });
  await EcommerceBooking.collection.updateOne({ _id: older.booking._id }, { $set: { expiryAt: new Date(Date.now() - 3 * HOUR) } });
  // Newer: plainly expired, never reached the provider.
  await EcommercePaymentAttempt.collection.updateOne({ _id: newer.attempt._id }, { $set: { expiresAt: new Date(Date.now() - HOUR) } });
  await pastDue(newer.booking._id);
  mock.method(phonePeProvider, "getOrderStatus", async () => { throw new Error("PhonePe 503"); });

  const first = await runEcommerceBookingExpiry(new Date(), { limit: 1 });
  assert.equal(first.counts.DEFERRED, 1);
  const stuck = await reload(older.booking._id);
  assert.equal(stuck.status, "PENDING_ADVANCE");
  assert.ok(new Date(stuck.expiryRetryAt) > new Date(), "deferred booking has a retry time");
  assert.equal(stuck.expiryDeferrals, 1);

  const second = await runEcommerceBookingExpiry(new Date(), { limit: 1 });
  assert.equal(second.counts.EXPIRED, 1, "the worker moved past the deferred booking");
  assert.equal((await reload(newer.booking._id)).status, "EXPIRED");
  assert.equal((await holds(newer.booking._id)).filter((h) => !h.releasedAt).length, 0);
  assert.equal((await reload(older.booking._id)).status, "PENDING_ADVANCE");

  // Once the retry time passes it is tried again, with a longer backoff after another failure.
  const later = new Date(Date.now() + 3 * 60_000);
  const third = await runEcommerceBookingExpiry(later, { limit: 1 });
  assert.equal(third.counts.DEFERRED, 1);
  const again = await reload(older.booking._id);
  assert.equal(again.expiryDeferrals, 2);
  assert.ok(new Date(again.expiryRetryAt).getTime() - later.getTime() >= 4 * 60_000 - 1000);
});

test("an idempotency key is bound to its request: same input replays, different input is rejected", async () => {
  const p1 = await product(); const p2 = await product(); const v = await policy();
  const args = { tenantId: T, customerId: "cust1", productId: p1._id, pickupBranchId: BR, acceptedPolicyVersionId: v._id, acceptedAdvancePaise: FIXED_ADVANCE, acceptedEstimateTotalPaise: FIXED_TOTAL, acceptedRatePerGramPaise: null, idempotencyKey: "bound" };
  const first = await createBooking(args);
  const same = await createBooking(args);
  assert.equal(same.created, false);
  assert.equal(same.booking._id, first.booking._id);
  await assert.rejects(() => createBooking({ ...args, productId: p2._id }), (e) => e.code === "IDEMPOTENCY_KEY_REUSED");
  await assert.rejects(() => createBooking({ ...args, acceptedPolicyVersionId: "epolv_other" }), (e) => e.code === "IDEMPOTENCY_KEY_REUSED");
  assert.equal(await EcommerceBooking.countDocuments({ tenantId: T }), 1);
  assert.equal(await EcommerceStockReservation.countDocuments({ tenantId: T, productId: p2._id }), 0, "no hold for the rejected request");
  // Another customer may use the same key text.
  const other = await createBooking({ ...args, customerId: "cust2", productId: p2._id });
  assert.equal(other.created, true);
});

test("two concurrent creates with one key and different input: one booking, the other is rejected", async () => {
  const p1 = await product(); const p2 = await product(); const v = await policy();
  const base = { tenantId: T, customerId: "cust1", pickupBranchId: BR, acceptedPolicyVersionId: v._id, acceptedAdvancePaise: FIXED_ADVANCE, acceptedEstimateTotalPaise: FIXED_TOTAL, acceptedRatePerGramPaise: null, idempotencyKey: "race" };
  const results = await Promise.allSettled([createBooking({ ...base, productId: p1._id }), createBooking({ ...base, productId: p2._id })]);
  assert.equal(await EcommerceBooking.countDocuments({ tenantId: T }), 1);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "IDEMPOTENCY_KEY_REUSED");
});

test("excess-advance refund settlement clears the booking's refundStatus", async () => {
  const p = await goldProduct();
  await rate(700_000, 120);
  const v = await policy({ advance: { mode: "PERCENT", percentBps: 9000, minPaise: 0 }, rateRule: "BILLING_DAY" });
  const { booking, attempt } = await book(p, v);
  await completed(attempt);
  await rate(560_000, 1);
  const res = await createBalanceQuote({ tenantId: T, bookingId: booking._id });
  const [refund] = await refunds(booking._id);
  assert.equal(refund.orderId, res.order._id);
  assert.equal((await reload(booking._id)).refundStatus, "PENDING");
  await EcommercePaymentExceptionRefund.collection.updateOne({ _id: refund._id }, { $set: { status: "PROVIDER_PENDING" } });

  const webhook = {
    tenantId: T, type: "PG_REFUND_COMPLETED", providerEventId: "pe-excess",
    payload: { refundId: refund._id, originalMerchantOrderId: attempt._id, amount: refund.amountPaise, currency: "INR" },
  };
  assert.equal((await processEcommercePhonePeRefundWebhook(webhook)).outcome, "SUCCEEDED");
  assert.equal((await reload(booking._id)).refundStatus, "SETTLED");
  assert.equal((await processEcommercePhonePeRefundWebhook(webhook)).outcome, "ALREADY_CLOSED");
  assert.equal((await reload(booking._id)).refundStatus, "SETTLED");
});

test("refundStatus stays PENDING while another refund of the booking is unsettled", async () => {
  const p = await goldProduct();
  await rate(700_000, 120);
  const v = await policy({ advance: { mode: "PERCENT", percentBps: 9000, minPaise: 0 }, rateRule: "BILLING_DAY" });
  const { booking, attempt } = await book(p, v);
  await completed(attempt);
  await rate(560_000, 1);
  await createBalanceQuote({ tenantId: T, bookingId: booking._id });
  const [refund] = await refunds(booking._id);
  // A second, still-open refund of the same booking (for example a late duplicate capture).
  await EcommercePaymentExceptionRefund.collection.insertOne({
    ...refund, _id: "epayref_extra", refundOperationId: "late-capture:extra", status: "ASSIGNED", orderId: null,
  });
  await EcommercePaymentExceptionRefund.collection.updateOne({ _id: refund._id }, { $set: { status: "PROVIDER_PENDING" } });
  await processEcommercePhonePeRefundWebhook({
    tenantId: T, type: "PG_REFUND_COMPLETED", providerEventId: "pe-x",
    payload: { refundId: refund._id, originalMerchantOrderId: attempt._id, amount: refund.amountPaise, currency: "INR" },
  });
  assert.equal((await reload(booking._id)).refundStatus, "PENDING");
});

async function twoOpenRefunds() {
  const p = await goldProduct();
  await rate(700_000, 120);
  const v = await policy({ advance: { mode: "PERCENT", percentBps: 9000, minPaise: 0 }, rateRule: "BILLING_DAY" });
  const { booking, attempt } = await book(p, v);
  await completed(attempt);
  await rate(560_000, 1);
  await createBalanceQuote({ tenantId: T, bookingId: booking._id });
  const [excess] = await refunds(booking._id);
  // A second open refund of the same booking, owned by the booking (no order).
  await EcommercePaymentExceptionRefund.collection.insertOne({
    ...excess, _id: "epayref_second", refundOperationId: "late-capture:second", orderId: null, amountPaise: 100, status: "PROVIDER_PENDING",
  });
  await EcommercePaymentExceptionRefund.collection.updateOne({ _id: excess._id }, { $set: { status: "PROVIDER_PENDING" } });
  return { booking, attempt, excess };
}
const refundCompleted = (attempt, refundId, amount, id) => processEcommercePhonePeRefundWebhook({
  tenantId: T, type: "PG_REFUND_COMPLETED", providerEventId: id,
  payload: { refundId, originalMerchantOrderId: attempt._id, amount, currency: "INR" },
});

test("two refunds of one booking settling concurrently still clear refundStatus", async () => {
  for (let round = 0; round < 3; round += 1) {
    await resetTestDb();
    await Tenant.collection.insertOne({ _id: T, name: "t", status: "ACTIVE" });
  await Branch.collection.insertOne({ _id: BR, tenantId: T, name: "Main branch" });
    await EcommerceTaxSettings.create({ tenantId: T, ...taxReadyCatalogBody() });
    await EcommerceFulfilmentSettings.create({
      tenantId: T, pickupEnabled: true, pickupBranchIds: [BR], pendingPaymentWindowMinutes: 30,
      checkoutTaxConfig: taxReadyCheckoutTaxConfig(), storePolicies: taxReadyStorePolicies(),
    });
    const { booking, attempt, excess } = await twoOpenRefunds();
    await Promise.all([
      refundCompleted(attempt, excess._id, excess.amountPaise, `pe-a${round}`),
      refundCompleted(attempt, "epayref_second", 100, `pe-b${round}`),
    ]);
    const rows = await refunds(booking._id);
    assert.deepEqual(rows.map((r) => r.status), ["SUCCEEDED", "SUCCEEDED"]);
    assert.equal((await reload(booking._id)).refundStatus, "SETTLED", `round ${round}`);
  }
});

test("a staff-recorded manual refund settles the booking refund through the same check", async () => {
  const p = await product(); const v = await policy();
  const { id } = await confirmed(p, v);
  await cancelBooking({ tenantId: T, bookingId: id, customerId: "cust1", actorId: "cust1" });
  const [refund] = await refunds(id);
  assert.equal((await reload(id)).refundStatus, "PENDING");
  await withTransaction((session) => claimManualRefund(session, {
    tenantId: T, orderId: null, refundId: refund._id, reference: "UTR123", userId: "staff1",
  }));
  assert.equal((await EcommercePaymentExceptionRefund.findById(refund._id).lean()).status, "MANUAL_RECORDED");
  assert.equal((await reload(id)).refundStatus, "SETTLED");
});

test("a manual refund does not clear the status while another refund of the booking is open", async () => {
  const { booking, excess } = await twoOpenRefunds();
  await EcommercePaymentExceptionRefund.collection.updateOne({ _id: excess._id }, { $set: { status: "ASSIGNED", providerRefundId: null } });
  await withTransaction((session) => claimManualRefund(session, {
    tenantId: T, orderId: excess.orderId, refundId: excess._id, reference: "UTR9", userId: "staff1",
  }));
  assert.equal((await reload(booking._id)).refundStatus, "PENDING", "the second refund is still open");
});
