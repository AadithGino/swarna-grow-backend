/**
 * Gateway handling of booking-owned payments (no order yet): confirm, fail, expire, late capture,
 * the reconcile scan, and the refund of an order-less capture through the provider webhook.
 */
import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  EcommercePaymentAttempt,
  EcommercePaymentAttemptEvent,
  EcommercePaymentExceptionRefund,
  Alert,
  Tenant,
} from "../src/models/index.js";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import {
  registerBookingPaymentHandlers,
  resetBookingPaymentHandlers,
} from "../src/lib/ecommerce-booking-payment-handlers.js";
import { processEcommercePhonePeWebhook, finalizeEcommercePaymentSuccess, finalizeEcommercePaymentTerminalFailure } from "../src/services/ecommerce-payment-finalize.service.js";
import {
  expireBookingPaymentAttempt,
  finalizeBookingPaymentSuccess,
  finalizeBookingPaymentTerminalFailure,
} from "../src/services/ecommerce-booking-payment.service.js";
import { attemptIdentity } from "../src/lib/ecommerce-payment-identity.js";
import { runEcommercePaymentReconcile } from "../src/services/ecommerce-payment-reconcile.service.js";
import {
  initiateBookingCaptureRefund,
  processEcommercePhonePeRefundWebhook,
} from "../src/services/ecommerce-payment-exception-refund.service.js";
import { resetTestDb } from "./helpers/db.js";

const TENANT = "bookpay-tenant";
const rupees = (n) => n * 100;

test.beforeEach(async () => { await resetTestDb(); resetBookingPaymentHandlers(); });
afterEach(() => { mock.restoreAll(); resetBookingPaymentHandlers(); });

const HOUR = 3_600_000;
const GRACE_MS = 300_000; // ECOMMERCE_PAYMENT_RECONCILE_GRACE_MS default

// Attempts are due by default (deadline in the past); tests that need a live one pass expiresAt.
async function advanceAttempt(id, fields = {}) {
  return EcommercePaymentAttempt.create({
    _id: id, tenantId: TENANT, customerId: "cust1", bookingId: "bk1", purpose: "BOOKING_ADVANCE",
    amountPaise: rupees(25_000), status: "PENDING", merchantOrderId: id, provider: "PHONEPE",
    expiresAt: new Date(Date.now() - HOUR), ...fields,
  });
}
// Provider reconciliation loads the tenant for its credentials.
const tenantRow = () => Tenant.collection.insertOne({ _id: TENANT, name: "t", status: "ACTIVE" });
const completedWebhook = (reference, overrides = {}) => ({
  tenantId: TENANT, webhookEventId: "wh1",
  normalized: { reference, transactionId: "tx1", payload: { amount: rupees(25_000) }, completed: true, failed: false, ...overrides },
});
const events = (attemptId) => EcommercePaymentAttemptEvent.find({ tenantId: TENANT, paymentAttemptId: attemptId }).sort({ at: 1 }).lean();

function recordingHandlers(decision = { accepted: true }) {
  const calls = { captured: [], failed: [], refundSettled: [] };
  registerBookingPaymentHandlers({
    onCaptured: async (args) => { calls.captured.push(args.attempt._id); return decision; },
    onFailed: async (args) => { calls.failed.push([args.attempt._id, args.reason]); },
    onRefundSettled: async (args) => { calls.refundSettled.push(args.refund._id); },
  });
  return calls;
}

test("a captured advance with no order confirms through the webhook, and a replay changes nothing", async () => {
  const calls = recordingHandlers();
  await advanceAttempt("epay_adv1");
  const first = await processEcommercePhonePeWebhook(completedWebhook("epay_adv1"));
  assert.equal(first.result.outcome, "SUCCESS");
  assert.equal(first.result.bookingId, "bk1");

  const row = await EcommercePaymentAttempt.findById("epay_adv1").lean();
  assert.equal(row.status, "SUCCEEDED");
  assert.equal(row.providerPaymentId, "tx1");
  assert.equal(row.orderId, undefined);

  const replay = await processEcommercePhonePeWebhook(completedWebhook("epay_adv1"));
  assert.equal(replay.result.outcome, "ALREADY_SUCCESS");
  assert.deepEqual(calls.captured, ["epay_adv1"], "the booking is told once");
  assert.equal(await EcommercePaymentExceptionRefund.countDocuments({ tenantId: TENANT }), 0);
  assert.deepEqual((await events("epay_adv1")).map((e) => e.outcome), ["SUCCESS"]);
});

test("a capture the booking cannot accept is refunded in full, once", async () => {
  const calls = recordingHandlers({ accepted: false, reason: "BOOKING_EXPIRED" });
  await advanceAttempt("epay_adv1");
  const first = await processEcommercePhonePeWebhook(completedWebhook("epay_adv1"));
  assert.equal(first.result.outcome, "LATE_CAPTURE_REFUND_ASSIGNED");
  await processEcommercePhonePeWebhook(completedWebhook("epay_adv1")); // gateway redelivery

  const refunds = await EcommercePaymentExceptionRefund.find({ tenantId: TENANT }).lean();
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amountPaise, rupees(25_000));
  assert.equal(refunds[0].status, "ASSIGNED");
  assert.equal(refunds[0].bookingId, "bk1");
  assert.equal(refunds[0].purpose, "BOOKING_ADVANCE");
  assert.equal(refunds[0].orderId, undefined);
  assert.equal(refunds[0].refundOperationId, "late-capture:epay_adv1");
  assert.equal(calls.captured.length, 1);
  assert.equal(await Alert.countDocuments({ tenantId: TENANT, entityId: "bk1" }), 1);
});

test("with no booking handler registered, a capture is refunded rather than kept", async () => {
  await advanceAttempt("epay_adv1");
  const result = await processEcommercePhonePeWebhook(completedWebhook("epay_adv1"));
  assert.equal(result.result.outcome, "LATE_CAPTURE_REFUND_ASSIGNED");
  assert.equal(result.result.reason, "BOOKING_HANDLER_NOT_REGISTERED");
});

test("a handler that throws rolls the whole confirmation back so the delivery can retry", async () => {
  registerBookingPaymentHandlers({ onCaptured: async () => { throw new Error("booking db down"); } });
  await advanceAttempt("epay_adv1");
  await assert.rejects(processEcommercePhonePeWebhook(completedWebhook("epay_adv1")), /booking db down/);
  assert.equal((await EcommercePaymentAttempt.findById("epay_adv1").lean()).status, "PENDING");
  assert.equal(await EcommercePaymentExceptionRefund.countDocuments({ tenantId: TENANT }), 0);
});

test("an amount or currency mismatch records an event and changes nothing", async () => {
  const calls = recordingHandlers();
  await advanceAttempt("epay_adv1");
  const wrong = await finalizeEcommercePaymentSuccess({
    tenantId: TENANT, merchantOrderId: "epay_adv1", transactionId: "tx1", amountPaise: rupees(1),
  });
  assert.equal(wrong.outcome, "AMOUNT_MISMATCH");
  const currency = await finalizeEcommercePaymentSuccess({
    tenantId: TENANT, merchantOrderId: "epay_adv1", transactionId: "tx1", amountPaise: rupees(25_000), currency: "USD",
  });
  assert.equal(currency.outcome, "CURRENCY_MISMATCH");
  assert.equal((await EcommercePaymentAttempt.findById("epay_adv1").lean()).status, "PENDING");
  assert.equal(calls.captured.length, 0);
  assert.deepEqual((await events("epay_adv1")).map((e) => e.outcome), ["AMOUNT_MISMATCH", "CURRENCY_MISMATCH"]);
});

test("a terminal failure fails the attempt; a later verified capture still confirms it", async () => {
  const calls = recordingHandlers();
  await advanceAttempt("epay_adv1");
  const failed = await processEcommercePhonePeWebhook({
    tenantId: TENANT, webhookEventId: "wh0",
    normalized: { reference: "epay_adv1", transactionId: "tx0", payload: {}, completed: false, failed: true, type: "CHECKOUT_ORDER_FAILED" },
  });
  assert.equal(failed.result.outcome, "FAILED");
  assert.deepEqual(calls.failed, [["epay_adv1", "FAILED"]]);

  const late = await processEcommercePhonePeWebhook(completedWebhook("epay_adv1"));
  assert.equal(late.result.outcome, "SUCCESS");
  assert.equal((await EcommercePaymentAttempt.findById("epay_adv1").lean()).status, "SUCCEEDED");
});

test("expiry: an unpaid attempt that never reached the provider expires once its deadline has passed", async () => {
  const calls = recordingHandlers();
  await advanceAttempt("epay_plain");
  const expired = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_plain" });
  assert.equal(expired.outcome, "EXPIRED");
  assert.deepEqual(calls.failed, [["epay_plain", "EXPIRED"]]);
  assert.equal((await EcommercePaymentAttempt.findById("epay_plain").lean()).status, "EXPIRED");
  assert.equal((await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_plain" })).outcome, "NOT_ACTIVE");
});

test("expiry never closes an attempt before its persisted deadline", async () => {
  const calls = recordingHandlers();
  await advanceAttempt("epay_future", { expiresAt: new Date(Date.now() + HOUR) });
  const early = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_future" });
  assert.equal(early.outcome, "NOT_DUE");
  assert.equal((await EcommercePaymentAttempt.findById("epay_future").lean()).status, "PENDING");
  assert.deepEqual(calls.failed, []);

  // Also not when the caller's clock says it is due but the attempt has no deadline at all.
  await advanceAttempt("epay_nodeadline", { bookingId: "bk2" });
  await EcommercePaymentAttempt.collection.updateOne({ _id: "epay_nodeadline" }, { $unset: { expiresAt: "" } });
  assert.equal((await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_nodeadline" })).outcome, "NO_DEADLINE");

  // Once the deadline passes it can expire.
  const due = await expireBookingPaymentAttempt({
    tenantId: TENANT, attemptId: "epay_future", at: new Date(Date.now() + 2 * HOUR),
  });
  assert.equal(due.outcome, "EXPIRED");
});

test("expiry leaves an attempt the provider may still capture inside its in-flight window", async () => {
  recordingHandlers();
  // PENDING with a provider order (MOCK so no poll): the provider may still capture it.
  await advanceAttempt("epay_live", { providerOrderId: "po1", provider: "MOCK" });
  const blocked = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_live" });
  assert.equal(blocked.outcome, "IN_FLIGHT");
  assert.equal((await EcommercePaymentAttempt.findById("epay_live").lean()).status, "PENDING");
});

test("expiry asks the provider first: an attempt that was actually paid is confirmed, not expired", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_paid", { providerOrderId: "po-paid" });
  mock.method(phonePeProvider, "getOrderStatus", async () => ({
    state: "COMPLETED", amount: rupees(25_000), paymentDetails: [{ state: "COMPLETED", transactionId: "txp" }],
  }));
  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_paid" });
  assert.equal(result.outcome, "NOT_ACTIVE");
  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(calls.captured, ["epay_paid"]);
  assert.deepEqual(calls.failed, []);
});

test("a provider outage never expires the attempt, even long after the grace window", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  const longAgo = new Date(Date.now() - 2 * HOUR - GRACE_MS);
  await advanceAttempt("epay_outage", { status: "INITIATED", providerOrderId: "po-x", expiresAt: longAgo });
  const poll = mock.method(phonePeProvider, "getOrderStatus", async () => { throw new Error("PhonePe 503"); });

  const first = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_outage" });
  assert.equal(first.outcome, "PROVIDER_UNRESOLVED");
  assert.equal(first.providerOutcome, "POLL_FAILED");
  assert.equal((await EcommercePaymentAttempt.findById("epay_outage").lean()).status, "INITIATED");
  assert.deepEqual(calls.failed, []);

  // The next try, with the provider back and reporting the order still unpaid, expires it.
  poll.mock.restore();
  mock.method(phonePeProvider, "getOrderStatus", async () => ({ state: "PENDING", amount: rupees(25_000), paymentDetails: [] }));
  const second = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_outage" });
  assert.equal(second.outcome, "EXPIRED");
  assert.deepEqual(calls.failed, [["epay_outage", "EXPIRED"]]);
});

test("a provider outage followed by a capture: the payment is confirmed, not lost", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_late", { status: "INITIATED", providerOrderId: "po-y", expiresAt: new Date(Date.now() - 2 * HOUR) });
  mock.method(phonePeProvider, "getOrderStatus", async () => { throw new Error("timeout"); });
  assert.equal((await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_late" })).outcome, "PROVIDER_UNRESOLVED");
  mock.restoreAll();
  mock.method(phonePeProvider, "getOrderStatus", async () => ({
    state: "COMPLETED", amount: rupees(25_000), paymentDetails: [{ state: "COMPLETED", transactionId: "tx-late" }],
  }));
  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_late" });
  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(calls.captured, ["epay_late"]);
});

test("a missing tenant is an unknown provider outcome, not a reason to expire", async () => {
  recordingHandlers();
  await advanceAttempt("epay_notenant", { status: "INITIATED", providerOrderId: "po-z", expiresAt: new Date(Date.now() - 2 * HOUR) });
  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_notenant" });
  assert.equal(result.outcome, "PROVIDER_UNRESOLVED");
  assert.equal(result.providerOutcome, "TENANT_MISSING");
  assert.equal((await EcommercePaymentAttempt.findById("epay_notenant").lean()).status, "INITIATED");
});

// Serves the first `stale` reads of the attempt as they were, then lets `mutate` run, so the
// expiry sees one state and writes against another: what a concurrent initiation does.
function staleReads(attemptId, stale, mutate) {
  const original = EcommercePaymentAttempt.findOne.bind(EcommercePaymentAttempt);
  let served = 0;
  mock.method(EcommercePaymentAttempt, "findOne", (...args) => {
    const query = original(...args);
    if (served >= stale || args[0]?._id !== attemptId) return query;
    served += 1;
    const n = served;
    return {
      lean: async () => {
        const doc = await query.lean();
        await mutate(n);
        return doc;
      },
    };
  });
}
const initiate = (attemptId, providerOrderId = "po-race") => () =>
  EcommercePaymentAttempt.collection.updateOne(
    { _id: attemptId },
    { $set: { status: "INITIATED", providerOrderId } },
  );

test("an empty or unrecognized provider response never expires the attempt", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_blank", { status: "INITIATED", providerOrderId: "po-b", expiresAt: new Date(Date.now() - 2 * HOUR) });
  for (const payload of [{}, { state: "" }, { state: "SOMETHING_NEW" }, { state: "pending_review" }]) {
    mock.restoreAll();
    mock.method(phonePeProvider, "getOrderStatus", async () => payload);
    const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_blank" });
    assert.equal(result.outcome, "PROVIDER_UNRESOLVED", JSON.stringify(payload));
    assert.equal(result.providerOutcome, "STILL_PENDING");
    assert.equal((await EcommercePaymentAttempt.findById("epay_blank").lean()).status, "INITIATED");
  }
  assert.deepEqual(calls.failed, []);

  // A recognized pending answer still lets it expire, in either letter case.
  mock.restoreAll();
  mock.method(phonePeProvider, "getOrderStatus", async () => ({ state: "pending" }));
  assert.equal((await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_blank" })).outcome, "EXPIRED");
});

test("expiry racing payment initiation does not expire the attempt: it is reevaluated and polled", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_race"); // PENDING, no provider order: the first pass would expire it unpolled
  const poll = mock.method(phonePeProvider, "getOrderStatus", async () => ({
    state: "COMPLETED", amount: rupees(25_000), paymentDetails: [{ state: "COMPLETED", transactionId: "tx-race" }],
  }));
  staleReads("epay_race", 1, initiate("epay_race"));

  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_race" });
  assert.equal(result.outcome, "NOT_ACTIVE");
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(poll.mock.callCount(), 1, "the second pass asked the provider");
  assert.deepEqual(calls.captured, ["epay_race"]);
  assert.deepEqual(calls.failed, []);
});

test("expiry racing initiation with an unresolved provider leaves the attempt active", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_race2");
  mock.method(phonePeProvider, "getOrderStatus", async () => ({}));
  staleReads("epay_race2", 1, initiate("epay_race2"));

  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_race2" });
  assert.equal(result.outcome, "PROVIDER_UNRESOLVED");
  const row = await EcommercePaymentAttempt.findById("epay_race2").lean();
  assert.equal(row.status, "INITIATED");
  assert.equal(row.providerOrderId, "po-race");
  assert.deepEqual(calls.failed, []);
});

test("an attempt that keeps changing under the expiry is reported, not expired", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_churn");
  mock.method(phonePeProvider, "getOrderStatus", async () => ({ state: "PENDING", amount: rupees(25_000), paymentDetails: [] }));
  staleReads("epay_churn", 10, (n) =>
    EcommercePaymentAttempt.collection.updateOne({ _id: "epay_churn" }, { $set: { status: "INITIATED", providerOrderId: `po-${n}` } }),
  );

  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_churn" });
  assert.equal(result.outcome, "CHANGED_CONCURRENTLY");
  assert.equal((await EcommercePaymentAttempt.findById("epay_churn").lean()).status, "INITIATED");
  assert.deepEqual(calls.failed, []);
});

const setFields = (attemptId, $set) => () => EcommercePaymentAttempt.collection.updateOne({ _id: attemptId }, { $set });
const liveClaim = () => ({ initiationClaimToken: "CLAIM-live", initiationClaimExpiresAt: new Date(Date.now() + 5 * 60_000) });

test("a live initiation claim keeps a PENDING attempt in flight, with no poll and no expiry", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  const poll = mock.method(phonePeProvider, "getOrderStatus", async () => ({ state: "PENDING" }));
  await advanceAttempt("epay_claim", liveClaim());

  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_claim" });
  assert.equal(result.outcome, "IN_FLIGHT");
  assert.equal((await EcommercePaymentAttempt.findById("epay_claim").lean()).status, "PENDING");
  assert.equal(poll.mock.callCount(), 0);
  assert.deepEqual(calls.failed, []);

  // MOCK provider attempts are not polled, but a live claim still holds them.
  await advanceAttempt("epay_claim_mock", { ...liveClaim(), provider: "MOCK", bookingId: "bk2" });
  assert.equal((await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_claim_mock" })).outcome, "IN_FLIGHT");
});

test("an uncertain initiation is reconciled before it can expire", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  // INITIATION_UNCERTAIN, still PENDING, no provider order id, no claim.
  await advanceAttempt("epay_unc", { operationalStatus: "INITIATION_UNCERTAIN" });

  mock.method(phonePeProvider, "getOrderStatus", async () => ({}));
  const unresolved = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_unc" });
  assert.equal(unresolved.outcome, "PROVIDER_UNRESOLVED");
  assert.equal((await EcommercePaymentAttempt.findById("epay_unc").lean()).status, "PENDING");

  // The provider says it was paid: confirmed, not expired.
  mock.restoreAll();
  mock.method(phonePeProvider, "getOrderStatus", async () => ({
    state: "COMPLETED", amount: rupees(25_000), paymentDetails: [{ state: "COMPLETED", transactionId: "tx-unc" }],
  }));
  const paid = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_unc" });
  assert.equal(paid.status, "SUCCEEDED");
  assert.deepEqual(calls.captured, ["epay_unc"]);
  assert.deepEqual(calls.failed, []);
});

test("an uncertain initiation expires only after the provider confirms the order is still open", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_unc2", { operationalStatus: "INITIATION_UNCERTAIN" });
  const poll = mock.method(phonePeProvider, "getOrderStatus", async () => ({ state: "PENDING" }));
  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_unc2" });
  assert.equal(result.outcome, "EXPIRED");
  assert.equal(poll.mock.callCount(), 1);
  assert.deepEqual(calls.failed, [["epay_unc2", "EXPIRED"]]);
});

test("a lapsed claim token with no provider order means initiation died unrecorded: poll first", async () => {
  recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_lapsed", { initiationClaimToken: "CLAIM-old", initiationClaimExpiresAt: new Date(Date.now() - 10 * 60_000) });
  const poll = mock.method(phonePeProvider, "getOrderStatus", async () => ({}));
  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_lapsed" });
  assert.equal(result.outcome, "PROVIDER_UNRESOLVED");
  assert.equal(poll.mock.callCount(), 1);
  assert.equal((await EcommercePaymentAttempt.findById("epay_lapsed").lean()).status, "PENDING");
});

test("a claim or uncertainty that appears between the read and the expiry write stops the expiry", async () => {
  const calls = recordingHandlers();
  await tenantRow();

  // A claim starts after the read. Pass 2 sees it live.
  await advanceAttempt("epay_late_claim");
  const poll = mock.method(phonePeProvider, "getOrderStatus", async () => ({ state: "PENDING" }));
  staleReads("epay_late_claim", 1, setFields("epay_late_claim", liveClaim()));
  const claimed = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_late_claim" });
  assert.equal(claimed.outcome, "IN_FLIGHT");
  assert.equal((await EcommercePaymentAttempt.findById("epay_late_claim").lean()).status, "PENDING");
  assert.equal(poll.mock.callCount(), 0);

  // The attempt is marked uncertain after the read. Pass 2 polls before deciding.
  mock.restoreAll();
  await advanceAttempt("epay_late_unc", { bookingId: "bk2" });
  const poll2 = mock.method(phonePeProvider, "getOrderStatus", async () => ({}));
  staleReads("epay_late_unc", 1, setFields("epay_late_unc", { operationalStatus: "INITIATION_UNCERTAIN" }));
  const marked = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_late_unc" });
  assert.equal(marked.outcome, "PROVIDER_UNRESOLVED");
  assert.equal(poll2.mock.callCount(), 1);
  assert.equal((await EcommercePaymentAttempt.findById("epay_late_unc").lean()).status, "PENDING");
  assert.deepEqual(calls.failed, []);
});

test("a poll answer is discarded when the payment identity changed while it was in flight", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_ident", { status: "INITIATED", providerOrderId: "po-a", merchantOrderId: "m-a", expiresAt: new Date(Date.now() - 2 * HOUR) });

  let n = 0;
  const poll = mock.method(phonePeProvider, "getOrderStatus", async () => {
    n += 1;
    if (n === 1) {
      // While the first answer is on its way, the attempt is re-created at the provider.
      await EcommercePaymentAttempt.collection.updateOne(
        { _id: "epay_ident" },
        { $set: { provider: "PHONEPE_V2", providerOrderId: "po-b", merchantOrderId: "m-b" } },
      );
      return { state: "PENDING" }; // true for the old order only
    }
    return {}; // the new order has no usable answer yet
  });

  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_ident" });
  assert.notEqual(result.outcome, "EXPIRED");
  assert.equal(result.outcome, "PROVIDER_UNRESOLVED");
  assert.deepEqual(poll.mock.calls.map((c) => c.arguments[0]), ["m-a", "m-b"], "the new identity was asked about");
  assert.equal((await EcommercePaymentAttempt.findById("epay_ident").lean()).status, "INITIATED");
  assert.deepEqual(calls.failed, []);
});

test("an identity that keeps changing during polls is reported, not expired", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_ident2", { status: "INITIATED", providerOrderId: "po-0", merchantOrderId: "m-0", expiresAt: new Date(Date.now() - 2 * HOUR) });
  let n = 0;
  mock.method(phonePeProvider, "getOrderStatus", async () => {
    n += 1;
    await EcommercePaymentAttempt.collection.updateOne({ _id: "epay_ident2" }, { $set: { providerOrderId: `po-${n}`, merchantOrderId: `m-${n}` } });
    return { state: "PENDING" };
  });
  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_ident2" });
  assert.equal(result.outcome, "CHANGED_CONCURRENTLY");
  assert.equal((await EcommercePaymentAttempt.findById("epay_ident2").lean()).status, "INITIATED");
  assert.deepEqual(calls.failed, []);
});

const reload = (id) => EcommercePaymentAttempt.findById(id).lean();
const completedStatus = (txn) => ({ state: "COMPLETED", amount: rupees(25_000), paymentDetails: [{ state: "COMPLETED", transactionId: txn }] });

test("reconciliation progress does not erase the evidence that initiation may have reached the provider", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  // Marked uncertain before the evidence field existed: only operationalStatus says so.
  await advanceAttempt("epay_ev", { operationalStatus: "INITIATION_UNCERTAIN" });

  mock.method(phonePeProvider, "getOrderStatus", async () => ({}));
  assert.equal((await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_ev" })).outcome, "PROVIDER_UNRESOLVED");
  const after = await reload("epay_ev");
  assert.equal(after.operationalStatus, "AWAITING_PROVIDER", "progress rewrote the workflow state");
  assert.ok(after.initiationUncertainAt, "but the evidence survived");

  // Next pass: no provider order id, no claim, workflow state rewritten. It must still poll.
  const poll = mock.method(phonePeProvider, "getOrderStatus", async () => ({}));
  assert.equal((await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_ev" })).outcome, "PROVIDER_UNRESOLVED");
  assert.equal(poll.mock.callCount(), 1);
  assert.deepEqual(calls.failed, []);

  // The capture then arrives and is confirmed.
  mock.restoreAll();
  mock.method(phonePeProvider, "getOrderStatus", async () => completedStatus("tx-ev"));
  const paid = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_ev" });
  assert.equal(paid.status, "SUCCEEDED");
  assert.deepEqual(calls.captured, ["epay_ev"]);
  assert.deepEqual(calls.failed, []);
});

test("an operator acknowledgement or STUCK_RECONCILE does not let an uncertain initiation expire unpolled", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  for (const [id, operationalStatus] of [["epay_ack", "AWAITING_PROVIDER"], ["epay_stuck", "STUCK_RECONCILE"], ["epay_norm", "NORMAL"]]) {
    await advanceAttempt(id, { operationalStatus, initiationUncertainAt: new Date(Date.now() - HOUR), bookingId: `bk-${id}` });
    const poll = mock.method(phonePeProvider, "getOrderStatus", async () => ({ state: "SOMETHING_NEW" }));
    const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: id });
    assert.equal(result.outcome, "PROVIDER_UNRESOLVED", id);
    assert.equal(poll.mock.callCount(), 1, id);
    mock.restoreAll();
  }
  assert.deepEqual(calls.failed, []);

  // A recognized pending answer is what finally allows expiry, and it is still asked every time.
  const poll = mock.method(phonePeProvider, "getOrderStatus", async () => ({ state: "PENDING" }));
  assert.equal((await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_ack" })).outcome, "EXPIRED");
  assert.equal(poll.mock.callCount(), 1);
});

test("a stale terminal response for the old order never fails the attempt", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_stale", { status: "INITIATED", providerOrderId: "po-a", expiresAt: new Date(Date.now() - 2 * HOUR) });

  let n = 0;
  const poll = mock.method(phonePeProvider, "getOrderStatus", async () => {
    n += 1;
    if (n === 1) {
      await EcommercePaymentAttempt.collection.updateOne({ _id: "epay_stale" }, { $set: { providerOrderId: "po-b" } });
      return { state: "FAILED" }; // the old order failed; the attempt now stands for another
    }
    return {};
  });
  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_stale" });
  assert.equal(result.outcome, "PROVIDER_UNRESOLVED");
  assert.equal(poll.mock.callCount(), 2, "the new identity was polled again");
  const row = await reload("epay_stale");
  assert.equal(row.status, "INITIATED");
  assert.equal(row.providerOrderId, "po-b");
  assert.deepEqual(calls.failed, []);
});

test("a stale completed response or a changed merchant id is also discarded", async () => {
  const calls = recordingHandlers();
  await tenantRow();
  await advanceAttempt("epay_stale2", { status: "INITIATED", providerOrderId: "po-a", merchantOrderId: "m-a", expiresAt: new Date(Date.now() - 2 * HOUR) });
  let n = 0;
  mock.method(phonePeProvider, "getOrderStatus", async () => {
    n += 1;
    if (n === 1) {
      await EcommercePaymentAttempt.collection.updateOne(
        { _id: "epay_stale2" }, { $set: { providerOrderId: "po-b", merchantOrderId: "m-b" } });
      return completedStatus("tx-old");
    }
    return {};
  });
  const result = await expireBookingPaymentAttempt({ tenantId: TENANT, attemptId: "epay_stale2" });
  assert.equal(result.outcome, "PROVIDER_UNRESOLVED");
  const row = await reload("epay_stale2");
  assert.equal(row.status, "INITIATED");
  assert.notEqual(row.providerPaymentId, "tx-old");
  assert.deepEqual(calls.captured, []);
  assert.deepEqual(calls.failed, []);
});

test("the guarded write itself refuses a result that was computed for another identity", async () => {
  const calls = recordingHandlers();
  await advanceAttempt("epay_guard", { status: "INITIATED", providerOrderId: "po-a" });
  const snapshot = await reload("epay_guard");
  const expectedIdentity = attemptIdentity(snapshot);
  await EcommercePaymentAttempt.collection.updateOne({ _id: "epay_guard" }, { $set: { providerOrderId: "po-b" } });

  // The caller still holds the old snapshot, so only the conditional write can notice.
  const failed = await finalizeBookingPaymentTerminalFailure({ attempt: snapshot, expectedIdentity, reason: "X" });
  assert.equal(failed.outcome, "IDENTITY_CHANGED");
  const paid = await finalizeBookingPaymentSuccess({
    attempt: snapshot, expectedIdentity, transactionId: "tx", amountPaise: rupees(25_000), providerPayload: {},
  });
  assert.equal(paid.outcome, "IDENTITY_CHANGED");
  assert.equal((await reload("epay_guard")).status, "INITIATED");
  assert.deepEqual(calls.failed, []);
  assert.deepEqual(calls.captured, []);

  // Without an expected identity (webhooks) behavior is unchanged.
  const webhookFail = await finalizeBookingPaymentTerminalFailure({ attempt: snapshot, reason: "X" });
  assert.equal(webhookFail.outcome, "FAILED");
});

test("an order-bound attempt's terminal failure is guarded by identity too", async () => {
  await EcommercePaymentAttempt.collection.insertOne({
    _id: "epay_order1", tenantId: TENANT, orderId: "ord1", customerId: "cust1", amountPaise: 100, status: "INITIATED",
    provider: "PHONEPE", merchantOrderId: "epay_order1", providerOrderId: "po-a",
  });
  const expectedIdentity = attemptIdentity(await reload("epay_order1"));
  await EcommercePaymentAttempt.collection.updateOne({ _id: "epay_order1" }, { $set: { providerOrderId: "po-b" } });
  const stale = await finalizeEcommercePaymentTerminalFailure({
    tenantId: TENANT, merchantOrderId: "epay_order1", providerPayload: {}, reason: "X", expectedIdentity,
  });
  assert.equal(stale.outcome, "IDENTITY_CHANGED");
  assert.equal((await reload("epay_order1")).status, "INITIATED");
  const current = await finalizeEcommercePaymentTerminalFailure({
    tenantId: TENANT, merchantOrderId: "epay_order1", providerPayload: {}, reason: "X",
    expectedIdentity: attemptIdentity(await reload("epay_order1")),
  });
  assert.equal(current.outcome, "FAILED");
  assert.equal((await reload("epay_order1")).status, "FAILED");
});

test("the reconcile scan picks up booking attempts alongside order attempts", async () => {
  const stale = new Date(Date.now() - 3_600_000);
  const base = { tenantId: TENANT, customerId: "cust1", amountPaise: 100, status: "INITIATED" };
  await EcommercePaymentAttempt.collection.insertMany([
    { ...base, _id: "legacy", orderId: "ord1", createdAt: stale, updatedAt: stale },
    { ...base, _id: "booking", bookingId: "bk1", purpose: "BOOKING_ADVANCE", createdAt: stale, updatedAt: stale },
  ]);
  const summary = await runEcommercePaymentReconcile(new Date());
  assert.equal(summary.scanned, 2);
  assert.equal(summary.outcomes.TENANT_MISSING, 2, JSON.stringify(summary.outcomes));
});

test("the reconcile path confirms a paid booking attempt the webhook never delivered", async () => {
  const calls = recordingHandlers();
  const stale = new Date(Date.now() - 3_600_000);
  await advanceAttempt("epay_adv1", { providerOrderId: "po1", status: "INITIATED" });
  await EcommercePaymentAttempt.collection.updateOne({ _id: "epay_adv1" }, { $set: { createdAt: stale, updatedAt: stale } });
  await tenantRow();
  mock.method(phonePeProvider, "getOrderStatus", async () => ({
    state: "COMPLETED", amount: rupees(25_000), paymentDetails: [{ state: "COMPLETED", transactionId: "tx-rec" }],
  }));
  const summary = await runEcommercePaymentReconcile(new Date());
  assert.equal(summary.outcomes.SUCCESS, 1, JSON.stringify(summary.outcomes));
  assert.equal((await EcommercePaymentAttempt.findById("epay_adv1").lean()).status, "SUCCEEDED");
  assert.deepEqual(calls.captured, ["epay_adv1"]);
});

async function assignedLateRefund() {
  recordingHandlers({ accepted: false, reason: "BOOKING_CANCELLED" });
  await advanceAttempt("epay_adv1");
  await processEcommercePhonePeWebhook(completedWebhook("epay_adv1"));
  return EcommercePaymentExceptionRefund.findOne({ tenantId: TENANT }).lean();
}

test("an order-less refund is initiated, then confirmed by the provider webhook, and the booking is told", async () => {
  const refund = await assignedLateRefund();
  const initiate = mock.method(phonePeProvider, "initiateRefund", async ({ merchantRefundId, amountPaise }) => ({
    refundId: merchantRefundId, state: "PENDING", amount: amountPaise,
  }));
  const started = await initiateBookingCaptureRefund({ tenantId: TENANT, refundId: refund._id });
  assert.equal(started.initiated, true);
  assert.equal(started.refund.status, "PROVIDER_PENDING");
  assert.equal(initiate.mock.callCount(), 1);
  assert.equal(initiate.mock.calls[0].arguments[0].originalMerchantOrderId, "epay_adv1");

  // Starting again while in flight does not call the provider twice.
  const again = await initiateBookingCaptureRefund({ tenantId: TENANT, refundId: refund._id });
  assert.equal(again.inFlight, true);
  assert.equal(initiate.mock.callCount(), 1);

  const calls = recordingHandlers();
  const webhook = {
    tenantId: TENANT, type: "PG_REFUND_COMPLETED", providerEventId: "pe1",
    payload: { refundId: refund._id, originalMerchantOrderId: "epay_adv1", amount: refund.amountPaise, currency: "INR" },
  };
  const done = await processEcommercePhonePeRefundWebhook(webhook);
  assert.equal(done.outcome, "SUCCEEDED");
  assert.equal((await EcommercePaymentExceptionRefund.findById(refund._id).lean()).status, "SUCCEEDED");
  assert.deepEqual(calls.refundSettled, [refund._id]);

  const replay = await processEcommercePhonePeRefundWebhook(webhook);
  assert.equal(replay.outcome, "ALREADY_CLOSED");
  assert.equal(calls.refundSettled.length, 1);
});

test("an order-less refund that fails at the provider can be retried with the same row", async () => {
  const refund = await assignedLateRefund();
  mock.method(phonePeProvider, "initiateRefund", async ({ merchantRefundId, amountPaise }) => ({
    refundId: merchantRefundId, state: "PENDING", amount: amountPaise,
  }));
  await initiateBookingCaptureRefund({ tenantId: TENANT, refundId: refund._id });
  const failure = await processEcommercePhonePeRefundWebhook({
    tenantId: TENANT, type: "PG_REFUND_FAILED", providerEventId: "pe2",
    payload: { refundId: refund._id, originalMerchantOrderId: "epay_adv1", reason: "INSUFFICIENT_BALANCE" },
  });
  assert.equal(failure.outcome, "FAILED");
  assert.equal((await EcommercePaymentExceptionRefund.findById(refund._id).lean()).status, "FAILED");

  const retry = await initiateBookingCaptureRefund({ tenantId: TENANT, refundId: refund._id });
  assert.equal(retry.initiated, true);
  assert.equal(await EcommercePaymentExceptionRefund.countDocuments({ tenantId: TENANT }), 1);
});

test("an order-owned refund is not started through the booking path", async () => {
  await EcommercePaymentAttempt.create({
    _id: "epay_o", tenantId: TENANT, customerId: "c", orderId: "ord1", amountPaise: 100, status: "SUCCEEDED", merchantOrderId: "epay_o",
  });
  await EcommercePaymentExceptionRefund.create({
    _id: "epayref_o", tenantId: TENANT, orderId: "ord1", paymentAttemptId: "epay_o", amountPaise: 100,
    merchantOrderId: "epay_o", status: "ASSIGNED", refundSource: "PAYMENT_EXCEPTION", refundOperationId: "exception:epay_o",
  });
  await assert.rejects(initiateBookingCaptureRefund({ tenantId: TENANT, refundId: "epayref_o" }), { code: "REFUND_ORDER_OWNED" });
});
