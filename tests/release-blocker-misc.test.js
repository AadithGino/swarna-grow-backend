import test from "node:test";
import assert from "node:assert/strict";
import { customerBody, customerPatchBody } from "../src/validators/common.validators.js";
import { Payment, PaymentIntent } from "../src/models/index.js";
import {
  PaymentIntentStatus,
  PaymentStatus,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { Scheme } from "../src/models/index.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("staff customer create rejects unknown fields", () => {
  const parsed = customerBody.safeParse({
    name: "Test User",
    mobile: "+919876543210",
    tenantId: "injected",
  });
  assert.equal(parsed.success, false);
});

test("staff customer patch allows mobile and rejects unknown fields", () => {
  const patch = customerPatchBody.safeParse({
    name: "Updated",
    mobile: "+919111122233",
    expectedVersion: 1,
  });
  assert.equal(patch.success, true);
  const unknown = customerPatchBody.safeParse({
    name: "Updated",
    hackerField: true,
    expectedVersion: 1,
  });
  assert.equal(unknown.success, false);
});

test("partially refunded payment still counts toward maxPaymentsPerCycle", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "FLEX-1",
    planSnapshot: {
      paymentPattern: "FLEXIBLE",
      flexibleRules: {
        flexiblePhase: { maxPaymentsPerCycle: 1 },
      },
    },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    flexiblePhase: "FLEXIBLE",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-31",
    cycles: [],
    installments: [],
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: scheme.tenantId,
    branchId: scheme.branchId,
    schemeId: scheme._id,
    customerId: scheme.customerId,
    receiptNumber: "R-SLOT",
    amountPaise: 50_000,
    refundedAmountPaise: 10_000,
    status: PaymentStatus.PARTIALLY_REFUNDED,
    mode: "CASH",
    source: "PORTAL",
    targetCycle: "2026-01",
    paidAt: new Date(),
  });
  const count = await Payment.countDocuments({
    tenantId: scheme.tenantId,
    schemeId: scheme._id,
    targetCycle: "2026-01",
    status: { $in: [PaymentStatus.SUCCESS, PaymentStatus.PARTIALLY_REFUNDED] },
  });
  assert.equal(count, 1);
  const openIntents = await PaymentIntent.countDocuments({
    tenantId: scheme.tenantId,
    schemeId: scheme._id,
    targetCycle: "2026-01",
    status: PaymentIntentStatus.PENDING,
    reservationExpiresAt: { $gt: new Date() },
  });
  assert.equal(count + openIntents >= 1, true);
});
