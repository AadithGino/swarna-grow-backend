import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/lib/app-error.js";
import { createId } from "../src/lib/ids.js";
import { Customer, LedgerEntry, Redemption, Scheme } from "../src/models/index.js";
import {
  LedgerEntryType,
  RedemptionMode,
  RedemptionStatus,
  SchemeStatus,
  TenantRole,
} from "../src/constants/enums.js";
import {
  requestCustomerRedemption,
  transitionRedemption,
} from "../src/services/redemption.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { buildEligibleMaturedFixedSchemeFields } from "./helpers/maturity-fixtures.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("failed redemption complete rolls back all redemption ledger rows", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Rollback Customer",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const paid = 300_000;
  const bonus = 50_000;
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-RB-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      redemptionRules: {
        allowedModes: [RedemptionMode.CASH],
        prematureClosureAllowed: false,
      },
      benefit: {
        type: "FIXED_BONUS_AMOUNT",
        bonusBasis: "FLAT",
        bonusValue: bonus,
        displayLabel: "Flat bonus",
        eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
      },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.MATURED,
    ...buildEligibleMaturedFixedSchemeFields({
      totalPaidPaise: paid,
      startDate: "2024-01-01",
      maturityDate: "2025-12-01",
    }),
    version: 1,
    createdBy: user._id,
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: scheme._id,
    customerId: customer._id,
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    sequence: 1,
    amountPaise: paid,
    actorType: "USER",
    actorId: user._id,
    description: "Paid",
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });

  const requested = await requestCustomerRedemption({
    auth: { id: customer._id, tenantId: tenant._id, type: "CUSTOMER" },
    scope: { tenantId: tenant._id },
    params: { schemeId: scheme._id },
    body: { preferredMode: RedemptionMode.CASH, expectedVersion: scheme.version },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  });
  await transitionRedemption({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { redemptionId: requested.id },
    body: {},
    query: {},
    headers: {},
    ip: "127.0.0.1",
  }, "approve");

  const originalCreate = LedgerEntry.create.bind(LedgerEntry);
  LedgerEntry.create = async function failOnRedemptionDebit(docs, options) {
    const rows = Array.isArray(docs) ? docs : [docs];
    if (rows.some((row) => row.type === LedgerEntryType.REDEMPTION_DEBIT)) {
      throw new AppError("SIMULATED_LEDGER_FAILURE", "Injected failure", 500);
    }
    return originalCreate(docs, options);
  };

  try {
    await assert.rejects(
      () => transitionRedemption({
        auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
        scope: { tenantId: tenant._id, branchId: branch._id },
        params: { redemptionId: requested.id },
        body: {},
        query: {},
        headers: {},
        ip: "127.0.0.1",
      }, "complete"),
      (error) => error.code === "SIMULATED_LEDGER_FAILURE",
    );
  } finally {
    LedgerEntry.create = originalCreate;
  }

  const redemption = await Redemption.findById(requested.id).lean();
  assert.equal(redemption.status, RedemptionStatus.APPROVED);
  const schemeAfter = await Scheme.findById(scheme._id).lean();
  assert.equal(schemeAfter.status, SchemeStatus.MATURED);

  const redemptionLedger = await LedgerEntry.find({
    schemeId: scheme._id,
    redemptionId: requested.id,
  }).lean();
  assert.equal(redemptionLedger.length, 0);

  const sequences = await LedgerEntry.find({ schemeId: scheme._id })
    .sort({ sequence: 1 })
    .lean();
  assert.deepEqual(sequences.map((row) => row.type), [LedgerEntryType.INSTALLMENT_PAYMENT]);
  assert.equal(sequences.length, 1);
});
