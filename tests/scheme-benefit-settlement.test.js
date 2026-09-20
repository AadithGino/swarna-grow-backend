import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { LedgerEntry, Scheme } from "../src/models/index.js";
import {
  ClosureType,
  LedgerEntryType,
  RedemptionMode,
  SchemeStatus,
  TenantRole,
} from "../src/constants/enums.js";
import { computeConfiguredBenefitPaise } from "../src/lib/scheme-benefit.js";
import { ledgerTotals } from "../src/services/scheme.service.js";
import { settlementPreview } from "../src/services/redemption.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function previewReq(scheme, user) {
  return {
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    params: { schemeId: scheme._id },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
}

async function seedSchemeWithPaid({
  paid,
  benefitDef,
  redemptionRules,
  status = SchemeStatus.MATURED,
  startDate = "2024-01-01",
  maturityDate = "2025-12-01",
}) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-BN-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      redemptionRules: redemptionRules ?? {
        allowedModes: [RedemptionMode.CASH],
        prematureClosureAllowed: true,
        lockInMonths: 0,
        prematurePenalty: { mode: "NONE", value: 0, benefitTreatment: "FORFEIT" },
      },
      benefit: benefitDef,
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status,
    startDate,
    maturityDate,
    installmentAmountPaise: Math.max(1, Math.floor(paid / 3)),
    installments: [],
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
  return { scheme, user, paid };
}

test("flat and percent benefit with maximum cap", () => {
  const paid = 400_000;
  const totals = { amountPaidPaise: paid };
  const scheme = { paymentPattern: "FIXED", installmentAmountPaise: 100_000 };
  assert.equal(
    computeConfiguredBenefitPaise(scheme, totals, {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: 50_000,
    }),
    50_000,
  );
  assert.equal(
    computeConfiguredBenefitPaise(scheme, totals, {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "PERCENT_OF_PAID",
      bonusValue: 10,
    }),
    40_000,
  );
  assert.equal(
    computeConfiguredBenefitPaise(scheme, totals, {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "PERCENT_OF_PAID",
      bonusValue: 10,
      maxBonusPaise: 25_000,
    }),
    25_000,
  );
});

test("flat and percent premature penalties apply after benefit rules", async () => {
  const paid = 300_000;
  const { scheme, user } = await seedSchemeWithPaid({
    paid,
    benefitDef: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: 50_000,
      eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
    },
    redemptionRules: {
      allowedModes: [RedemptionMode.CASH],
      prematureClosureAllowed: true,
      lockInMonths: 0,
      prematurePenalty: { mode: "PERCENT_OF_PAID", value: 10, benefitTreatment: "FULL" },
    },
    status: SchemeStatus.ACTIVE,
    startDate: "2025-01-01",
    maturityDate: "2026-12-01",
  });
  const percentPreview = await settlementPreview(
    previewReq(scheme, user),
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(percentPreview.benefitPaise, 50_000);
  assert.equal(percentPreview.penaltyPaise, 30_000);
  assert.equal(percentPreview.settlementPaise, paid + 50_000 - 30_000);

  const flatScheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: scheme.tenantId,
    branchId: scheme.branchId,
    customerId: scheme.customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-PN-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      redemptionRules: {
        allowedModes: [RedemptionMode.CASH],
        prematureClosureAllowed: true,
        lockInMonths: 0,
        prematurePenalty: { mode: "FLAT", flatPaise: 15_000, benefitTreatment: "FORFEIT" },
      },
      benefit: {
        type: "FIXED_BONUS_AMOUNT",
        bonusBasis: "FLAT",
        bonusValue: 50_000,
      },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2025-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 100_000,
    installments: [],
    version: 1,
    createdBy: user._id,
  });
  await LedgerEntry.create({
    _id: createId("ledger"),
    tenantId: scheme.tenantId,
    branchId: scheme.branchId,
    schemeId: flatScheme._id,
    customerId: scheme.customerId,
    type: LedgerEntryType.INSTALLMENT_PAYMENT,
    sequence: 1,
    amountPaise: paid,
    actorType: "USER",
    actorId: user._id,
    description: "Paid",
  });
  const flatPreview = await settlementPreview(
    previewReq(flatScheme, user),
    ClosureType.PREMATURE_CLOSURE,
  );
  assert.equal(flatPreview.benefitPaise, 0);
  assert.equal(flatPreview.penaltyPaise, 15_000);
  assert.equal(flatPreview.settlementPaise, paid - 15_000);
});

test("maturity preview uses ledger totals for settlement", async () => {
  const paid = 250_000;
  const bonus = 20_000;
  const { scheme, user } = await seedSchemeWithPaid({
    paid,
    benefitDef: {
      type: "FIXED_BONUS_AMOUNT",
      bonusBasis: "FLAT",
      bonusValue: bonus,
      eligibility: { requireAllInstallmentsPaid: false, minMonthsCompleted: 0 },
    },
  });
  const preview = await settlementPreview(
    previewReq(scheme, user),
    ClosureType.MATURITY_REDEMPTION,
  );
  const totals = ledgerTotals(await LedgerEntry.find({ schemeId: scheme._id }).lean());
  assert.equal(preview.principalPaise, totals.amountPaidPaise);
  assert.equal(preview.benefitPaise, bonus);
  assert.equal(preview.settlementPaise, paid + bonus);
});
