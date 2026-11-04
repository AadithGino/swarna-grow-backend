import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { SchemeStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { Message, Scheme } from "../src/models/index.js";
import { runMaturityTransitionBatch } from "../src/services/scheme-maintenance.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function paidFixedInstallments(count, amountPaise = 100_000) {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    dueDate: `2026-${String(index + 1).padStart(2, "0")}-01`,
    amountPaise,
    paidPaise: amountPaise,
    status: "PAID",
    graceEndsAt: `2026-${String(index + 1).padStart(2, "0")}-05`,
  }));
}

test("R16 real Mongo: failed maturity notice rolls back status and retries cleanly", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: "R16-MAT-ROLLBACK",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-06-30",
    installments: paidFixedInstallments(6),
    version: 1,
  });

  const createMock = mock.method(Message, "create", async () => {
    throw new Error("NOTICE_WRITE_FAILED");
  });

  await assert.rejects(() => runMaturityTransitionBatch({ today: "2026-07-01" }), /NOTICE_WRITE_FAILED/);

  const afterFailure = await Scheme.findById(schemeId).lean();
  assert.equal(afterFailure.status, SchemeStatus.ACTIVE, "maturity status must roll back with notice failure");
  assert.equal(await Message.countDocuments({ schemeId, type: "SCHEME_MATURED" }), 0);

  createMock.mock.restore();

  const batch = await runMaturityTransitionBatch({ today: "2026-07-01" });
  assert.equal(batch.processed, 1);
  const afterSuccess = await Scheme.findById(schemeId).lean();
  assert.equal(afterSuccess.status, SchemeStatus.MATURED);
  assert.equal(await Message.countDocuments({ schemeId, type: "SCHEME_MATURED" }), 1);
});
