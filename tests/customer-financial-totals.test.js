import test from "node:test";
import assert from "node:assert/strict";
import { LedgerEntryType, PaymentStatus, SchemeStatus, ValueBasis } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { buildCustomerGoldValuation } from "../src/lib/customer-gold-valuation.js";
import {
  lifetimePaidPaiseFromLedgerEntries,
  netGoldWeightMgFromLedgerEntries,
} from "../src/lib/customer-financial-totals.js";
import { moneyPaiseFromWeightMg } from "../src/lib/money.js";
import { GoldRate, LedgerEntry, Payment, Scheme, Tenant } from "../src/models/index.js";
import { buildHome } from "../src/services/customer-app.service.js";
import { customer360 } from "../src/services/customer.service.js";
import { today } from "../src/lib/date.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("lifetime paid subtracts reversals and ignores unallocated ledger rows", () => {
  const entries = [
    { type: "INSTALLMENT_PAYMENT", amountPaise: 100_000 },
    { type: "FREE_WINDOW_PAYMENT", amountPaise: 50_000 },
    { type: "REVERSAL", amountPaise: 25_000 },
    { type: "UNALLOCATED_PAYMENT", amountPaise: 200_000 },
    { type: "BENEFIT_CREDIT", amountPaise: 10_000 },
  ];
  assert.equal(lifetimePaidPaiseFromLedgerEntries(entries), 125_000);
});

test("net gold weight excludes cash-scheme ledger rows", () => {
  const goldId = "sch_gold";
  const cashId = "sch_cash";
  const goldSet = new Set([goldId]);
  const entries = [
    { schemeId: goldId, type: "INSTALLMENT_PAYMENT", weightMg: 1000 },
    { schemeId: cashId, type: "INSTALLMENT_PAYMENT", weightMg: 500 },
    { schemeId: goldId, type: "REVERSAL", weightMg: 200 },
  ];
  assert.equal(netGoldWeightMgFromLedgerEntries(entries, goldSet), 800);
});

test("customer360 lifetime paid matches ledger net and excludes unallocated payments from count", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await Promise.all([
    LedgerEntry.create({
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: createId("scheme"),
      customerId: customer._id,
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      sequence: 1,
      amountPaise: 300_000,
      effectiveAt: new Date(),
    }),
    LedgerEntry.create({
      _id: createId("ledger"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: createId("scheme"),
      customerId: customer._id,
      type: LedgerEntryType.REVERSAL,
      sequence: 2,
      amountPaise: 100_000,
      effectiveAt: new Date(),
    }),
    Payment.create({
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: createId("scheme"),
      customerId: customer._id,
      receiptNumber: "R-ALLOC",
      amountPaise: 200_000,
      allocatedAmountPaise: 200_000,
      status: PaymentStatus.SUCCESS,
      mode: "CASH",
      source: "CUSTOMER_APP",
    }),
    Payment.create({
      _id: createId("payment"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: createId("scheme"),
      customerId: customer._id,
      receiptNumber: "R-SUSP",
      amountPaise: 500_000,
      status: PaymentStatus.UNALLOCATED_PENDING_REVIEW,
      mode: "ONLINE_GATEWAY",
      source: "CUSTOMER_APP",
    }),
  ]);
  const profile = await customer360({
    params: { customerId: customer._id },
    auth: { tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
  });
  assert.equal(profile.summary.lifetimePaidPaise, 200_000);
  assert.equal(profile.summary.paymentCount, 1);
});

test("missing 22K rate returns unavailable valuation, not total paid", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const schemeId = createId("scheme");
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "GOLD-1",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: ValueBasis.GOLD_WEIGHT,
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-12-31",
    installments: [],
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId: customer._id,
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    sequence: 1,
    amountPaise: 500_000,
    weightMg: 1000,
    effectiveAt: new Date(),
  });
  const tenantDoc = await Tenant.findById(tenant._id).lean();
  const home = await buildHome(
    { id: customer._id, tenantId: tenant._id, branchId: branch._id },
    tenantDoc,
    {},
  );
  assert.equal(home.hasGoldAccumulationScheme, true);
  assert.equal(home.summary.goldAccumulated.weightMg, 1000);
  assert.equal(home.summary.currentValuation, null);
  assert.equal(home.summary.valuationAvailable, false);
  assert.equal(home.summary.valuationBlocker, "GOLD_RATE_NOT_SET");
  assert.equal(home.summary.totalPaid.amountPaise, 500_000);
});

test("22K rate values net gold weight on app home", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const schemeId = createId("scheme");
  const effectiveDate = today();
  await GoldRate.create({
    _id: createId("rate"),
    tenantId: tenant._id,
    branchId: branch._id,
    purity: "22K",
    effectiveDate,
    ratePerGramPaise: 600_000,
  });
  await Scheme.create({
    _id: schemeId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "GOLD-2",
    planSnapshot: {},
    valueBasis: ValueBasis.GOLD_WEIGHT,
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2026-01-01",
    maturityDate: "2026-12-31",
    installments: [],
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId,
    customerId: customer._id,
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    sequence: 1,
    amountPaise: 100_000,
    weightMg: 1000,
    effectiveAt: new Date(),
  });
  const expected = moneyPaiseFromWeightMg(1000, 600_000);
  const valuation = buildCustomerGoldValuation({
    hasGoldAccumulationScheme: true,
    netGoldWeightMg: 1000,
    ratePerGramPaise: 600_000,
  });
  assert.equal(valuation.valuationAvailable, true);
  assert.equal(valuation.currentValuation.amountPaise, expected);
  const tenantDoc = await Tenant.findById(tenant._id).lean();
  const home = await buildHome(
    { id: customer._id, tenantId: tenant._id, branchId: branch._id },
    tenantDoc,
    {},
  );
  assert.equal(home.summary.currentValuation.amountPaise, expected);
});

test("zero gold weight keeps valid valuation at zero when rate exists", () => {
  const valuation = buildCustomerGoldValuation({
    hasGoldAccumulationScheme: true,
    netGoldWeightMg: 0,
    ratePerGramPaise: 500_000,
  });
  assert.equal(valuation.valuationAvailable, true);
  assert.equal(valuation.currentValuation.amountPaise, 0);
});
