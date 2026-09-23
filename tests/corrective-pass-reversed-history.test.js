import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { Payment, Scheme } from "../src/models/index.js";
import {
  PaymentPattern,
  PaymentStatus,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { statementNetTotalPaise } from "../src/lib/customer-statement-pdf.js";
import { getPassbook, getScheme } from "../src/services/scheme.service.js";
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

async function seedSuccessAndReversed({ tenant, branch, customer }) {
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "HIST-REV",
    planSnapshot: {},
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FLEXIBLE,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-12-31",
    installments: [],
    cycles: [],
  });
  await Payment.insertMany([
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId: customer._id,
      receiptNumber: "R-REV",
      amountPaise: 50_000,
      refundedAmountPaise: 50_000,
      status: PaymentStatus.REVERSED,
      mode: "CASH",
      source: "PORTAL",
      paidAt: new Date("2026-09-01"),
    },
    {
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId,
      customerId: customer._id,
      receiptNumber: "R-OK",
      amountPaise: 30_000,
      status: PaymentStatus.SUCCESS,
      mode: "CASH",
      source: "PORTAL",
      paidAt: new Date("2026-09-02"),
    },
  ]);
  return schemeId;
}

test("scheme history lists reversed payment but totals exclude it", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const schemeId = await seedSuccessAndReversed({ tenant, branch, customer });
  const req = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
    scope: { tenantId: tenant._id },
    params: { schemeId },
  };
  const scheme = await getScheme(req);
  assert.equal(scheme.payments.length, 2);
  const reversed = scheme.payments.find((row) => row.status === PaymentStatus.REVERSED);
  assert.ok(reversed);
  assert.equal(reversed.grossAmountPaise, 50_000);
  assert.equal(reversed.netAmountPaise, 0);

  const passbook = await getPassbook(req);
  assert.equal(passbook.rows.length, 2);
  assert.equal(passbook.totals.paid.amountPaise, 30_000);

  const payments = await Payment.find({ schemeId }).lean();
  assert.equal(statementNetTotalPaise(payments), 30_000);
});
