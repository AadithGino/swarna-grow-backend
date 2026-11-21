/**
 * Booking release-1 hardening: refund failure, definite order-not-found, stuck-booking alerts,
 * re-billing, staff manual refund for an order-less refund, reminders, read models and provider
 * initiation (with the provider mocked).
 */
import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { ResourceNotFound } from "@phonepe-pg/pg-sdk-node";
import {
  Alert,
  Customer,
  EcommerceBooking,
  EcommerceFulfilmentSettings,
  EcommerceGoldRate,
  EcommerceInventory,
  EcommerceOrder,
  EcommercePaymentAttempt,
  EcommercePaymentExceptionRefund,
  EcommerceProduct,
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
  requoteBalance,
} from "../src/services/ecommerce-booking.service.js";
import { expireBooking, runEcommerceBookingExpiry } from "../src/services/ecommerce-booking-expiry.service.js";
import { runEcommerceBookingReminders } from "../src/services/ecommerce-booking-reminder.service.js";
import {
  getAdminBooking,
  getCustomerBooking,
  listAdminBookings,
  listCustomerBookings,
  recordBookingRefundManual,
  retryBookingRefund,
} from "../src/services/ecommerce-booking-admin.service.js";
import { upsertOperationalAlert } from "../src/lib/operational-alert.js";
import { startBookingAttemptCheckout } from "../src/services/ecommerce-booking-payment-initiation.service.js";
import { resetTestDb } from "./helpers/db.js";
import { taxReadyCatalogBody, taxReadyCheckoutTaxConfig, taxReadyStorePolicies } from "./helpers/ecommerce-checkout-fixtures.js";

const T = "bookp4-tenant";
const BR = "br1";
const HOUR = 3_600_000;
const rupees = (n) => n * 100;

test.beforeEach(async () => {
  await resetTestDb();
  resetBookingPaymentHandlers();
  installBookingPaymentHandlers();
  await Tenant.collection.insertOne({ _id: T, name: "t", status: "ACTIVE" });
  await Branch.collection.insertOne({ _id: BR, tenantId: T, name: "Main branch" });
  await Customer.collection.insertOne({ _id: "cust1", tenantId: T, mobile: "9000000001", branchId: BR });
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
    tenantId: T, name: `Ring ${seq}`, slug: `ring4-${seq}`, sku: `R4-${seq}`, status: "PUBLISHED",
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
    tenantId: T, policyKey: `p4-${seq}-${Math.random()}`, name: "Standard",
    fields: {
      advance: { mode: "PERCENT", percentBps: 2500, minPaise: 0 }, rateRule: "BILLING_DAY", rateProtectionHours: 0,
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
    acceptedRatePerGramPaise: quote.ratePerGramPaise, idempotencyKey: `p4k${key}`,
  });
}
let hook = 0;
const completed = (attempt) => processEcommercePhonePeWebhook({
  tenantId: T, webhookEventId: `wh4-${attempt._id}-${hook += 1}`,
  normalized: { reference: attempt._id, transactionId: `tx-${attempt._id}`, payload: { amount: attempt.amountPaise }, completed: true, failed: false },
});
const reload = (id) => EcommerceBooking.findById(id).lean();
const refunds = (bookingId) => EcommercePaymentExceptionRefund.find({ tenantId: T, bookingId }).lean();
const refundEvent = (type, attempt, refundId, amount, id) => processEcommercePhonePeRefundWebhook({
  tenantId: T, type, providerEventId: id,
  payload: { refundId, originalMerchantOrderId: attempt._id, amount, currency: "INR" },
});

async function confirmedFixed() {
  const p = await product(); const v = await policy();
  const { booking, attempt } = await book(p, v);
  await completed(attempt);
  return { id: booking._id, attempt };
}

test("a refund the provider reports as failed moves the booking to refundStatus FAILED, not PENDING", async () => {
  const { id, attempt } = await confirmedFixed();
  await cancelBooking({ tenantId: T, bookingId: id, customerId: "cust1", actorId: "cust1" });
  const [refund] = await refunds(id);
  assert.equal((await reload(id)).refundStatus, "PENDING");
  await EcommercePaymentExceptionRefund.collection.updateOne({ _id: refund._id }, { $set: { status: "PROVIDER_PENDING" } });
  await refundEvent("PG_REFUND_FAILED", attempt, refund._id, refund.amountPaise, "pe-fail-1");
  assert.equal((await EcommercePaymentExceptionRefund.findById(refund._id).lean()).status, "FAILED");
  assert.equal((await reload(id)).refundStatus, "FAILED");
});

test("an attempt PhonePe says does not exist can expire once past its grace; any other poll error still defers", async () => {
  const p1 = await product(); const p2 = await product(); const v = await policy();
  const a = await book(p1, v, "cust1");
  const b = await book(p2, v, "cust1");
  const past = new Date(Date.now() - 3 * HOUR);
  for (const x of [a, b]) {
    await EcommercePaymentAttempt.collection.updateOne({ _id: x.attempt._id }, {
      $set: { expiresAt: past, operationalStatus: "INITIATION_UNCERTAIN", initiationUncertainAt: past, providerOrderId: null },
    });
    await EcommerceBooking.collection.updateOne({ _id: x.booking._id }, { $set: { expiryAt: past } });
  }
  // A transient error does not prove the order is absent.
  mock.method(phonePeProvider, "getOrderStatus", async () => { throw new Error("PhonePe 503"); });
  assert.equal((await expireBooking({ tenantId: T, bookingId: a.booking._id })).outcome, "DEFERRED");
  assert.equal((await reload(a.booking._id)).status, "PENDING_ADVANCE");
  // A definite "no such order" answer does.
  mock.restoreAll();
  mock.method(phonePeProvider, "getOrderStatus", async () => { throw new ResourceNotFound("no order"); });
  assert.equal((await expireBooking({ tenantId: T, bookingId: b.booking._id })).outcome, "EXPIRED");
  assert.equal((await reload(b.booking._id)).status, "EXPIRED");
});

test("an order-not-found answer inside the grace window does not expire the attempt", async () => {
  const p = await product(); const v = await policy();
  const x = await book(p, v);
  const justPast = new Date(Date.now() - 60_000);
  await EcommercePaymentAttempt.collection.updateOne({ _id: x.attempt._id }, {
    $set: { expiresAt: justPast, operationalStatus: "INITIATION_UNCERTAIN", initiationUncertainAt: justPast, providerOrderId: null },
  });
  await EcommerceBooking.collection.updateOne({ _id: x.booking._id }, { $set: { expiryAt: justPast } });
  mock.method(phonePeProvider, "getOrderStatus", async () => { throw new ResourceNotFound("no order"); });
  assert.equal((await expireBooking({ tenantId: T, bookingId: x.booking._id })).outcome, "DEFERRED");
  assert.equal((await reload(x.booking._id)).status, "PENDING_ADVANCE");
});

test("a booking that keeps failing to expire raises one operational alert by the third deferral", async () => {
  const p = await product(); const v = await policy();
  const x = await book(p, v);
  const past = new Date(Date.now() - 3 * HOUR);
  await EcommercePaymentAttempt.collection.updateOne({ _id: x.attempt._id }, {
    $set: { status: "INITIATED", providerOrderId: "po-stuck", expiresAt: past },
  });
  await EcommerceBooking.collection.updateOne({ _id: x.booking._id }, { $set: { expiryAt: past } });
  mock.method(phonePeProvider, "getOrderStatus", async () => { throw new Error("PhonePe 503"); });
  let at = new Date();
  for (let i = 0; i < 3; i += 1) {
    await runEcommerceBookingExpiry(at, { limit: 5 });
    at = new Date(at.getTime() + 2 * HOUR);
    if (i < 2) assert.equal(await Alert.countDocuments({ tenantId: T, entityId: x.booking._id }), 0, `no alert after deferral ${i + 1}`);
  }
  assert.equal((await reload(x.booking._id)).expiryDeferrals, 3);
  assert.equal(await Alert.countDocuments({ tenantId: T, entityId: x.booking._id, type: "PAYMENT_REVIEW", status: "OPEN" }), 1);
});

test("if converting a paid booking throws, the capture is retried and staff are alerted", async () => {
  const p = await goldProduct();
  await rate(700_000, 120);
  const v = await policy();
  const { booking, attempt } = await book(p, v);
  await completed(attempt);
  const quote = await createBalanceQuote({ tenantId: T, bookingId: booking._id });
  assert.ok(quote.attempt, "balance attempt opened");
  mock.method(EcommerceOrder, "create", async () => { throw new Error("cannot create order"); });
  await assert.rejects(() => completed(quote.attempt), /cannot create order/);
  mock.restoreAll();
  assert.equal((await reload(booking._id)).status, "BALANCE_PENDING", "nothing half-applied");
  assert.equal(await Alert.countDocuments({ tenantId: T, entityId: booking._id, type: "PAYMENT_REVIEW", status: "OPEN" }), 1);
  // The gateway's retry now succeeds and converts.
  await completed(quote.attempt);
  assert.equal((await reload(booking._id)).status, "CONVERTED");
  assert.equal(await Alert.countDocuments({ tenantId: T, entityId: booking._id, type: "PAYMENT_REVIEW", status: "OPEN" }), 0, "alert cleared once conversion succeeds");
});

test("re-billing: a never-started balance attempt is replaced at the corrected rate; a started one blocks it", async () => {
  const p = await goldProduct();
  await rate(700_000, 120);
  const v = await policy();
  const { booking, attempt } = await book(p, v);
  await completed(attempt);
  const first = await createBalanceQuote({ tenantId: T, bookingId: booking._id });
  const firstTotal = (await reload(booking._id)).finalBilling.totalPaise;

  await assert.rejects(() => requoteBalance({ tenantId: T, bookingId: booking._id, reason: "x" }), (e) => e.code === "VALIDATION_FAILED");

  await rate(650_000, 0);
  const re = await requoteBalance({ tenantId: T, bookingId: booking._id, actorId: "staff1", reason: "Wrong rate was published" });
  const after = await reload(booking._id);
  assert.notEqual(after.finalBilling.totalPaise, firstTotal, "invoice re-priced");
  assert.equal(after.billingRevisions.length, 1);
  assert.equal(after.billingRevisions[0].previous.totalPaise, firstTotal);
  assert.equal((await EcommercePaymentAttempt.findById(first.attempt._id).lean()).status, "EXPIRED");
  assert.equal(re.attempt.amountPaise, after.finalBilling.balancePaise);
  assert.equal(re.attempt.status, "PENDING");

  // Once the new attempt reaches the provider the invoice is fixed.
  await EcommercePaymentAttempt.collection.updateOne({ _id: re.attempt._id }, { $set: { status: "INITIATED", providerOrderId: "po-live" } });
  await assert.rejects(() => requoteBalance({ tenantId: T, bookingId: booking._id, reason: "Trying again later" }),
    (e) => e.code === "BOOKING_BALANCE_IN_PROGRESS");
});

test("re-billing is refused for a booking that is not awaiting its balance", async () => {
  const { id } = await confirmedFixed();
  await assert.rejects(() => requoteBalance({ tenantId: T, bookingId: id, reason: "Not billed yet" }),
    (e) => e.code === "BOOKING_NOT_AWAITING_BALANCE");
});

test("staff record an order-less cancellation refund as paid outside the gateway; the booking settles", async () => {
  const { id } = await confirmedFixed();
  await cancelBooking({ tenantId: T, bookingId: id, customerId: "cust1", actorId: "cust1" });
  const [refund] = await refunds(id);
  assert.equal(refund.orderId ?? null, null);
  await assert.rejects(() => recordBookingRefundManual({
    tenantId: T, bookingId: id, refundId: refund._id, reference: "ab", reason: "Paid by bank transfer", evidenceNote: "Screenshot kept", userId: "s1",
  }), (e) => e.code === "VALIDATION_FAILED");
  const out = await recordBookingRefundManual({
    tenantId: T, bookingId: id, refundId: refund._id, reference: "UTR998877", reason: "Paid by bank transfer", evidenceNote: "Screenshot kept", userId: "s1",
  });
  assert.equal(out.refund.status, "MANUAL_RECORDED");
  assert.equal((await reload(id)).refundStatus, "SETTLED");
  await assert.rejects(() => recordBookingRefundManual({
    tenantId: T, bookingId: "someone-elses", refundId: refund._id, reference: "UTR998877", reason: "Paid by bank transfer", evidenceNote: "Screenshot kept", userId: "s1",
  }), (e) => e.code === "RESOURCE_NOT_FOUND");
});

test("reminders pick the right bookings and a booking outside every window gets none", async () => {
  const p1 = await product(); const p2 = await product(); const p3 = await product();
  const v = await policy({ reminderHoursBeforeDue: [24, 6] });
  const due = await book(p1, v);               // advance due soon
  const far = await book(p2, v);               // advance due later
  await EcommerceBooking.collection.updateOne({ _id: due.booking._id }, { $set: { advanceDueAt: new Date(Date.now() + 5 * 60_000) } });
  const paid = await book(p3, v);
  await completed(paid.attempt);
  await EcommerceBooking.collection.updateOne({ _id: paid.booking._id }, { $set: { balanceDueAt: new Date(Date.now() + 5 * HOUR) } });

  const out = await runEcommerceBookingReminders(new Date());
  const keys = Object.keys(out.counts);
  assert.ok(keys.some((k) => k.startsWith("advance-due:")), JSON.stringify(out));
  assert.ok(keys.some((k) => k.startsWith("balance-due:")), JSON.stringify(out));
  assert.ok(!keys.some((k) => k.endsWith(":ERROR")), JSON.stringify(out));
  assert.equal(Object.entries(out.counts).filter(([k]) => k.startsWith("advance-due:")).reduce((n, [, c]) => n + c, 0), 1, "only the booking inside the window");
  assert.ok(far.booking._id);

  // A cancelled-and-refunded booking is picked up for the expiry and refund notices.
  await EcommerceBooking.collection.updateOne({ _id: far.booking._id }, { $set: { status: "EXPIRED" } });
  const again = await runEcommerceBookingReminders(new Date());
  assert.ok(Object.keys(again.counts).some((k) => k.startsWith("expired:")), JSON.stringify(again));
});

test("read models: customer view hides staff fields and other customers' bookings; staff view adds attempts and events", async () => {
  const { id } = await confirmedFixed();
  const mine = await getCustomerBooking({ tenantId: T, customerId: "cust1", bookingId: id });
  assert.equal(mine.status, "CONFIRMED");
  assert.equal(mine.advance.capturedPaise, mine.advance.requiredPaise);
  assert.equal("customerId" in mine, false);
  assert.equal("expiryDeferrals" in mine, false);
  await assert.rejects(() => getCustomerBooking({ tenantId: T, customerId: "cust2", bookingId: id }), (e) => e.code === "RESOURCE_NOT_FOUND");
  assert.equal((await listCustomerBookings({ tenantId: T, customerId: "cust2", limit: 10 })).items.length, 0);
  assert.equal((await listCustomerBookings({ tenantId: T, customerId: "cust1", limit: 10 })).items.length, 1);

  const staff = await getAdminBooking({ tenantId: T, bookingId: id });
  assert.equal(staff.customerId, "cust1");
  assert.equal(staff.attempts.length, 1);
  assert.equal(staff.attempts[0].purpose, "BOOKING_ADVANCE");
  const listed = await listAdminBookings({ tenantId: T, status: "CONFIRMED", limit: 10 });
  assert.equal(listed.items.length, 1);
  assert.equal((await listAdminBookings({ tenantId: T, status: "EXPIRED", limit: 10 })).items.length, 0);
  assert.equal((await listAdminBookings({ tenantId: "other-tenant", limit: 10 })).items.length, 0);
});

test("provider initiation: one provider order per attempt, replays reuse it, an uncertain failure is never retried blindly", async () => {
  const p1 = await product(); const p2 = await product(); const v = await policy();
  const a = await book(p1, v);
  let calls = 0;
  mock.method(phonePeProvider, "createSdkOrder", async () => { calls += 1; return { providerOrderId: "OMO-1", token: "tok-1", merchantOrderId: a.attempt._id }; });
  const args = (x) => ({ tenantId: T, attempt: x.attempt, booking: x.booking, redirectUrl: "https://shop.example/return", checkoutChannel: "sdk" });
  const first = await startBookingAttemptCheckout(args(a));
  assert.equal(first.created, true);
  assert.equal(first.paymentIntent.status, "INITIATED");
  assert.equal(first.paymentIntent.providerOrderId, "OMO-1");
  const row = await EcommercePaymentAttempt.findById(a.attempt._id).lean();
  assert.equal(row.operationalStatus, "AWAITING_PROVIDER");
  assert.equal(row.initiationClaimToken ?? null, null);
  const replay = await startBookingAttemptCheckout({ ...args(a), attempt: row });
  assert.equal(replay.created, false);
  assert.equal(calls, 1, "no second provider order");

  const b = await book(p2, v, "cust1");
  mock.restoreAll();
  mock.method(phonePeProvider, "createSdkOrder", async () => { calls += 1; throw new Error("socket hang up"); });
  await assert.rejects(() => startBookingAttemptCheckout(args(b)), (e) => e.code === "PAYMENT_INITIATION_UNCERTAIN");
  const uncertain = await EcommercePaymentAttempt.findById(b.attempt._id).lean();
  assert.equal(uncertain.operationalStatus, "INITIATION_UNCERTAIN");
  const callsAfterFailure = calls;
  await assert.rejects(() => startBookingAttemptCheckout({ ...args(b), attempt: uncertain }), (e) => e.code === "PAYMENT_INITIATION_UNCERTAIN");
  assert.equal(calls, callsAfterFailure, "an uncertain attempt is not sent to the provider again");
});

// ---- Branch scope: a branch user may only see and act on bookings picked up at their own branch ----
const OTHER = "br2";
const moveToBranch = (id, branch) => EcommerceBooking.collection.updateOne({ _id: id }, { $set: { pickupBranchId: branch } });
const notFound = (e) => e.code === "RESOURCE_NOT_FOUND" && e.statusCode === 404;

test("branch scope: a branch user lists only their branch and cannot widen it with a branch filter", async () => {
  const mine = await confirmedFixed();
  const theirs = await confirmedFixed();
  await moveToBranch(theirs.id, OTHER);

  const branchList = await listAdminBookings({ tenantId: T, branchId: BR, limit: 50 });
  assert.deepEqual(branchList.items.map((b) => b.id), [mine.id]);

  await assert.rejects(() => listAdminBookings({ tenantId: T, branchId: BR, pickupBranchId: OTHER, limit: 50 }), (e) => e.statusCode === 403);
  const narrowed = await listAdminBookings({ tenantId: T, branchId: BR, pickupBranchId: BR, status: "CONFIRMED", q: "BK", limit: 50 });
  assert.ok(narrowed.items.every((b) => b.pickupBranchId === BR));

  const tenantWide = await listAdminBookings({ tenantId: T, limit: 50 });
  assert.equal(tenantWide.items.length, 2);
  const filtered = await listAdminBookings({ tenantId: T, pickupBranchId: OTHER, limit: 50 });
  assert.deepEqual(filtered.items.map((b) => b.id), [theirs.id]);
});

test("branch scope: pagination cursors cannot be used to read past the branch boundary", async () => {
  const a = await confirmedFixed(); const b = await confirmedFixed(); const c = await confirmedFixed();
  await moveToBranch(b.id, OTHER);
  const first = await listAdminBookings({ tenantId: T, branchId: BR, limit: 1 });
  const second = await listAdminBookings({ tenantId: T, branchId: BR, limit: 1, cursor: first.meta.nextCursor });
  const seen = [...first.items, ...second.items].map((x) => x.id).sort();
  assert.deepEqual(seen, [a.id, c.id].sort());
  assert.equal(second.meta.hasMore, false);
});

test("branch scope: another branch's booking is not found for read, bill, requote, cancel and both refund actions, and nothing changes", async () => {
  const theirs = await confirmedFixed();
  await moveToBranch(theirs.id, OTHER);
  const before = await reload(theirs.id);

  await assert.rejects(() => getAdminBooking({ tenantId: T, bookingId: theirs.id, branchId: BR }), notFound);
  await assert.rejects(() => createBalanceQuote({ tenantId: T, bookingId: theirs.id, branchId: BR, actorId: "mgr1" }), notFound);
  await assert.rejects(() => requoteBalance({ tenantId: T, bookingId: theirs.id, branchId: BR, actorId: "mgr1", reason: "wrong rate used" }), notFound);
  await assert.rejects(() => cancelBooking({ tenantId: T, bookingId: theirs.id, branchId: BR, actorId: "mgr1", staff: true, waiveFee: true, reason: "not mine to cancel" }), notFound);
  await assert.rejects(() => recordBookingRefundManual({
    tenantId: T, bookingId: theirs.id, branchId: BR, refundId: "any", reference: "UTR12345", reason: "paid outside", evidenceNote: "bank slip", userId: "mgr1",
  }), notFound);
  await assert.rejects(() => retryBookingRefund({ tenantId: T, bookingId: theirs.id, branchId: BR, refundId: "any" }), notFound);

  const after = await reload(theirs.id);
  assert.equal(after.status, before.status);
  assert.equal(after.version, before.version);
  assert.equal((await refunds(theirs.id)).length, 0, "no refund was created");
});

test("branch scope: the same actions work for the booking's own branch and for a tenant-wide role", async () => {
  const mine = await confirmedFixed();
  assert.equal((await getAdminBooking({ tenantId: T, bookingId: mine.id, branchId: BR })).id, mine.id);
  const billed = await createBalanceQuote({ tenantId: T, bookingId: mine.id, branchId: BR, actorId: "mgr1" });
  assert.equal(billed.booking.status, "BALANCE_PENDING");
  const cancelled = await cancelBooking({ tenantId: T, bookingId: mine.id, branchId: BR, actorId: "mgr1", staff: true, reason: "customer asked at counter" });
  assert.equal(cancelled.booking.status, "CANCELLED");

  const other = await confirmedFixed();
  await moveToBranch(other.id, OTHER);
  assert.equal((await getAdminBooking({ tenantId: T, bookingId: other.id })).id, other.id, "tenant-wide role is not branch-limited");
});

test("branch scope: a booking refund cannot be touched through another booking of the caller's own branch", async () => {
  const mine = await confirmedFixed();
  const theirs = await confirmedFixed();
  await moveToBranch(theirs.id, OTHER);
  await cancelBooking({ tenantId: T, bookingId: theirs.id, actorId: "owner", staff: true, reason: "owner cancelled it" });
  const [refund] = await refunds(theirs.id);
  assert.ok(refund);
  await assert.rejects(() => recordBookingRefundManual({
    tenantId: T, bookingId: mine.id, branchId: BR, refundId: refund._id, reference: "UTR12345", reason: "paid outside", evidenceNote: "bank slip", userId: "mgr1",
  }), notFound);
  await assert.rejects(() => retryBookingRefund({ tenantId: T, bookingId: mine.id, branchId: BR, refundId: refund._id }), notFound);
  assert.equal((await EcommercePaymentExceptionRefund.findById(refund._id).lean()).status, refund.status);
});

test("booking alerts carry the pickup branch, so they reach that branch's staff and no other", async () => {
  await upsertOperationalAlert({ tenantId: T, type: "PAYMENT_REVIEW", entityId: "bk-x", title: "t", message: "m", branchId: OTHER });
  await upsertOperationalAlert({ tenantId: T, type: "PAYMENT_REVIEW", entityId: "bk-y", title: "t", message: "m", branchId: BR });
  const forBr1 = await Alert.find({ tenantId: T, branchId: BR }).lean();
  assert.deepEqual(forBr1.map((a) => a.entityId), ["bk-y"]);
});

test("policy admin refuses another tenant's branch, product or category, and unknown scopes", async () => {
  await Branch.collection.insertOne({ _id: "foreign-br", tenantId: "other-tenant", name: "Not ours" });
  const v = await policy();
  const draft = (ids) => createPolicyDraft({
    tenantId: T, policyKey: `scope-${Math.random()}`, name: "X",
    fields: { advance: { mode: "PERCENT", percentBps: 1000 }, rateRule: "BILLING_DAY", eligiblePickupBranchIds: ids },
  });
  await assert.rejects(() => draft(["foreign-br"]), (e) => e.code === "VALIDATION_FAILED");
  await assert.rejects(() => draft([BR, "nope"]), (e) => e.code === "VALIDATION_FAILED");
  assert.ok(await draft([BR]), "an own branch is accepted");
  const assign = (scopeType, scopeId) => setPolicyAssignment({ tenantId: T, scopeType, scopeId, bookingEnabled: true, policyVersionId: v._id });
  await assert.rejects(() => assign("BRANCH", "foreign-br"), (e) => e.code === "VALIDATION_FAILED");
  await assert.rejects(() => assign("PRODUCT", "not-a-product"), (e) => e.code === "VALIDATION_FAILED");
  await assert.rejects(() => assign("CATEGORY", "not-a-category"), (e) => e.code === "VALIDATION_FAILED");
  const p = await product();
  assert.ok(await assign("PRODUCT", String(p._id)));
});

test("a customer never sees provider failure detail on a booking refund; staff do", async () => {
  const { id } = await confirmedFixed();
  await cancelBooking({ tenantId: T, bookingId: id, customerId: "cust1", actorId: "cust1" });
  const [refund] = await refunds(id);
  await EcommercePaymentExceptionRefund.collection.updateOne({ _id: refund._id }, { $set: { failureReason: "PROVIDER_INITIATION_UNCERTAIN" } });
  const customer = await getCustomerBooking({ tenantId: T, customerId: "cust1", bookingId: id });
  assert.ok(!("failureReason" in customer.refunds[0]));
  const staff = await getAdminBooking({ tenantId: T, bookingId: id });
  assert.equal(staff.refunds[0].failureReason, "PROVIDER_INITIATION_UNCERTAIN");
  await assert.rejects(() => getCustomerBooking({ tenantId: T, customerId: "someone-else", bookingId: id }), notFound);
});

test("fee waiver: the waived amount, staff member and reason are recorded, and the audit hook runs inside the cancel", async () => {
  const { id } = await confirmedFixed();
  const before = await reload(id);
  const bps = before.policy.snapshot.cancellationFeeBps;
  const captured = before.advance.capturedPaise;
  assert.ok(bps > 0, "fixture policy charges a cancellation fee");
  const seen = [];
  const result = await cancelBooking({
    tenantId: T, bookingId: id, actorId: "owner1", staff: true, waiveFee: true, reason: "goodwill, long-time customer",
    onCancelled: async (info) => { seen.push({ waived: info.feeWaivedPaise, hasSession: Boolean(info.session) }); },
  });
  const expectedFee = Math.round((captured * bps) / 10_000);
  assert.equal(result.feePaise, 0);
  assert.equal(result.refundPaise, captured, "customer gets the whole advance back");
  assert.equal(result.feeWaivedPaise, expectedFee);
  assert.deepEqual(seen, [{ waived: expectedFee, hasSession: true }]);
  const row = await reload(id);
  assert.equal(row.cancellationFeeWaiver.by, "owner1");
  assert.equal(row.cancellationFeeWaiver.waivedPaise, expectedFee);
  assert.equal(row.cancelReason, "goodwill, long-time customer");
  const staff = await getAdminBooking({ tenantId: T, bookingId: id });
  assert.equal(staff.feeWaiver.by, "owner1");
});

test("fee waiver: a failing audit write rolls the cancel back, and a normal cancel records no waiver", async () => {
  const a = await confirmedFixed();
  await assert.rejects(() => cancelBooking({
    tenantId: T, bookingId: a.id, actorId: "owner1", staff: true, waiveFee: true, reason: "audit will fail here",
    onCancelled: async () => { throw new Error("audit down"); },
  }), /audit down/);
  assert.equal((await reload(a.id)).status, "CONFIRMED", "no audit, no cancel");
  assert.equal((await refunds(a.id)).length, 0);

  const b = await confirmedFixed();
  const normal = await cancelBooking({ tenantId: T, bookingId: b.id, branchId: BR, actorId: "mgr1", staff: true, reason: "customer asked at counter" });
  assert.ok(normal.feePaise > 0);
  assert.equal(normal.feeWaivedPaise, 0);
  assert.ok(!(await reload(b.id)).cancellationFeeWaiver?.by);
});
