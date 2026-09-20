import test from "node:test";
import assert from "node:assert/strict";
import { Scheme, SchemePlan } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { TenantRole } from "../src/constants/enums.js";
import { enrol } from "../src/services/scheme.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("two simultaneous enrolments for the final plan slot: one succeeds, one capacity error", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const planId = createId("schemePlan");
  await SchemePlan.create({
    _id: planId,
    tenantId: tenant._id,
    code: "CAP1",
    name: "Single seat",
    status: "ACTIVE",
    paymentPattern: "FIXED",
    valueBasis: "CASH",
    durationMonths: 11,
    installmentCount: 11,
    amountRules: { amountMode: "JEWELLER_FIXED", fixedAmountPaise: 100000 },
    scheduleRules: {
      dueDateRule: "JOIN_ANNIVERSARY",
      firstInstallmentModeDefault: "START_NEXT_CYCLE",
    },
    availability: { allBranches: true, maxEnrolments: 1, visibleInCustomerApp: true, customerSelfEnrolAllowed: true },
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
      displayLabel: "Benefit",
      eligibility: { requireAllInstallmentsPaid: true, maxAllowedDefaults: 0, minMonthsCompleted: 0 },
    },
    version: 1,
  });
  const customerA = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: `+9191${String(Date.now()).slice(-8)}`,
  });
  const customerB = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: `+9192${String(Date.now()).slice(-8)}`,
  });
  const baseReq = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    tenant,
    headers: {},
    ip: "127.0.0.1",
    body: {
      planId,
      branchId: branch._id,
      installmentAmountPaise: 100_000,
      firstInstallmentMode: "START_NEXT_CYCLE",
    },
  };
  const results = await Promise.allSettled([
    enrol({ ...baseReq, body: { ...baseReq.body, customerId: customerA._id } }),
    enrol({ ...baseReq, body: { ...baseReq.body, customerId: customerB._id } }),
  ]);
  const ok = results.filter((row) => row.status === "fulfilled");
  const failed = results.filter((row) => row.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason?.code, "PLAN_ENROLMENT_LIMIT_REACHED");
  assert.equal(await Scheme.countDocuments({ tenantId: tenant._id, planId }), 1);
});
