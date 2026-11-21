import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceDueAt,
  assertBranchEligible,
  cancellationRefundPaise,
  chooseBillingRate,
  computeAdvancePaise,
  confirmedDeadlines,
  pickPolicyAssignment,
} from "../src/lib/ecommerce-booking-policy.js";

const on = (id) => ({ bookingEnabled: true, policyVersionId: id, active: true });
const off = { bookingEnabled: false, active: true };

test("policy resolution: product beats category beats branch, and an 'off' ends the search at its level", () => {
  assert.equal(pickPolicyAssignment({ product: on("p"), category: on("c"), branch: on("b") }).assignment.policyVersionId, "p");
  assert.equal(pickPolicyAssignment({ category: on("c"), branch: on("b") }).assignment.policyVersionId, "c");
  assert.equal(pickPolicyAssignment({ branch: on("b") }).assignment.policyVersionId, "b");
  // Product-level off wins over a category and branch policy.
  assert.deepEqual(pickPolicyAssignment({ product: off, category: on("c"), branch: on("b") }), { enabled: false, reason: "PRODUCT_OFF" });
  // A product-level policy still applies when the branch default is off.
  assert.equal(pickPolicyAssignment({ product: on("p"), branch: off }).assignment.policyVersionId, "p");
  assert.deepEqual(pickPolicyAssignment({ category: off, branch: on("b") }), { enabled: false, reason: "CATEGORY_OFF" });
  assert.deepEqual(pickPolicyAssignment({}), { enabled: false, reason: "NO_POLICY" });
  // An inactive assignment is skipped, not treated as off.
  assert.equal(pickPolicyAssignment({ product: { ...off, active: false }, branch: on("b") }).assignment.policyVersionId, "b");
});

test("branch eligibility: an empty list means every branch, otherwise the branch must be listed", () => {
  assertBranchEligible({ eligiblePickupBranchIds: [] }, "br1");
  assertBranchEligible({ eligiblePickupBranchIds: ["br1", "br2"] }, "br2");
  assert.throws(() => assertBranchEligible({ eligiblePickupBranchIds: ["br1"] }, "br9"), (e) => e.code === "BOOKING_BRANCH_NOT_ELIGIBLE");
  assert.throws(() => assertBranchEligible({ eligiblePickupBranchIds: [] }, null), (e) => e.code === "BOOKING_BRANCH_NOT_ELIGIBLE");
});

test("advance: percentage rounds half up, honors the floor, and never exceeds the total", () => {
  const pct = (percentBps, minPaise = 0) => ({ advance: { mode: "PERCENT", percentBps, minPaise } });
  assert.equal(computeAdvancePaise(pct(2000), 100_000_00), 20_000_00);
  assert.equal(computeAdvancePaise(pct(3333), 10_001), 3_333); // 3333.33 rounds down
  assert.equal(computeAdvancePaise(pct(5000), 3), 2, "1.5 paise rounds half up");
  assert.equal(computeAdvancePaise(pct(5000), 5), 3, "2.5 paise rounds half up");
  assert.equal(computeAdvancePaise(pct(1000, 5_000_00), 20_000_00), 5_000_00, "floor raises a small percentage");
  assert.equal(computeAdvancePaise(pct(1000, 50_000_00), 20_000_00), 20_000_00, "capped at the total");
  assert.equal(computeAdvancePaise({ advance: { mode: "FIXED", fixedPaise: 25_000_00 } }, 100_000_00), 25_000_00);
  assert.equal(computeAdvancePaise({ advance: { mode: "FIXED", fixedPaise: 25_000_00 } }, 10_000_00), 10_000_00, "fixed advance capped at a cheaper total");
  assert.throws(() => computeAdvancePaise({ advance: { mode: "PERCENT" } }, 100), (e) => e.code === "BOOKING_POLICY_INVALID");
  assert.throws(() => computeAdvancePaise({ advance: { mode: "FIXED" } }, 100), (e) => e.code === "BOOKING_POLICY_INVALID");
  assert.throws(() => computeAdvancePaise({ advance: {} }, 100), (e) => e.code === "BOOKING_POLICY_INVALID");
  assert.throws(() => computeAdvancePaise(pct(1000), 0), (e) => e.code === "BOOKING_ESTIMATE_INVALID");
});

test("deadlines count from the right moments", () => {
  const at = new Date("2026-11-17T10:00:00Z");
  const policy = { advanceWindowMinutes: 30, balanceWindowHours: 72, rateProtectionHours: 48 };
  assert.equal(advanceDueAt(policy, at).toISOString(), "2026-11-17T10:30:00.000Z");
  const d = confirmedDeadlines(policy, at);
  assert.equal(d.balanceDueAt.toISOString(), "2026-11-20T10:00:00.000Z");
  assert.equal(d.rateProtectedUntil.toISOString(), "2026-11-19T10:00:00.000Z");
  assert.equal(confirmedDeadlines({ ...policy, rateProtectionHours: 0 }, at).rateProtectedUntil.getTime(), at.getTime(), "no protection");
});

test("cancellation: the fee is kept from the advance, staff can waive it, nothing captured means nothing to refund", () => {
  assert.deepEqual(cancellationRefundPaise({ advanceCapturedPaise: 25_000_00, cancellationFeeBps: 1000 }), { refundPaise: 22_500_00, feePaise: 2_500_00 });
  assert.deepEqual(cancellationRefundPaise({ advanceCapturedPaise: 25_000_00, cancellationFeeBps: 1000, waiveFee: true }), { refundPaise: 25_000_00, feePaise: 0 });
  assert.deepEqual(cancellationRefundPaise({ advanceCapturedPaise: 25_000_00 }), { refundPaise: 25_000_00, feePaise: 0 });
  assert.deepEqual(cancellationRefundPaise({ advanceCapturedPaise: 0, cancellationFeeBps: 1000 }), { refundPaise: 0, feePaise: 0 });
  const odd = cancellationRefundPaise({ advanceCapturedPaise: 1001, cancellationFeeBps: 5000 });
  assert.equal(odd.refundPaise + odd.feePaise, 1001, "paise are never created or lost");
});

const at = new Date("2026-11-18T10:00:00Z");
const booked = (over = {}) => ({
  ratePerGramPaise: 700_000, purity: "22K", rateId: "r1", rateVersion: 1, savedAt: new Date("2026-11-17T10:00:00Z"),
  protectedUntil: new Date("2026-11-19T10:00:00Z"), ...over,
});

test("BOOKED_RATE: booked while protected, a fresh rate once protection ends", () => {
  const during = chooseBillingRate({ rateRule: "BOOKED_RATE", bookedRate: booked(), at });
  assert.equal(during.source, "BOOKED");
  assert.equal(during.needsFreshRate, false);
  assert.equal(during.savedRate.ratePerGramPaise, 700_000);
  const after = chooseBillingRate({ rateRule: "BOOKED_RATE", bookedRate: booked({ protectedUntil: new Date("2026-11-18T10:00:00Z") }), at });
  assert.equal(after.source, "BILLING_DAY");
  assert.equal(after.needsFreshRate, true);
  assert.equal(after.savedRate, null);
  assert.equal(chooseBillingRate({ rateRule: "BOOKED_RATE", bookedRate: null, at }).source, "BILLING_DAY");
});

test("BILLING_DAY always needs a fresh rate, even inside protection", () => {
  const r = chooseBillingRate({ rateRule: "BILLING_DAY", bookedRate: booked(), at });
  assert.deepEqual([r.source, r.needsFreshRate, r.savedRate], ["BILLING_DAY", true, null]);
});

test("LOWER_OF: the booked rate only when protected and not higher, and a fresh rate is always required", () => {
  const rule = "LOWER_OF_BOOKED_AND_BILLING_DAY";
  const rising = chooseBillingRate({ rateRule: rule, bookedRate: booked(), liveRatePerGramPaise: 750_000, at });
  assert.equal(rising.source, "BOOKED", "gold rose, customer keeps the lower booked rate");
  assert.equal(rising.needsFreshRate, true);
  const equal = chooseBillingRate({ rateRule: rule, bookedRate: booked(), liveRatePerGramPaise: 700_000, at });
  assert.equal(equal.source, "BOOKED");
  const falling = chooseBillingRate({ rateRule: rule, bookedRate: booked(), liveRatePerGramPaise: 650_000, at });
  assert.deepEqual([falling.source, falling.savedRate], ["BILLING_DAY", null], "gold fell, customer gets the lower live rate");
  const expired = chooseBillingRate({ rateRule: rule, bookedRate: booked({ protectedUntil: new Date("2026-11-17T12:00:00Z") }), liveRatePerGramPaise: 750_000, at });
  assert.equal(expired.source, "BILLING_DAY", "after protection the higher live rate applies");
  const missingLive = chooseBillingRate({ rateRule: rule, bookedRate: booked(), liveRatePerGramPaise: null, at });
  assert.equal(missingLive.source, "BILLING_DAY");
  assert.equal(missingLive.needsFreshRate, true);
});

test("an unknown rate rule is a configuration error", () => {
  assert.throws(() => chooseBillingRate({ rateRule: "NOPE", bookedRate: booked(), at }), (e) => e.code === "BOOKING_POLICY_INVALID");
});
