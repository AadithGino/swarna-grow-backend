import assert from "node:assert/strict";
import test from "node:test";
import {
  enrollmentStatusBreakdown,
  openEnrollmentKpi,
} from "../src/lib/scheme-enrollment-status.js";

test("openEnrollmentKpi is paying + capped + defaulted", () => {
  assert.equal(
    openEnrollmentKpi({ activePaying: 43, planCapped: 4, defaulted: 1 }),
    48,
  );
  assert.equal(openEnrollmentKpi({ activeAndLocked: 6, defaulted: 0 }), 6);
  assert.equal(openEnrollmentKpi(), 0);
});

test("enrollmentStatusBreakdown parts sum to total", () => {
  const b = enrollmentStatusBreakdown({
    notStarted: 3,
    activePaying: 43,
    planCapped: 4,
    defaulted: 1,
    matured: 5,
    completed: 7,
  });
  assert.equal(b.open, 48);
  assert.equal(b.inProgress, 51);
  assert.equal(b.total, 63);
});
