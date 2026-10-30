import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedWorkboardStates,
  effectiveInstallmentState,
  summarizeWorkboard,
  visibleWorkboardInstallments,
  workboardSchemeFilter,
} from "../src/lib/dues-workboard.js";

const today = "2026-10-29";
const inst = (over) => ({ number: 1, amountPaise: 100_000, paidPaise: 0, status: "DUE", dueDate: today, graceEndsAt: "2026-11-05", ...over });

test("classifies instalments the way the workboard cards describe them", () => {
  assert.equal(effectiveInstallmentState("ACTIVE", inst(), today), "DUE");
  assert.equal(effectiveInstallmentState("ACTIVE", inst({ dueDate: "2026-10-25" }), today), "GRACE");
  assert.equal(effectiveInstallmentState("ACTIVE", inst({ dueDate: "2026-10-01", graceEndsAt: "2026-10-08" }), today), "OVERDUE");
  assert.equal(effectiveInstallmentState("ACTIVE", inst({ status: "OVERDUE", dueDate: "2026-10-01" }), today), "OVERDUE");
  assert.equal(effectiveInstallmentState("ACTIVE", inst({ status: "PAID", paidPaise: 100_000 }), today), null);
  assert.equal(effectiveInstallmentState("ACTIVE", inst({ status: "PENDING", dueDate: "2026-11-29" }), today), null);
  assert.equal(effectiveInstallmentState("DEFAULTED", inst({ dueDate: "2026-09-29" }), today), "DEFAULTED");
  // future instalments of a defaulted enrollment are not arrears
  assert.equal(effectiveInstallmentState("DEFAULTED", inst({ status: "PENDING", dueDate: "2026-12-29" }), today), null);
});

test("quick views map to one state each; boards are fixed", () => {
  assert.deepEqual([...allowedWorkboardStates("dues", "GRACE")], ["GRACE"]);
  assert.deepEqual([...allowedWorkboardStates("dues", "ALL")].sort(), ["DEFAULTED", "DUE", "GRACE", "OVERDUE"]);
  assert.deepEqual([...allowedWorkboardStates("overdues", "DUE")], ["OVERDUE"]);
  assert.deepEqual([...allowedWorkboardStates("defaulters")], ["DEFAULTED"]);
});

test("scheme filter keeps closed enrollments out and pins status + date to one instalment", () => {
  const all = workboardSchemeFilter("dues", { kind: "ALL", dates: { from: "2026-10-01", to: "2026-10-31" }, today });
  assert.deepEqual(all.status, { $in: ["PENDING_PAYMENT", "ACTIVE", "LOCKED", "DEFAULTED"] });
  assert.deepEqual(all.installments.$elemMatch.dueDate, { $gte: "2026-10-01", $lte: "2026-10-31" });
  const defaulted = workboardSchemeFilter("dues", { kind: "DEFAULTED", today });
  assert.equal(defaulted.status, "DEFAULTED");
  const overdue = workboardSchemeFilter("overdues", { today });
  assert.deepEqual(overdue.status, { $in: ["PENDING_PAYMENT", "ACTIVE", "LOCKED"] });
  assert.ok(Array.isArray(overdue.installments.$elemMatch.$or));
  const due = workboardSchemeFilter("dues", { kind: "DUE", today });
  assert.equal(due.installments.$elemMatch.dueDate.$gte, today);
});

test("summary buckets add up to the rows and count distinct customers", () => {
  const schemes = [
    { customerId: "c1", status: "ACTIVE", installments: [inst({}), inst({ number: 2, dueDate: "2026-10-20" })] },
    { customerId: "c2", status: "ACTIVE", installments: [inst({ status: "OVERDUE", dueDate: "2026-09-01", amountPaise: 50_000 })] },
    { customerId: "c3", status: "DEFAULTED", installments: [inst({ dueDate: "2026-08-01", paidPaise: 20_000 }), inst({ status: "PENDING", dueDate: "2026-12-01" })] },
  ];
  const s = summarizeWorkboard(schemes, "dues", { today });
  assert.equal(s.totalsPaise.DUE, 100_000);
  assert.equal(s.totalsPaise.GRACE, 100_000);
  assert.equal(s.totalsPaise.OVERDUE, 50_000);
  assert.equal(s.totalsPaise.DEFAULTED, 80_000);
  assert.equal(s.customers, 3);
  assert.equal(s.ageingPaise["30+ days"], 50_000);
  const rows = visibleWorkboardInstallments(schemes[0], "dues", { kind: "GRACE", today });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inst.number, 2);
});
