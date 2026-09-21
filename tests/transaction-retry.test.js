import test from "node:test";
import assert from "node:assert/strict";
import {
  getTransactionSessionStartsForTests,
  isTransientTransactionError,
  resetTransactionTestMetrics,
  withTransaction,
  withTransientTransactionRetry,
} from "../src/lib/transaction.js";
import { AppError } from "../src/lib/app-error.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { SchemePlan } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  resetTransactionTestMetrics();
});

function writeConflictError() {
  const error = new Error("WriteConflict");
  error.code = 112;
  error.codeName = "WriteConflict";
  return error;
}

test("isTransientTransactionError ignores business AppError", () => {
  assert.equal(isTransientTransactionError(new AppError("ONE_SCHEME_POLICY", "x", 422)), false);
  assert.equal(isTransientTransactionError(writeConflictError()), true);
});

test("withTransientTransactionRetry succeeds after one transient write conflict", async () => {
  let runs = 0;
  const result = await withTransientTransactionRetry(async () => {
    runs += 1;
    if (runs === 1) throw writeConflictError();
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(runs, 2);
  assert.ok(getTransactionSessionStartsForTests() >= 2);
});

test("withTransientTransactionRetry fails after five transient errors", async () => {
  let runs = 0;
  await assert.rejects(
    () => withTransientTransactionRetry(async () => {
      runs += 1;
      throw writeConflictError();
    }, { maxAttempts: 5 }),
    (error) => error.codeName === "WriteConflict",
  );
  assert.equal(runs, 5);
});

test("withTransientTransactionRetry does not retry business errors", async () => {
  let runs = 0;
  await assert.rejects(
    () => withTransientTransactionRetry(async () => {
      runs += 1;
      throw new AppError("PLAN_ENROLMENT_CLOSED", "closed", 422);
    }),
    (error) => error.code === "PLAN_ENROLMENT_CLOSED",
  );
  assert.equal(runs, 1);
});

test("post-commit side effect runs once when enrolment retry succeeds on second attempt", async () => {
  const { tenant } = await seedTenantUser();
  let txRuns = 0;
  let postCommitRuns = 0;
  await withTransientTransactionRetry(async (session) => {
    txRuns += 1;
    if (txRuns === 1) throw writeConflictError();
    await SchemePlan.create([{
      _id: createId("schemePlan"),
      tenantId: tenant._id,
      name: "Retry plan",
      code: "RETRY1",
      status: "ACTIVE",
      paymentPattern: "FIXED",
      valueBasis: "CASH",
      durationMonths: 12,
      installmentCount: 12,
      version: 1,
      amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 100_000 },
      scheduleRules: { dueDateRule: "JOIN_ANNIVERSARY", firstInstallmentModeDefault: "START_NEXT_CYCLE" },
      paymentRules: { partialPaymentAllowed: false, minPaymentPaise: 100_000 },
      redemptionRules: {
        prematureClosureAllowed: false,
        lockInMonths: 0,
        prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
        allowedModes: ["CASH"],
        redeemAtAnyBranch: false,
      },
      benefit: {
        type: "TEXT_ONLY",
        displayLabel: "b",
        eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
      },
      availability: { allBranches: true, visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
    }], { session });
  });
  postCommitRuns += 1;
  assert.ok(txRuns >= 2 && txRuns <= 4, `expected 2–4 transaction attempts, got ${txRuns}`);
  assert.equal(postCommitRuns, 1);
});

test("withTransaction does not wrap outer retry loop", async () => {
  let innerStartsBefore = getTransactionSessionStartsForTests();
  await withTransaction(async () => "done");
  assert.equal(getTransactionSessionStartsForTests(), innerStartsBefore + 1);
});
