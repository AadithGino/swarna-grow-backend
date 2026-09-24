import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { Payment, Scheme } from "../src/models/index.js";
import {
  PaymentMode,
  PaymentPattern,
  PaymentSource,
  PaymentStatus,
  RedemptionMode,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { adminStaffBalanceDetail } from "../src/services/cash.service.js";
import { settlementPreview } from "../src/services/redemption.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("cash staff detail ignores foreign-tenant customer ids", async () => {
  const primary = await seedTenantUser({ role: TenantRole.BRANCH_STAFF });
  const other = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
    mobile: `+9197${String(Date.now()).slice(-8)}`,
  });
  const foreignCustomer = await seedCustomer({
    tenantId: other.tenant._id,
    branchId: other.branch._id,
    name: "Foreign Tenant Customer",
  });
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: primary.tenant._id,
    branchId: primary.branch._id,
    customerId: foreignCustomer._id,
    planId: createId("plan"),
    enrollmentNumber: "SCOPE-1",
    planSnapshot: {},
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-12-31",
    installments: [],
  });
  await Payment.create({
    _id: createId("payment"),
    tenantId: primary.tenant._id,
    branchId: primary.branch._id,
    schemeId,
    customerId: foreignCustomer._id,
    receiptNumber: "FOREIGN-CUST",
    amountPaise: 50_000,
    status: PaymentStatus.SUCCESS,
    mode: PaymentMode.CASH,
    source: PaymentSource.PORTAL,
    collectedBy: primary.user._id,
    paidAt: new Date("2026-09-01"),
  });
  const detail = await adminStaffBalanceDetail({
    auth: {
      id: primary.user._id,
      tenantId: primary.tenant._id,
      type: "TENANT_USER",
      role: TenantRole.BRANCH_MANAGER,
    },
    scope: { tenantId: primary.tenant._id, branchId: primary.branch._id },
    params: { staffId: primary.user._id },
  });
  const row = detail.collections.find((entry) => entry.receiptNumber === "FOREIGN-CUST");
  assert.equal(row.customer.name, foreignCustomer._id);
});

test("cash-value scheme gold-handover mode note describes conversion at handover rate", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "CASH-GH",
    planSnapshot: {
      paymentPattern: "FIXED",
      redemptionRules: {
        allowedModes: [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER],
        prematureClosureAllowed: false,
      },
      benefit: { type: "TEXT_ONLY", displayLabel: "Benefit" },
    },
    valueBasis: ValueBasis.CASH,
    paymentPattern: PaymentPattern.FIXED,
    status: SchemeStatus.MATURED,
    startDate: "2025-01-01",
    maturityDate: "2025-12-01",
    installmentAmountPaise: 100_000,
    installments: [{
      number: 1,
      dueDate: "2025-01-05",
      amountPaise: 100_000,
      paidPaise: 100_000,
      status: "PAID",
      graceEndsAt: "2025-01-10",
    }],
    version: 1,
    createdBy: user._id,
  });
  const preview = await settlementPreview({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    tenant,
    params: { schemeId: scheme._id },
    body: { mode: RedemptionMode.GOLD_HANDOVER },
    query: {},
  }, "MATURITY_REDEMPTION");
  const handover = preview.allowedModes.find((row) => row.mode === RedemptionMode.GOLD_HANDOVER);
  assert.match(
    handover.note,
    /22K rate on the handover date/i,
  );
});
