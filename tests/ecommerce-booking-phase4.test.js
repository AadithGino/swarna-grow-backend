import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { ResourceNotFound } from "@phonepe-pg/pg-sdk-node";
import { Permission, ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { isPhonePeOrderNotFound } from "../src/integrations/phonepe.provider.js";
import { assertBookingPaymentsEnabled, bookingPaymentsEnabled } from "../src/lib/ecommerce-booking-flags.js";
import { readFileSync } from "node:fs";
import { bookingBranchCondition, bookingStaffScope } from "../src/lib/ecommerce-booking-scope.js";
import { dueReminderHour } from "../src/services/ecommerce-booking-reminder.service.js";
import {
  bookingCreateBody,
  bookingPolicyDraftBody,
  bookingStaffCancelBody,
} from "../src/validators/ecommerce.validators.js";

const original = process.env.ECOMMERCE_BOOKING_PAYMENTS_ENABLED;
afterEach(() => {
  if (original === undefined) delete process.env.ECOMMERCE_BOOKING_PAYMENTS_ENABLED;
  else process.env.ECOMMERCE_BOOKING_PAYMENTS_ENABLED = original;
});

test("booking payments are off unless the flag is exactly true, and the guard says so", () => {
  delete process.env.ECOMMERCE_BOOKING_PAYMENTS_ENABLED;
  assert.equal(bookingPaymentsEnabled(), false);
  assert.throws(() => assertBookingPaymentsEnabled(), (e) => e.code === "BOOKING_PAYMENTS_DISABLED" && e.statusCode === 403);
  process.env.ECOMMERCE_BOOKING_PAYMENTS_ENABLED = "false";
  assert.equal(bookingPaymentsEnabled(), false);
  process.env.ECOMMERCE_BOOKING_PAYMENTS_ENABLED = "true";
  assert.equal(bookingPaymentsEnabled(), true);
  assert.doesNotThrow(() => assertBookingPaymentsEnabled());
});

test("booking permissions: owner and admin hold both, a branch manager operates but cannot publish policy, staff hold neither", () => {
  assert.deepEqual(ROLE_PERMISSIONS.TENANT_OWNER, ["*"]);
  for (const p of [Permission.ECOMMERCE_BOOKING_OPERATE, Permission.ECOMMERCE_BOOKING_POLICY_PUBLISH]) {
    assert.ok(ROLE_PERMISSIONS.TENANT_ADMIN.includes(p), `admin ${p}`);
    assert.ok(!ROLE_PERMISSIONS.BRANCH_STAFF.includes(p), `staff ${p}`);
    assert.ok(!ROLE_PERMISSIONS.COLLECTION_AGENT.includes(p), `agent ${p}`);
  }
  assert.ok(ROLE_PERMISSIONS.BRANCH_MANAGER.includes(Permission.ECOMMERCE_BOOKING_OPERATE));
  assert.ok(!ROLE_PERMISSIONS.BRANCH_MANAGER.includes(Permission.ECOMMERCE_BOOKING_POLICY_PUBLISH));
});

test("only PhonePe's definite no-such-order error counts as 'order not found'", () => {
  assert.equal(isPhonePeOrderNotFound(new ResourceNotFound("nf")), true);
  assert.equal(isPhonePeOrderNotFound(new Error("PhonePe 503")), false);
  assert.equal(isPhonePeOrderNotFound(null), false);
});

test("reminders: the smallest crossed threshold is used, and none before the first is reached", () => {
  const H = 3_600_000;
  assert.equal(dueReminderHour([24, 6, 1], 30 * H), null);
  assert.equal(dueReminderHour([24, 6, 1], 20 * H), 24);
  assert.equal(dueReminderHour([24, 6, 1], 5 * H), 6, "a late run sends one notice, for the nearest threshold");
  assert.equal(dueReminderHour([24, 6, 1], 0.5 * H), 1);
  assert.equal(dueReminderHour([], H), null);
  assert.equal(dueReminderHour([0, -3, NaN], H), null);
});

test("booking request bodies reject unknown fields and require a reason to cancel as staff", () => {
  const base = { productId: "p", pickupBranchId: "b", acceptedPolicyVersionId: "v", acceptedAdvancePaise: 100, acceptedEstimateTotalPaise: 400, acceptedRatePerGramPaise: null };
  assert.ok(bookingCreateBody.safeParse(base).success);
  assert.ok(!bookingCreateBody.safeParse({ ...base, totalPaise: 1 }).success);
  assert.ok(!bookingCreateBody.safeParse({ ...base, acceptedAdvancePaise: undefined }).success, "the accepted advance is required");
  assert.ok(!bookingCreateBody.safeParse({ ...base, acceptedAdvancePaise: 1.5 }).success);
  assert.ok(!bookingStaffCancelBody.safeParse({ reason: "short" }).success);
  const ok = bookingStaffCancelBody.parse({ reason: "Customer asked at the counter" });
  assert.equal(ok.waiveFee, false);
  assert.ok(!bookingPolicyDraftBody.safeParse({
    policyKey: "k", name: "n", advance: { mode: "PERCENT", percentBps: 2500 }, rateRule: "NOT_A_RULE",
  }).success);
});

const staffReq = (role, extra = {}) => ({ auth: { type: "TENANT_USER", tenantId: "t1", role, ...extra }, scope: { branchId: extra.branchId ?? null }, query: {} });

test("booking staff scope: tenant roles are unrestricted, branch roles are pinned to the token's branch", () => {
  assert.deepEqual(bookingStaffScope(staffReq("TENANT_OWNER")), { branchId: null });
  assert.deepEqual(bookingStaffScope(staffReq("TENANT_ADMIN")), { branchId: null });
  assert.deepEqual(bookingStaffScope(staffReq("BRANCH_MANAGER", { branchId: "br1" })), { branchId: "br1" });
  assert.deepEqual(bookingBranchCondition("br1"), { pickupBranchId: "br1" });
  assert.deepEqual(bookingBranchCondition(null), {});
});

test("booking staff scope: a branch role with no branch, or a non-staff token, is refused", () => {
  assert.throws(() => bookingStaffScope(staffReq("BRANCH_MANAGER")), (e) => e.statusCode === 403);
  assert.throws(() => bookingStaffScope(staffReq("SOMETHING_NEW")), (e) => e.statusCode === 403, "an unknown role is treated as a branch role");
  assert.throws(() => bookingStaffScope({ auth: { type: "CUSTOMER", tenantId: "t1", role: "TENANT_OWNER" } }), (e) => e.statusCode === 403);
  assert.throws(() => bookingStaffScope({ auth: null }), (e) => e.statusCode === 403);
});

test("booking staff scope: a branch query parameter cannot override the token's branch", () => {
  const req = staffReq("BRANCH_MANAGER", { branchId: "br1" });
  req.query = { branchId: "br2", pickupBranchId: "br2" };
  assert.equal(bookingStaffScope(req).branchId, "br1");
});

test("every staff booking handler resolves its branch scope (guards against a new handler skipping it)", () => {
  const src = readFileSync(new URL("../src/controllers/ecommerce-booking.controller.js", import.meta.url), "utf8");
  const staff = src.slice(src.indexOf("// ---- Staff ----"), src.indexOf("// ---- Policy admin ----"));
  const handlers = staff.split(/\nexport const /).slice(1);
  assert.ok(handlers.length >= 7, "all seven staff booking handlers are present");
  for (const h of handlers) assert.match(h, /staffScope\(req\)/, `handler ${h.split(" ")[0]} must use staffScope`);
});

test("fee waiver permission: owners hold it, admins and branch managers do not unless granted", async () => {
  const { Permission, ROLE_PERMISSIONS, OWNER_GRANTED_PERMISSIONS } = await import("../src/constants/permissions.js");
  const waive = Permission.ECOMMERCE_BOOKING_FEE_WAIVE;
  assert.equal(waive, "ecommerce.booking.fee.waive");
  assert.deepEqual([...OWNER_GRANTED_PERMISSIONS], [waive]);
  assert.ok(ROLE_PERMISSIONS.TENANT_OWNER.includes("*"));
  assert.ok(!ROLE_PERMISSIONS.TENANT_ADMIN.includes(waive), "admins are not authorised by default");
  assert.ok(!ROLE_PERMISSIONS.BRANCH_MANAGER.includes(waive));
  assert.ok(ROLE_PERMISSIONS.TENANT_ADMIN.includes(Permission.ECOMMERCE_BOOKING_OPERATE), "admins still operate bookings");
  assert.ok(ROLE_PERMISSIONS.BRANCH_MANAGER.includes(Permission.ECOMMERCE_BOOKING_OPERATE), "branch managers still cancel under policy");
});

test("fee waiver: the cancel handler refuses a waiver without the permission and audits the one it allows", () => {
  const src = readFileSync(new URL("../src/controllers/ecommerce-booking.controller.js", import.meta.url), "utf8");
  const cancel = src.slice(src.indexOf("export const staffCancelBooking"), src.indexOf("export const recordBookingManualRefund"));
  assert.match(cancel, /FEE_WAIVER_NOT_PERMITTED/);
  assert.match(cancel, /canWaiveFee\(req\)/);
  assert.ok(cancel.indexOf("canWaiveFee") < cancel.indexOf("booking.cancelBooking"), "permission is checked before anything is cancelled");
  for (const field of ["reason", "staffId", "feeWaivedPaise"]) assert.match(cancel, new RegExp(field));
  assert.match(cancel, /session,\n/, "the audit entry is written inside the cancel transaction");
});
