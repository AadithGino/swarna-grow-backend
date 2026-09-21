import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId } from "../src/lib/ids.js";
import { LedgerEntry, Scheme } from "../src/models/index.js";
import {
  LedgerEntryType,
  PaymentPattern,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../src/constants/enums.js";
import { buildSchemeMaturityProjection } from "../src/lib/maturity-projection.js";
import { ledgerTotals } from "../src/services/scheme.service.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedSchemeWithLedger({ tenant, branch, user, customerId, overrides = {}, ledger = [] }) {
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-MP-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      benefit: { type: "TEXT_ONLY" },
      ...overrides.planSnapshot,
    },
    valueBasis: ValueBasis.CASH,
    paymentPattern: overrides.paymentPattern ?? PaymentPattern.FIXED,
    status: SchemeStatus.ACTIVE,
    startDate: "2024-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: overrides.installmentAmountPaise ?? 100_000,
    installments: [],
    version: 1,
    createdBy: user._id,
    lockedAveragePaise: overrides.lockedAveragePaise,
  });
  const entries = [];
  for (const [index, row] of ledger.entries()) {
    entries.push(
      await LedgerEntry.create({
        _id: createId("ledger"),
        tenantId: tenant._id,
        branchId: branch._id,
        schemeId: scheme._id,
        customerId,
        type: row.type ?? LedgerEntryType.INSTALLMENT_PAYMENT,
        sequence: index + 1,
        amountPaise: row.amountPaise,
        weightMg: row.weightMg ?? 0,
        actorType: "USER",
        actorId: user._id,
      }),
    );
  }
  const totals = ledgerTotals(entries);
  return { scheme, totals };
}

test("flat benefit maturity projection", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { scheme, totals } = await seedSchemeWithLedger({
    tenant,
    branch,
    user,
    customerId: customer._id,
    ledger: [{ amountPaise: 500_000 }],
    overrides: {
      planSnapshot: {
        benefit: { type: "FIXED_BONUS_AMOUNT", bonusBasis: "FLAT", bonusValue: 40_000 },
      },
    },
  });
  const projection = buildSchemeMaturityProjection({ ...scheme.toObject(), totals });
  assert.equal(projection.projectedPrincipalPaise, 500_000);
  assert.equal(projection.projectedBenefitPaise, 40_000);
  assert.equal(projection.projectedAmountPaise, 540_000);
});

test("percentage benefit with max bonus cap", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { scheme, totals } = await seedSchemeWithLedger({
    tenant,
    branch,
    user,
    customerId: customer._id,
    ledger: [{ amountPaise: 1_000_000 }],
    overrides: {
      planSnapshot: {
        benefit: {
          type: "FIXED_BONUS_AMOUNT",
          bonusBasis: "PERCENT_OF_PAID",
          bonusValue: 10,
          maxBonusPaise: 50_000,
        },
      },
    },
  });
  const projection = buildSchemeMaturityProjection({ ...scheme.toObject(), totals });
  assert.equal(projection.projectedBenefitPaise, 50_000);
});

test("ONE_FREE_INSTALLMENT uses selected installment amount", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { scheme, totals } = await seedSchemeWithLedger({
    tenant,
    branch,
    user,
    customerId: customer._id,
    ledger: [{ amountPaise: 600_000 }],
    overrides: {
      installmentAmountPaise: 75_000,
      planSnapshot: { benefit: { type: "ONE_FREE_INSTALLMENT" } },
    },
  });
  const projection = buildSchemeMaturityProjection({ ...scheme.toObject(), totals });
  assert.equal(projection.projectedBenefitPaise, 75_000);
});

test("flexible plan receives zero one-free benefit", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { scheme, totals } = await seedSchemeWithLedger({
    tenant,
    branch,
    user,
    customerId: customer._id,
    ledger: [{ amountPaise: 400_000 }],
    overrides: {
      paymentPattern: PaymentPattern.FLEXIBLE,
      lockedAveragePaise: 90_000,
      planSnapshot: { benefit: { type: "ONE_FREE_INSTALLMENT" } },
    },
  });
  const projection = buildSchemeMaturityProjection({ ...scheme.toObject(), totals });
  assert.equal(projection.projectedBenefitPaise, 0);
});

test("reversal-aware principal from scheme totals", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { scheme, totals } = await seedSchemeWithLedger({
    tenant,
    branch,
    user,
    customerId: customer._id,
    ledger: [
      { amountPaise: 500_000, weightMg: 2000 },
      { type: LedgerEntryType.REVERSAL, amountPaise: 150_000, weightMg: 600 },
    ],
    overrides: {
      planSnapshot: {
        benefit: { type: "FIXED_BONUS_AMOUNT", bonusBasis: "PERCENT_OF_PAID", bonusValue: 10 },
      },
    },
  });
  const projection = buildSchemeMaturityProjection({ ...scheme.toObject(), totals });
  assert.equal(projection.projectedPrincipalPaise, 350_000);
  assert.equal(projection.projectedBenefitPaise, 35_000);
  assert.equal(projection.projectedWeightMg, 1400);
});

test("large safe-integer values", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const paid = 900_000_000_000;
  const { scheme, totals } = await seedSchemeWithLedger({
    tenant,
    branch,
    user,
    customerId: customer._id,
    ledger: [{ amountPaise: paid }],
    overrides: {
      planSnapshot: {
        benefit: { type: "FIXED_BONUS_AMOUNT", bonusBasis: "PERCENT_OF_PAID", bonusValue: 1 },
      },
    },
  });
  const projection = buildSchemeMaturityProjection({ ...scheme.toObject(), totals });
  assert.equal(projection.projectedBenefitPaise, 9_000_000_000);
  assert.equal(projection.projectedAmountPaise, paid + 9_000_000_000);
});

test("admin GET maturity-projection matches service contract", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const { scheme } = await seedSchemeWithLedger({
    tenant,
    branch,
    user,
    customerId: customer._id,
    ledger: [{ amountPaise: 200_000 }],
    overrides: {
      planSnapshot: {
        benefit: { type: "FIXED_BONUS_AMOUNT", bonusBasis: "FLAT", bonusValue: 10_000 },
      },
    },
  });
  const token = bearerFor(user);
  const response = await request(app)
    .get(`/api/v1/admin/schemes/${scheme._id}/maturity-projection`)
    .set("authorization", `Bearer ${token}`)
    .expect(200);
  assert.equal(response.body.data.schemeId, scheme._id);
  assert.equal(response.body.data.projectedPrincipalPaise, 200_000);
  assert.equal(response.body.data.projectedBenefitPaise, 10_000);
  assert.equal(response.body.data.projectedAmountPaise, 210_000);
  assert.equal(response.body.data.projectedWeightMg, 0);
  assert.ok(response.body.data.maturityDate);
});
