/**
 * End-to-end advance booking over HTTP: real routes, real auth tokens, real MongoDB, real webhook
 * processing. Only the PhonePe network calls are replaced (PROVIDER_MODE=mock).
 *
 *   admin: policy -> assignment -> booking list/detail -> bill -> cancel (+ waiver authority) -> refunds
 *   customer: preview -> book -> pay advance -> status -> pay balance -> order; cancel, refund status
 *   safety: branch scope, customer isolation, payments flag, stock hold, expiry, reminders
 */
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import {
  AuditEvent, Branch, EcommerceBooking, EcommerceStockReservation, EcommerceFulfilmentSettings, EcommerceGoldRate, EcommerceInventory,
  EcommerceOrder, EcommerceProduct, EcommercePaymentAttempt, EcommercePaymentExceptionRefund, Session, User,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { installBookingPaymentHandlers } from "../src/services/ecommerce-booking.service.js";
import { runEcommerceBookingExpiry } from "../src/services/ecommerce-booking-expiry.service.js";
import { runEcommerceBookingReminders } from "../src/services/ecommerce-booking-reminder.service.js";
import { customerToken, postCompletedWebhook, postRefundWebhookHttp, seedReady } from "./helpers/ecommerce-payment-test-flow.js";
import { bearerFor, resetTestDb, seedBranch, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { disableEcommercePaymentsTestHarness, enableEcommercePaymentsTestHarness } from "./helpers/ecommerce-checkout-fixtures.js";

const app = createApp();
const API = "/api/v1";
const HOUR = 3_600_000;
const WAIVE = "ecommerce.booking.fee.waive";

test.before(async () => { await startTestDb(); installBookingPaymentHandlers(); /* server.js and the worker do this at start-up */ });
test.after(async () => { await stopTestDb(); });

let w; // the world: tenant, branches, people, tokens
test.beforeEach(async () => {
  await resetTestDb();
  enableEcommercePaymentsTestHarness();
  process.env.ECOMMERCE_BOOKING_PAYMENTS_ENABLED = "true";
  w = await buildWorld();
});
test.afterEach(() => { delete process.env.ECOMMERCE_BOOKING_PAYMENTS_ENABLED; });

const idem = () => createId("idem");
const staffHeaders = (token) => ({ authorization: `Bearer ${token}`, "x-idempotency-key": idem() });
const admin = (token = w.ownerToken) => ({
  get: (path) => request(app).get(`${API}/admin${path}`).set(staffHeaders(token)),
  post: (path, body = {}) => request(app).post(`${API}/admin${path}`).set(staffHeaders(token)).send(body),
  put: (path, body = {}) => request(app).put(`${API}/admin${path}`).set(staffHeaders(token)).send(body),
  patch: (path, body = {}) => request(app).patch(`${API}/admin${path}`).set(staffHeaders(token)).send(body),
});
const shop = (token) => ({
  get: (path) => request(app).get(`${API}/app/shop${path}`).set({ authorization: `Bearer ${token}` }),
  post: (path, body = {}, key = idem()) => request(app).post(`${API}/app/shop${path}`).set({ authorization: `Bearer ${token}`, "x-idempotency-key": key }).send(body),
});

async function seedStaff({ tenant, branch, role, permissions, mobile }) {
  const user = await User.create({
    _id: createId("user"), type: "TENANT_USER", tenantId: tenant._id, branchId: branch._id, role,
    name: `${role} ${mobile.slice(-4)}`, mobile, passwordHash: "x", status: "ACTIVE", permissions: ROLE_PERMISSIONS[role] ?? [],
  });
  const session = await Session.create({
    _id: createId("session"), userId: user._id, tenantId: tenant._id, deviceId: "test-device", familyId: createId("family"),
    refreshTokenHash: createId("refresh"), platform: "web", expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals.testSessionId = session._id;
  return { user, token: bearerFor(user, permissions ?? ROLE_PERMISSIONS[role]) };
}

async function buildWorld() {
  const { tenant, user: owner, branch } = await seedTenantUser({});
  const { product: fixed } = await seedReady({ tenant, user: owner, branch, app, qty: 5 });
  const branch2 = await seedBranch({ tenantId: tenant._id });
  await EcommerceFulfilmentSettings.updateOne({ tenantId: tenant._id }, { $addToSet: { pickupBranchIds: branch2._id } });
  const ownerToken = bearerFor(owner);
  const manager1 = await seedStaff({ tenant, branch, role: "BRANCH_MANAGER", mobile: "+919000000011" });
  const manager2 = await seedStaff({ tenant, branch: branch2, role: "BRANCH_MANAGER", mobile: "+919000000012" });
  const adminPlain = await seedStaff({ tenant, branch, role: "TENANT_ADMIN", mobile: "+919000000013" });
  const adminGranted = await seedStaff({
    tenant, branch, role: "TENANT_ADMIN", mobile: "+919000000014", permissions: [...ROLE_PERMISSIONS.TENANT_ADMIN, WAIVE],
  });
  const alice = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+918800000101", name: "Alice" });
  const bob = await seedCustomer({ tenantId: tenant._id, branchId: branch._id, mobile: "+918800000102", name: "Bob" });
  const aliceToken = await customerToken({ tenant, branch, customer: alice });
  const bobToken = await customerToken({ tenant, branch, customer: bob });

  // A published, tracked product priced from the gold rate, one piece in stock.
  const gold = await EcommerceProduct.create({
    tenantId: tenant._id, name: "Gold Ring", slug: `gold-${createId("p").slice(-5)}`, sku: `G-${createId("s").slice(-5)}`, status: "PUBLISHED",
    priceMode: "GOLD_RATE_BASED", purity: "22K", goldWeightMg: 10_000, makingChargeMode: "PERCENT_OF_GOLD", makingCharge: { percentBps: 1000 },
    taxClassification: "GST_3", hsnSacCode: "7113", hsnSacType: "HSN",
  });
  await EcommerceInventory.create({ tenantId: tenant._id, productId: gold._id, stockPolicy: "QUANTITY_TRACKED", quantityOnHand: 1 });
  let rateSeq = 0;
  const setRate = (ratePerGramPaise) => EcommerceGoldRate.create({
    tenantId: tenant._id, purity: "22K", ratePerGramPaise, effectiveAt: new Date(Date.now() - 600_000 + (rateSeq += 1) * 1000),
  });
  await setRate(600_000);

  const ctx = {
    tenant, branch, branch2, owner, ownerToken, fixed, gold, setRate, alice, bob, aliceToken, bobToken,
    manager1: manager1.token, manager2: manager2.token, manager2Id: manager2.user._id,
    adminPlain: adminPlain.token, adminGranted: adminGranted.token, adminPlainId: adminPlain.user._id,
  };
  ctx.policy = await publishPolicyOverHttp(ctx);
  return ctx;
}

async function publishPolicyOverHttp(c, over = {}) {
  const draft = await admin(c.ownerToken).post("/ecommerce/booking-policies", {
    policyKey: `std-${createId("k").slice(-5)}`, name: "Standard booking",
    advance: { mode: "PERCENT", percentBps: 2500, minPaise: 0 }, rateRule: "BILLING_DAY", rateProtectionHours: 0,
    advanceWindowMinutes: 30, balanceWindowHours: 72, eligiblePickupBranchIds: [], reminderHoursBeforeDue: [24],
    cancellationFeeBps: 1000, terms: { text: "Advance bookings follow the shop policy." }, ...over,
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const id = draft.body.data.id;
  const published = await admin(c.ownerToken).post(`/ecommerce/booking-policies/${id}/publish`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  for (const branch of [c.branch, c.branch2]) {
    const assigned = await admin(c.ownerToken).put("/ecommerce/booking-policy-assignments", {
      scopeType: "BRANCH", scopeId: branch._id, bookingEnabled: true, policyVersionId: id,
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  }
  return { id };
}

const preview = (token, product, branch) => shop(token).get(`/bookings/preview?productId=${product._id ?? product.id}&pickupBranchId=${branch._id}`);
async function book(token, product, c = w, branch = c.branch, over = {}) {
  const productId = String(product._id ?? product.id);
  // Book what the customer was quoted: preview first, then accept that amount.
  const quote = await shop(token).get(`/bookings/preview?productId=${productId}&pickupBranchId=${branch._id}`);
  const q = quote.body?.data ?? {};
  return shop(token).post("/bookings", {
    productId, pickupBranchId: branch._id, acceptedPolicyVersionId: c.policy.id,
    acceptedAdvancePaise: Number.isInteger(q.advanceRequiredPaise) ? q.advanceRequiredPaise : 0,
    acceptedEstimateTotalPaise: Number.isInteger(q.estimateTotalPaise) ? q.estimateTotalPaise : 0,
    acceptedRatePerGramPaise: q.ratePerGramPaise ?? null, ...over,
  });
}
async function payIntent(token, bookingId) {
  return shop(token).post(`/bookings/${bookingId}/payment-intents`, { redirectUrl: "https://shop.example/return", checkoutChannel: "sdk" });
}
async function capture(intent, amountPaise, tag = "") {
  await postCompletedWebhook({ tenantId: w.tenant._id, merchantOrderId: intent.merchantOrderId, amountPaise, transactionId: `tx-${intent.id}${tag}` });
}
/** Book and pay the advance; returns the booking as the customer sees it. */
async function confirmed(token = w.aliceToken, product = w.fixed) {
  const created = await book(token, product);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const intent = await payIntent(token, created.body.data.id);
  assert.equal(intent.status, 201, JSON.stringify(intent.body));
  await capture(intent.body.data.paymentIntent, intent.body.data.paymentIntent.amountPaise);
  const view = await shop(token).get(`/bookings/${created.body.data.id}`);
  assert.equal(view.body.data.status, "CONFIRMED", JSON.stringify(view.body));
  return view.body.data;
}

// ---------------------------------------------------------------------------------------------

test("customer journey: preview, book, pay advance, staff bill, pay balance, one paid order", async () => {
  const pv = await preview(w.aliceToken, w.gold, w.branch);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));

  const created = await book(w.aliceToken, w.gold);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const bookingId = created.body.data.id;
  assert.equal(created.body.data.status, "PENDING_ADVANCE");
  assert.equal(created.body.data.customerId, undefined, "customer view hides staff fields");
  assert.equal(created.body.data.customer, undefined, "customer view never carries the customer summary");

  // The one piece is held for Alice: Bob cannot book it.
  const rival = await book(w.bobToken, w.gold);
  assert.ok(rival.status >= 400 && rival.status < 500, `second booking of the last piece must be refused, got ${rival.status}`);

  // Paying the advance: one provider order, replays reuse it.
  const intent = await payIntent(w.aliceToken, bookingId);
  assert.equal(intent.status, 201, JSON.stringify(intent.body));
  assert.equal(intent.body.data.paymentIntent.purpose, "BOOKING_ADVANCE");
  const again = await payIntent(w.aliceToken, bookingId);
  assert.equal(again.body.data.paymentIntent.id, intent.body.data.paymentIntent.id, "same attempt, no second provider order");
  const polled = await shop(w.aliceToken).get(`/bookings/${bookingId}/payment-intents/${intent.body.data.paymentIntent.id}`);
  assert.equal(polled.status, 200);
  await capture(intent.body.data.paymentIntent, intent.body.data.paymentIntent.amountPaise);
  const confirmedView = await shop(w.aliceToken).get(`/bookings/${bookingId}`);
  assert.equal(confirmedView.body.data.status, "CONFIRMED");
  assert.equal(confirmedView.body.data.advance.capturedPaise, intent.body.data.paymentIntent.amountPaise);

  // Staff see it, and bill it after the gold rate has moved.
  const list = await admin(w.manager1).get("/ecommerce/bookings?status=CONFIRMED");
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const row = list.body.data.find((b) => b.id === bookingId);
  assert.ok(row);
  assert.equal(row.customer?.name, w.alice.name, "staff see who booked");
  assert.equal(row.customer?.mobile, w.alice.mobile);
  assert.equal(row.pickupBranch?.id, w.branch._id ?? w.branch.id, "staff see the pickup branch by name");
  assert.ok(row.pickupBranch?.name);
  await w.setRate(650_000);
  const billed = await admin(w.manager1).post(`/ecommerce/bookings/${bookingId}/bill`);
  assert.equal(billed.status, 200, JSON.stringify(billed.body));
  assert.equal(billed.body.data.status, "BALANCE_PENDING");
  const balance = billed.body.data.finalBilling.balancePaise;
  assert.ok(balance > 0);

  // Balance payment converts to exactly one paid order.
  const balIntent = await payIntent(w.aliceToken, bookingId);
  assert.equal(balIntent.status, 201, JSON.stringify(balIntent.body));
  assert.equal(balIntent.body.data.paymentIntent.purpose, "BOOKING_BALANCE");
  assert.equal(balIntent.body.data.paymentIntent.amountPaise, balance);
  await capture(balIntent.body.data.paymentIntent, balance);
  const done = await shop(w.aliceToken).get(`/bookings/${bookingId}`);
  assert.equal(done.body.data.status, "CONVERTED");
  assert.equal(await EcommerceOrder.countDocuments({ tenantId: w.tenant._id, customerId: w.alice._id }), 1);
  const staffView = await admin(w.ownerToken).get(`/ecommerce/bookings/${bookingId}`);
  assert.ok(staffView.body.data.order?.orderNumber, "staff see the converted order");
  assert.ok(staffView.body.data.attempts.length >= 2 && staffView.body.data.events.length >= 1);
  const inv = await EcommerceInventory.findOne({ tenantId: w.tenant._id, productId: w.gold._id }).lean();
  assert.equal(inv.quantityOnHand, 0, "the piece was consumed by the order");
  // A duplicate delivery of the same capture changes nothing.
  await capture(balIntent.body.data.paymentIntent, balance, "-redelivery");
  assert.equal(await EcommerceOrder.countDocuments({ tenantId: w.tenant._id, customerId: w.alice._id }), 1);
});

test("customer isolation: another customer cannot read, pay or cancel someone else's booking", async () => {
  const mine = await confirmed(w.aliceToken);
  for (const req of [
    shop(w.bobToken).get(`/bookings/${mine.id}`),
    shop(w.bobToken).get(`/bookings/${mine.id}/refunds`),
    payIntent(w.bobToken, mine.id),
    shop(w.bobToken).post(`/bookings/${mine.id}/cancel`, {}),
  ]) assert.equal((await req).status, 404);
  const bobList = await shop(w.bobToken).get("/bookings");
  assert.equal(bobList.body.data.length, 0);
  assert.equal((await shop(w.aliceToken).get(`/bookings/${mine.id}`)).body.data.status, "CONFIRMED");
});

test("payments flag: with it off a customer cannot book or pay; reads still work", async () => {
  const live = await confirmed(w.aliceToken);
  process.env.ECOMMERCE_BOOKING_PAYMENTS_ENABLED = "false";
  const previewRefused = await preview(w.bobToken, w.fixed, w.branch);
  assert.equal(previewRefused.status, 403, "no Book button while booking cannot be created");
  assert.equal(previewRefused.body.error.code, "BOOKING_PAYMENTS_DISABLED");
  const refused = await book(w.bobToken, w.fixed);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "BOOKING_PAYMENTS_DISABLED");
  const payRefused = await payIntent(w.aliceToken, live.id);
  assert.equal(payRefused.status, 403);
  assert.equal((await shop(w.aliceToken).get(`/bookings/${live.id}`)).status, 200);
});

test("branch scope over HTTP: the other branch's manager cannot see or act on the booking", async () => {
  const b = await confirmed(w.aliceToken);
  assert.equal((await admin(w.manager2).get(`/ecommerce/bookings/${b.id}`)).status, 404);
  const list2 = await admin(w.manager2).get("/ecommerce/bookings");
  assert.equal(list2.body.data.length, 0);
  assert.equal((await admin(w.manager2).get(`/ecommerce/bookings?pickupBranchId=${w.branch._id}`)).status, 403);
  for (const path of ["bill", "requote", "cancel"]) {
    const res = await admin(w.manager2).post(`/ecommerce/bookings/${b.id}/${path}`, path === "bill" ? {} : { reason: "not my branch to touch" });
    assert.equal(res.status, 404, `${path}: ${JSON.stringify(res.body)}`);
  }
  assert.equal((await EcommerceBooking.findById(b.id).lean()).status, "CONFIRMED");
  assert.equal((await admin(w.manager1).get(`/ecommerce/bookings/${b.id}`)).status, 200);
  assert.equal((await admin(w.ownerToken).get("/ecommerce/bookings")).body.data.length, 1, "tenant owner sees every branch");
});

test("cancel under policy: manager cancels, fee is kept, refund is sent by staff and settled by the provider", async () => {
  const b = await confirmed(w.aliceToken);
  const captured = b.advance.capturedPaise;

  // A manager may not waive the fee; nothing is cancelled by the refused request.
  const waive = await admin(w.manager1).post(`/ecommerce/bookings/${b.id}/cancel`, { reason: "customer is a friend", waiveFee: true });
  assert.equal(waive.status, 403);
  assert.equal(waive.body.error.code, "FEE_WAIVER_NOT_PERMITTED");
  assert.equal((await EcommerceBooking.findById(b.id).lean()).status, "CONFIRMED");

  const cancelled = await admin(w.manager1).post(`/ecommerce/bookings/${b.id}/cancel`, { reason: "customer changed their mind" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.status, "CANCELLED");
  const fee = Math.round((captured * 1000) / 10_000);
  assert.equal(cancelled.body.data.cancellationFeePaise, fee);
  assert.equal(cancelled.body.data.feeWaiver, null);
  assert.equal(cancelled.body.data.refundStatus, "PENDING");
  const [refund] = cancelled.body.data.refunds;
  assert.equal(refund.amountPaise, captured - fee);
  assert.equal(refund.status, "ASSIGNED", "nothing is sent to the provider until staff press Send refund");

  // The customer sees the status but no provider detail.
  const custRefunds = await shop(w.aliceToken).get(`/bookings/${b.id}/refunds`);
  assert.equal(custRefunds.status, 200);
  assert.ok(!JSON.stringify(custRefunds.body).includes("failureReason"));

  // Staff send it; the provider confirms; the booking settles.
  const sent = await admin(w.manager1).post(`/ecommerce/bookings/${b.id}/refunds/${refund.id}/retry`);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const row = await EcommercePaymentExceptionRefund.findById(refund.id).lean();
  assert.ok(["INITIATED", "PROVIDER_PENDING"].includes(row.status), row.status);
  const attempt = await EcommercePaymentAttempt.findOne({ tenantId: w.tenant._id, bookingId: b.id, purpose: "BOOKING_ADVANCE" }).lean();
  await postRefundWebhookHttp({
    app, tenantId: w.tenant._id, type: "PG_REFUND_COMPLETED", providerEventId: "pe-refund-e2e-1",
    payload: { refundId: refund.id, originalMerchantOrderId: attempt._id, amount: refund.amountPaise, currency: "INR" },
  });
  const settled = await shop(w.aliceToken).get(`/bookings/${b.id}`);
  assert.equal(settled.body.data.refundStatus, "SETTLED");
  const after = await admin(w.manager1).get(`/ecommerce/bookings/${b.id}`);
  assert.equal(after.body.data.refunds[0].status, "SUCCEEDED");
  // Cancelling again does not refund twice.
  const replay = await admin(w.manager1).post(`/ecommerce/bookings/${b.id}/cancel`, { reason: "double click on cancel" });
  assert.equal(replay.status, 200);
  assert.equal(await EcommercePaymentExceptionRefund.countDocuments({ tenantId: w.tenant._id, bookingId: b.id }), 1);
});

test("fee waiver authority: owner and an explicitly granted admin can waive; a plain admin and a manager cannot; it is audited", async () => {
  const [one, two, three] = [await confirmed(w.aliceToken, w.fixed)];
  // Stock: the fixed product has five pieces, so more bookings are fine.
  const second = await confirmed(w.bobToken, w.fixed);
  const third = await confirmed(w.aliceToken, w.fixed);
  void two; void three;

  const plain = await admin(w.adminPlain).post(`/ecommerce/bookings/${one.id}/cancel`, { reason: "goodwill for a regular", waiveFee: true });
  assert.equal(plain.status, 403, "an admin is not authorised by default");
  assert.equal(plain.body.error.code, "FEE_WAIVER_NOT_PERMITTED");

  const owner = await admin(w.ownerToken).post(`/ecommerce/bookings/${one.id}/cancel`, { reason: "goodwill for a regular customer", waiveFee: true });
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.equal(owner.body.data.cancellationFeePaise, 0);
  assert.equal(owner.body.data.feeWaiver.by, w.owner._id);
  assert.ok(owner.body.data.feeWaiver.waivedPaise > 0);
  assert.equal(owner.body.data.refunds[0].amountPaise, one.advance.capturedPaise, "the whole advance goes back");

  const granted = await admin(w.adminGranted).post(`/ecommerce/bookings/${second.id}/cancel`, { reason: "approved by the owner", waiveFee: true });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.data.cancellationFeePaise, 0);

  const trail = await AuditEvent.find({ tenantId: w.tenant._id, entityType: "ECOMMERCE_BOOKING", action: "BOOKING_CANCELLED_FEE_WAIVED" }).lean();
  assert.equal(trail.length, 2);
  const ownerEntry = trail.find((t) => t.entityId === one.id);
  assert.equal(ownerEntry.actorId, w.owner._id);
  assert.equal(ownerEntry.metadata.reason, "goodwill for a regular customer");
  assert.equal(ownerEntry.metadata.staffId, w.owner._id);
  assert.equal(ownerEntry.metadata.feeWaived, true);
  assert.equal(ownerEntry.branchId, w.branch._id, "the entry belongs to the booking's branch");
  const plainCancel = await admin(w.manager1).post(`/ecommerce/bookings/${third.id}/cancel`, { reason: "customer asked at the counter" });
  assert.equal(plainCancel.status, 200);
  assert.equal((await AuditEvent.countDocuments({ tenantId: w.tenant._id, action: "BOOKING_CANCELLED_BY_STAFF" })), 1);
});

test("only an owner can hand out the fee-waiver permission", async () => {
  const target = await seedStaff({ tenant: w.tenant, branch: w.branch, role: "TENANT_ADMIN", mobile: "+919000000099" });
  const grant = { permissions: [...ROLE_PERMISSIONS.TENANT_ADMIN, WAIVE] };
  const byAdmin = await admin(w.adminGranted).patch(`/staff/${target.user._id}`, grant);
  assert.equal(byAdmin.status, 403, JSON.stringify(byAdmin.body));
  assert.ok(!(await User.findById(target.user._id).lean()).permissions.includes(WAIVE));
  const byOwner = await admin(w.ownerToken).patch(`/staff/${target.user._id}`, grant);
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
  assert.ok((await User.findById(target.user._id).lean()).permissions.includes(WAIVE));
});

test("re-billing and a stuck conversion are visible and recoverable by staff", async () => {
  const b = await confirmed(w.aliceToken, w.gold);
  await w.setRate(640_000);
  const first = await admin(w.manager1).post(`/ecommerce/bookings/${b.id}/bill`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await w.setRate(620_000);
  const requote = await admin(w.manager1).post(`/ecommerce/bookings/${b.id}/requote`, { reason: "rate used was stale" });
  assert.equal(requote.status, 200, JSON.stringify(requote.body));
  assert.equal(requote.body.data.billingRevisions.length, 1);
  assert.notEqual(requote.body.data.finalBilling.totalPaise, first.body.data.finalBilling.totalPaise);
  const other = await admin(w.manager2).post(`/ecommerce/bookings/${b.id}/requote`, { reason: "not my branch at all" });
  assert.equal(other.status, 404);
});

test("expiry releases the held piece for someone else; an unpaid advance sends one reminder only", async () => {
  const created = await book(w.aliceToken, w.gold);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.ok((await book(w.bobToken, w.gold)).status >= 400, "held for Alice");

  // Five minutes before the advance deadline: one reminder, and a rerun does not repeat it.
  await EcommerceBooking.collection.updateOne({ _id: id }, { $set: { advanceDueAt: new Date(Date.now() + 5 * 60_000) } });
  const r1 = await runEcommerceBookingReminders(new Date());
  const sent = (r) => Object.entries(r.counts).filter(([k]) => k.startsWith("advance-due:") && /QUEUED|SENT|CREATED/.test(k)).reduce((n, [, v]) => n + v, 0);
  assert.equal(sent(r1), 1, JSON.stringify(r1));
  const r2 = await runEcommerceBookingReminders(new Date());
  assert.equal(sent(r2), 0, "the same booking is not reminded twice");

  // Past the deadline the booking expires, the hold is released, the customer sees it, Bob can now book.
  const past = new Date(Date.now() - 3 * HOUR);
  await EcommerceBooking.collection.updateOne({ _id: id }, { $set: { advanceDueAt: past, expiryAt: past } });
  await EcommercePaymentAttempt.collection.updateMany({ bookingId: id }, { $set: { expiresAt: past } });
  await runEcommerceBookingExpiry(new Date());
  assert.equal((await shop(w.aliceToken).get(`/bookings/${id}`)).body.data.status, "EXPIRED");
  const bobBooks = await book(w.bobToken, w.gold);
  assert.equal(bobBooks.status, 201, JSON.stringify(bobBooks.body));
});

test("customer can cancel their own unpaid and paid bookings; a paid cancel refunds under policy", async () => {
  const unpaid = await book(w.aliceToken, w.fixed);
  const cancelUnpaid = await shop(w.aliceToken).post(`/bookings/${unpaid.body.data.id}/cancel`, { reason: "changed my mind" });
  assert.equal(cancelUnpaid.status, 200, JSON.stringify(cancelUnpaid.body));
  assert.equal(cancelUnpaid.body.data.status, "CANCELLED");

  const paid = await confirmed(w.bobToken, w.fixed);
  const cancelPaid = await shop(w.bobToken).post(`/bookings/${paid.id}/cancel`, { reason: "found another" });
  assert.equal(cancelPaid.status, 200, JSON.stringify(cancelPaid.body));
  assert.equal(cancelPaid.body.data.refundStatus, "PENDING");
  assert.equal(cancelPaid.body.data.cancellationFeePaise, Math.round((paid.advance.capturedPaise * 1000) / 10_000));
  assert.equal(cancelPaid.body.data.feeWaiver, undefined, "waiver detail is staff-only");
});

test("policy administration: a branch manager can read but not publish or assign", async () => {
  assert.equal((await admin(w.manager1).get("/ecommerce/booking-policies")).status, 200);
  const draft = await admin(w.manager1).post("/ecommerce/booking-policies", {
    policyKey: "mgr-try", name: "Manager draft", advance: { mode: "PERCENT", percentBps: 1000 }, rateRule: "BILLING_DAY",
  });
  assert.equal(draft.status, 403);
  const assign = await admin(w.manager1).put("/ecommerce/booking-policy-assignments", {
    scopeType: "BRANCH", scopeId: w.branch._id, bookingEnabled: false,
  });
  assert.equal(assign.status, 403);
  const foreign = await admin(w.ownerToken).put("/ecommerce/booking-policy-assignments", {
    scopeType: "BRANCH", scopeId: "branch-of-another-tenant", bookingEnabled: true, policyVersionId: w.policy.id,
  });
  assert.equal(foreign.status, 400);
});

test("late capture on a cancelled booking: the booking says a refund is owed until it settles", async () => {
  const created = await book(w.aliceToken, w.fixed);
  const id = created.body.data.id;
  const intent = (await payIntent(w.aliceToken, id)).body.data.paymentIntent;
  const cancelled = await shop(w.aliceToken).post(`/bookings/${id}/cancel`, { reason: "changed my mind" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.refundStatus, "NONE", "nothing was captured yet");

  await capture(intent, intent.amountPaise); // the customer paid anyway, after the cancel
  const owed = await admin(w.manager1).get(`/ecommerce/bookings/${id}`);
  assert.equal(owed.body.data.refunds.length, 1);
  assert.equal(owed.body.data.refunds[0].status, "ASSIGNED");
  assert.equal(owed.body.data.refunds[0].amountPaise, intent.amountPaise, "the whole late capture goes back");
  assert.equal(owed.body.data.refundStatus, "PENDING", "booking summary must not say NONE while a refund is assigned");
  assert.equal((await shop(w.aliceToken).get(`/bookings/${id}`)).body.data.refundStatus, "PENDING");

  const refundId = owed.body.data.refunds[0].id;
  assert.equal((await admin(w.manager1).post(`/ecommerce/bookings/${id}/refunds/${refundId}/retry`)).status, 200);
  assert.equal((await admin(w.manager1).get(`/ecommerce/bookings/${id}`)).body.data.refundStatus, "PENDING");
  await postRefundWebhookHttp({
    app, tenantId: w.tenant._id, type: "PG_REFUND_COMPLETED", providerEventId: "pe-late-refund-1",
    payload: { refundId, originalMerchantOrderId: intent.merchantOrderId, amount: intent.amountPaise, currency: "INR" },
  });
  assert.equal((await shop(w.aliceToken).get(`/bookings/${id}`)).body.data.refundStatus, "SETTLED");
});

test("retrying a failed refund: the booking shows it in progress, not failed, until the provider settles it", async () => {
  const b = await confirmed(w.aliceToken);
  const cancelled = await admin(w.manager1).post(`/ecommerce/bookings/${b.id}/cancel`, { reason: "customer changed their mind" });
  const refund = cancelled.body.data.refunds[0];
  // The first send failed at the provider.
  await EcommercePaymentExceptionRefund.collection.updateOne({ _id: refund.id }, { $set: { status: "FAILED", failureReason: "PROVIDER_REJECTED" } });
  await EcommerceBooking.collection.updateOne({ _id: b.id }, { $set: { refundStatus: "FAILED" } });
  assert.equal((await admin(w.manager1).get(`/ecommerce/bookings/${b.id}`)).body.data.refundStatus, "FAILED");

  const retried = await admin(w.manager1).post(`/ecommerce/bookings/${b.id}/refunds/${refund.id}/retry`);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const row = await EcommercePaymentExceptionRefund.findById(refund.id).lean();
  assert.ok(["INITIATED", "PROVIDER_PENDING"].includes(row.status), row.status);
  const view = await admin(w.manager1).get(`/ecommerce/bookings/${b.id}`);
  assert.equal(view.body.data.refundStatus, "PENDING", "in progress, not the red failed state");
  assert.equal((await shop(w.aliceToken).get(`/bookings/${b.id}`)).body.data.refundStatus, "PENDING");
});

const availability = (token, product) => shop(token).get(`/bookings/availability?productId=${product._id ?? product.id}`);

test("no piece is held for a booking the customer cannot pay for", async () => {
  // Bookings are switched on, but the store cannot take online payments.
  disableEcommercePaymentsTestHarness();
  const pv = await preview(w.aliceToken, w.fixed, w.branch);
  assert.equal(pv.status, 422, JSON.stringify(pv.body));
  assert.equal(pv.body.error.code, "PAYMENT_NOT_AVAILABLE", "no Book button when the booking cannot be paid");
  const av = await availability(w.aliceToken, w.fixed);
  assert.equal(av.body.error?.code, "PAYMENT_NOT_AVAILABLE");
  const refused = await book(w.aliceToken, w.gold);
  assert.equal(refused.body.error?.code, "PAYMENT_NOT_AVAILABLE", JSON.stringify(refused.body));
  assert.equal(await EcommerceBooking.countDocuments({ tenantId: w.tenant._id }), 0, "no booking was created");
  assert.equal(await EcommerceStockReservationCount(w.gold._id), 0, "and no stock was held");

  // Payments come back: the last piece was never taken, so another customer can book it.
  enableEcommercePaymentsTestHarness();
  const ok = await book(w.bobToken, w.gold);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("availability lists every branch that can take the booking, so an ineligible default branch does not hide the others", async () => {
  // Alice's own branch has booking switched off; the second branch still takes bookings.
  const off = await admin(w.ownerToken).put("/ecommerce/booking-policy-assignments", {
    scopeType: "BRANCH", scopeId: w.branch._id, bookingEnabled: false,
  });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal((await preview(w.aliceToken, w.fixed, w.branch)).status >= 400, true, "her default branch refuses");

  const av = await availability(w.aliceToken, w.fixed);
  assert.equal(av.status, 200, JSON.stringify(av.body));
  assert.deepEqual(av.body.data.branches.map((b) => b.id), [w.branch2._id]);
  const only = av.body.data.branches[0];
  assert.equal(only.preview.policyVersionId, w.policy.id);
  assert.ok(only.preview.advanceRequiredPaise > 0);

  // Booking at that branch works end to end from the availability answer.
  const created = await shop(w.aliceToken).post("/bookings", {
    productId: String(w.fixed._id ?? w.fixed.id), pickupBranchId: only.id, acceptedPolicyVersionId: only.preview.policyVersionId,
    acceptedAdvancePaise: only.preview.advanceRequiredPaise, acceptedEstimateTotalPaise: only.preview.estimateTotalPaise,
    acceptedRatePerGramPaise: only.preview.ratePerGramPaise ?? null,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.pickupBranchId, w.branch2._id);

  // Nothing bookable anywhere: an empty list, not an error.
  await admin(w.ownerToken).put("/ecommerce/booking-policy-assignments", { scopeType: "BRANCH", scopeId: w.branch2._id, bookingEnabled: false });
  const none = await availability(w.bobToken, w.fixed);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.data.branches, []);
});

async function EcommerceStockReservationCount(productId) {
  const { EcommerceStockReservation } = await import("../src/models/index.js");
  return EcommerceStockReservation.countDocuments({ tenantId: w.tenant._id, productId, releasedAt: null });
}

const holdsFor = (product) => EcommerceStockReservation.countDocuments({ tenantId: w.tenant._id, productId: product._id ?? product.id, releasedAt: null });
const bodyFor = (product, quote, branch = w.branch) => ({
  productId: String(product._id ?? product.id), pickupBranchId: branch._id ?? branch, acceptedPolicyVersionId: quote.policyVersionId,
  acceptedAdvancePaise: quote.advanceRequiredPaise, acceptedEstimateTotalPaise: quote.estimateTotalPaise,
  acceptedRatePerGramPaise: quote.ratePerGramPaise ?? null,
});
const quoteOf = async (token, product, branch = w.branch) =>
  (await shop(token).get(`/bookings/preview?productId=${product._id ?? product.id}&pickupBranchId=${branch._id}`)).body.data;

test("an inactive or unlisted pickup branch is refused by availability, preview and create alike", async () => {
  const quote = await quoteOf(w.aliceToken, w.fixed, w.branch2);
  assert.ok(quote.advanceRequiredPaise > 0);
  await Branch.updateOne({ _id: w.branch2._id }, { $set: { active: false } });

  const pv = await preview(w.aliceToken, w.fixed, w.branch2);
  assert.equal(pv.body.error?.code, "PICKUP_BRANCH_NOT_AVAILABLE", JSON.stringify(pv.body));
  const av = await availability(w.aliceToken, w.fixed);
  assert.deepEqual(av.body.data.branches.map((b) => b.id), [w.branch._id]);
  const refused = await shop(w.aliceToken).post("/bookings", bodyFor(w.fixed, quote, w.branch2));
  assert.equal(refused.body.error?.code, "PICKUP_BRANCH_NOT_AVAILABLE", JSON.stringify(refused.body));

  // A branch id that is not a pickup branch of this store at all is refused the same way.
  const stray = await shop(w.aliceToken).post("/bookings", { ...bodyFor(w.fixed, quote), pickupBranchId: "brn_not_mine" });
  assert.ok(stray.status >= 400 && stray.status < 500, JSON.stringify(stray.body));
  assert.equal(await EcommerceBooking.countDocuments({ tenantId: w.tenant._id }), 0);
  assert.equal(await holdsFor(w.fixed), 0, "no stock held");
});

test("retrying one submission with the same key books once; the same key for another quote is rejected", async () => {
  const q = await quoteOf(w.aliceToken, w.gold);
  const body = bodyFor(w.gold, q);
  const first = await shop(w.aliceToken).post("/bookings", body, "lost-response-key");
  const retry = await shop(w.aliceToken).post("/bookings", body, "lost-response-key");
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.ok([200, 201].includes(retry.status), JSON.stringify(retry.body));
  assert.equal(retry.body.data.id, first.body.data.id, "the retry is the same booking");
  assert.equal(await EcommerceBooking.countDocuments({ tenantId: w.tenant._id }), 1);
  assert.equal(await holdsFor(w.gold), 1, "one hold, not two");

  const other = await shop(w.aliceToken).post("/bookings", { ...body, acceptedAdvancePaise: q.advanceRequiredPaise + 100 }, "lost-response-key");
  assert.equal(other.body.error?.code, "IDEMPOTENCY_KEY_REUSED", JSON.stringify(other.body));
});

test("the advance is bound to the quote the customer accepted; a moved price holds nothing until re-accepted", async () => {
  const q = await quoteOf(w.aliceToken, w.gold);
  assert.equal(q.advanceRequiredPaise > 0, true);
  await w.setRate(700_000); // the gold rate moves after the customer saw the quote
  const stale = await shop(w.aliceToken).post("/bookings", bodyFor(w.gold, q));
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error.code, "BOOKING_QUOTE_CHANGED");
  const fresh = stale.body.error.details.current;
  assert.ok(fresh.advanceRequiredPaise > q.advanceRequiredPaise, "the details carry the new advance");
  assert.equal(await EcommerceBooking.countDocuments({ tenantId: w.tenant._id }), 0);
  assert.equal(await holdsFor(w.gold), 0, "no stock held on a changed quote");

  const accepted = await shop(w.aliceToken).post("/bookings", bodyFor(w.gold, { ...q, ...fresh }));
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.advance.requiredPaise, fresh.advanceRequiredPaise);
  const intent = await payIntent(w.aliceToken, accepted.body.data.id);
  assert.equal(intent.body.data.paymentIntent.amountPaise, fresh.advanceRequiredPaise, "payment asks for what was accepted");

  const missing = await shop(w.bobToken).post("/bookings", {
    productId: String(w.fixed._id ?? w.fixed.id), pickupBranchId: w.branch._id, acceptedPolicyVersionId: q.policyVersionId,
  });
  assert.equal(missing.status, 400, "a booking without an accepted amount is not accepted");
});

test("availability is sellable units minus effective holds: one hold of five leaves units, the last hold blocks", async () => {
  // The fixed product has five units. One booking holds one; another customer can still book.
  assert.equal((await book(w.aliceToken, w.fixed)).status, 201);
  const q = await quoteOf(w.bobToken, w.fixed);
  assert.equal(q.heldByOthers, false, "four units remain");
  assert.equal(q.availableQuantity, 4);
  assert.equal((await book(w.bobToken, w.fixed)).status, 201, "and the create API agrees");

  // The gold piece has a single unit: once held, preview says so and create refuses.
  assert.equal((await book(w.aliceToken, w.gold)).status, 201);
  const held = await quoteOf(w.bobToken, w.gold);
  assert.equal(held.heldByOthers, true);
  assert.equal(held.availableQuantity, 0);
  assert.equal((await book(w.bobToken, w.gold)).body.error?.code, "INSUFFICIENT_STOCK");
});

test("a sold-out piece is not offered, and creation still checks stock transactionally", async () => {
  const q = await quoteOf(w.aliceToken, w.gold);
  await EcommerceInventory.updateOne({ tenantId: w.tenant._id, productId: w.gold._id }, { $set: { quantityOnHand: 0 } });

  const pv = await preview(w.aliceToken, w.gold, w.branch);
  assert.equal(pv.body.error?.code, "INSUFFICIENT_STOCK", JSON.stringify(pv.body));
  const av = await availability(w.aliceToken, w.gold);
  assert.equal(av.status, 200);
  assert.deepEqual(av.body.data.branches, [], "no branch lists a sold-out piece");

  // Someone who still holds an old quote cannot get past the stock check at creation.
  const late = await shop(w.aliceToken).post("/bookings", bodyFor(w.gold, q));
  assert.equal(late.body.error?.code, "INSUFFICIENT_STOCK", JSON.stringify(late.body));
  assert.equal(await EcommerceBooking.countDocuments({ tenantId: w.tenant._id }), 0);
});

test("acceptance is bound to the quoted rate and estimate, not only the advance", async () => {
  // A rate move can leave a fixed or capped advance unchanged while the estimate the customer saw is
  // no longer true. Simulate exactly that: same advance, different rate and estimate.
  const q = await quoteOf(w.aliceToken, w.gold);
  assert.ok(q.ratePerGramPaise > 0 && q.estimateTotalPaise > 0);
  await w.setRate(q.ratePerGramPaise + 50_000);
  const next = await quoteOf(w.aliceToken, w.gold);
  assert.ok(next.estimateTotalPaise > q.estimateTotalPaise);

  const stale = await shop(w.aliceToken).post("/bookings", { ...bodyFor(w.gold, q), acceptedAdvancePaise: next.advanceRequiredPaise });
  assert.equal(stale.status, 409, "the old estimate and rate are refused even though the advance matches");
  assert.equal(stale.body.error.code, "BOOKING_QUOTE_CHANGED");
  assert.equal(stale.body.error.details.current.ratePerGramPaise, next.ratePerGramPaise);
  assert.equal(await holdsFor(w.gold), 0);

  const onlyRate = await shop(w.aliceToken).post("/bookings", { ...bodyFor(w.gold, next), acceptedRatePerGramPaise: q.ratePerGramPaise });
  assert.equal(onlyRate.body.error?.code, "BOOKING_QUOTE_CHANGED");

  const ok = await shop(w.aliceToken).post("/bookings", bodyFor(w.gold, next));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const saved = await EcommerceBooking.findById(ok.body.data.id).lean();
  assert.equal(saved.bookedRate.ratePerGramPaise, next.ratePerGramPaise, "the booked rate is the one shown");
  assert.equal(saved.estimate.totalPaise, next.estimateTotalPaise);
});

test("the preview and policy views say when rate protection ends before the balance is due", async () => {
  const q = await quoteOf(w.aliceToken, w.gold);
  assert.equal(typeof q.rateProtectionHours, "number");
  assert.equal(q.rateProtectionEndsBeforeBalanceDeadline, q.rateRule !== "BILLING_DAY" && q.rateProtectionHours < q.balanceWindowHours);
  const { bookingRateProtectionEndsEarly } = await import("../src/lib/ecommerce-booking-policy.js");
  assert.equal(bookingRateProtectionEndsEarly({ rateRule: "BOOKED_RATE", rateProtectionHours: 24, balanceWindowHours: 72 }), true);
  assert.equal(bookingRateProtectionEndsEarly({ rateRule: "BOOKED_RATE", rateProtectionHours: 72, balanceWindowHours: 72 }), false);
  assert.equal(bookingRateProtectionEndsEarly({ rateRule: "BILLING_DAY", rateProtectionHours: 0, balanceWindowHours: 72 }), false);
  const list = await admin(w.ownerToken).get("/ecommerce/booking-policies");
  assert.ok((Array.isArray(list.body.data) ? list.body.data : list.body.data.items ?? []).every((p) => typeof p.rateProtectionEndsBeforeBalanceDeadline === "boolean"), JSON.stringify(list.body).slice(0, 300));
});
