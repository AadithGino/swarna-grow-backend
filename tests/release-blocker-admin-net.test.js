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
import { getScheme, getPassbook } from "../src/services/scheme.service.js";
import { listPayments } from "../src/services/payment.service.js";
import { statementNetTotalPaise } from "../src/lib/customer-statement-pdf.js";
import { tenantPortalCapabilitiesDto } from "../src/lib/customer-app-dto.js";
import { isKycMandatoryForEnrolment } from "../src/lib/kyc-policy.js";
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

async function seedPartialPayment({ tenant, branch, customerId }) {
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("plan"),
    enrollmentNumber: "ENR-PARTIAL",
    planSnapshot: { name: "Plan", installmentCount: 11 },
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-12-31",
    installmentAmountPaise: 100_000,
    installments: [
      {
        number: 1,
        dueDate: "2026-01-05",
        amountPaise: 100_000,
        paidPaise: 75_000,
        status: "PARTIALLY_PAID",
        graceEndsAt: "2026-01-10",
      },
    ],
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId,
    receiptNumber: "R-PARTIAL",
    amountPaise: 100_000,
    refundedAmountPaise: 25_000,
    status: PaymentStatus.PARTIALLY_REFUNDED,
    mode: "CASH",
    source: "PORTAL",
    paidAt: new Date("2026-09-02T10:00:00+05:30"),
    allocatedAmountPaise: 100_000,
  });
  return schemeId;
}

test("admin scheme detail and passbook expose net after 25% partial refund", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const schemeId = await seedPartialPayment({ tenant, branch, customerId: customer._id });
  const req = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
    scope: { tenantId: tenant._id },
    params: { schemeId },
  };
  const scheme = await getScheme(req);
  assert.equal(scheme.payments[0].netAmountPaise, 75_000);
  assert.equal(scheme.payments[0].grossAmountPaise, 100_000);
  const passbook = await getPassbook(req);
  assert.equal(passbook.totals.paid.amountPaise, 75_000);
});

test("payment list summary uses net for partial refund", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await seedPartialPayment({ tenant, branch, customerId: customer._id });
  const result = await listPayments({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
    scope: { tenantId: tenant._id },
    query: { includeSummary: "true" },
  });
  assert.equal(result.meta.summary.netCollectedAmount.amountPaise, 75_000);
  assert.equal(result.meta.summary.byStatus.find((r) => r.status === PaymentStatus.PARTIALLY_REFUNDED)?.netAmount.amountPaise, 75_000);
});

test("PDF statement net total excludes fully reversed payment", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "X",
    planSnapshot: {},
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-12-31",
    installments: [],
  });
  await Payment.create([
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
      paidAt: new Date(),
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
      paidAt: new Date(),
    },
  ]);
  const payments = await Payment.find({ tenantId: tenant._id, customerId: customer._id }).lean();
  assert.equal(statementNetTotalPaise(payments), 30_000);
});

test("ops.kycMandatory alone enforces enrolment KYC consistently", async () => {
  const tenant = {
    operations: { kycMandatory: true },
    settings: {},
  };
  assert.equal(isKycMandatoryForEnrolment(tenant), true);
  assert.equal(tenantPortalCapabilitiesDto(tenant).kycMandatory, true);
  const legacy = { operations: {}, settings: { requireKycForEnrolment: true } };
  assert.equal(isKycMandatoryForEnrolment(legacy), true);
});
