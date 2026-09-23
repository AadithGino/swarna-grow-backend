import { describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  ClosureType,
  LedgerEntryType,
  RedemptionMode,
  RedemptionStatus,
  SchemeStatus,
  TenantRole,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { today } from "../src/lib/date.js";
import { LedgerEntry, Redemption, Scheme, Session } from "../src/models/index.js";
import { setGoldRate } from "../src/services/tenant.service.js";
import { signAccessToken } from "../src/services/token.service.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { buildEligibleMaturedFixedSchemeFields } from "./helpers/maturity-fixtures.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });

async function customerToken(tenantId, branchId, customerId) {
  const session = await Session.create({
    _id: createId("session"),
    customerId,
    tenantId,
    deviceId: "customer-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return signAccessToken({
    id: customerId,
    type: "CUSTOMER",
    tenantId,
    branchId,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "customer-device",
    securityVersion: 0,
    sessionId: session._id,
  });
}

async function seedMaturedScheme({ valueBasis, allowedModes, amountPaise = 300_000, weightMg = 600 }) {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-RDM-${createId("x").slice(-6)}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      valueBasis,
      goldRules: valueBasis === "GOLD_WEIGHT"
        ? { weightRoundingMode: "HALF_UP", weightPrecisionMg: 1 }
        : undefined,
      redemptionRules: { allowedModes, prematureClosureAllowed: false },
      benefit: { type: "TEXT_ONLY", displayLabel: "Gift" },
    },
    valueBasis,
    paymentPattern: "FIXED",
    status: SchemeStatus.MATURED,
    ...buildEligibleMaturedFixedSchemeFields({
      totalPaidPaise: amountPaise,
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
    amountPaise,
    weightMg: valueBasis === "GOLD_WEIGHT" ? weightMg : undefined,
    actorType: "USER",
    actorId: user._id,
    description: "Paid",
  });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { ledgerNextSequence: 1 } });
  const needsGoldRate =
    valueBasis === "GOLD_WEIGHT"
    || allowedModes.some((m) => m !== RedemptionMode.CASH);
  if (needsGoldRate) {
    await setGoldRate({
      auth: { id: user._id, tenantId: tenant._id },
      headers: { "user-agent": "test" },
      body: { effectiveDate: today(), ratePerGramPaise: 520_000, branchId: branch._id },
    });
  }
  const adminToken = bearerFor(user);
  const custToken = await customerToken(tenant._id, branch._id, customer._id);
  return { tenant, branch, user, customer, scheme, adminToken, custToken, amountPaise, weightMg };
}

describe("redemption mode matrix HTTP", { concurrency: false }, () => {
  test.beforeEach(async () => { await resetTestDb(); });

  async function flow({ valueBasis, mode, billNumber }) {
    const allowed =
      valueBasis === "CASH"
        ? [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER, RedemptionMode.PURCHASE_ADJUSTMENT]
        : [RedemptionMode.CASH, RedemptionMode.GOLD_HANDOVER, RedemptionMode.PURCHASE_ADJUSTMENT];
    const ctx = await seedMaturedScheme({ valueBasis, allowedModes: allowed });
    const preview = await request(app)
      .get(`/api/v1/admin/schemes/${ctx.scheme._id}/settlement-preview`)
      .query({ mode, type: ClosureType.MATURITY_REDEMPTION })
      .set("authorization", `Bearer ${ctx.adminToken}`)
      .expect(200);
    assert.equal(preview.body.data.mode, mode);
    assert.equal(preview.body.data.eligible, true);
    if (valueBasis === "GOLD_WEIGHT") {
      assert.ok(preview.body.data.modePreviews?.[mode]);
      const mp = preview.body.data.modePreviews[mode];
      if (mp.rateApplied?.ratePerGramPaise != null) {
        assert.equal(
          preview.body.data.valuationRatePerGramPaise,
          mp.rateApplied.ratePerGramPaise,
        );
      }
      if (mp.weight?.weightMg != null && preview.body.data.weightMg != null) {
        assert.equal(preview.body.data.weightMg, mp.weight.weightMg);
      }
    }
    const reqBody = {
      preferredMode: mode,
      expectedVersion: ctx.scheme.version,
      ...(mode === RedemptionMode.PURCHASE_ADJUSTMENT
        ? { modeDetails: { billNumber: billNumber ?? "BILL-001" } }
        : {}),
    };
    const created = await request(app)
      .post(`/api/v1/app/schemes/${ctx.scheme._id}/redemption-request`)
      .set("authorization", `Bearer ${ctx.custToken}`)
      .set("x-idempotency-key", `req-${mode}-${ctx.scheme._id}`)
      .send(reqBody)
      .expect(201);
    const redemptionId = created.body.data.id ?? created.body.data._id;
    const beforeLedger = await LedgerEntry.countDocuments({ schemeId: ctx.scheme._id });
    await request(app)
      .post(`/api/v1/admin/redemptions/${redemptionId}/approve`)
      .set("authorization", `Bearer ${ctx.adminToken}`)
      .set("x-idempotency-key", `appr-${redemptionId}`)
      .send({})
      .expect(200);
    assert.equal(await LedgerEntry.countDocuments({ schemeId: ctx.scheme._id }), beforeLedger);
    const completeBody =
      mode === RedemptionMode.PURCHASE_ADJUSTMENT
        ? { modeDetails: { billNumber: billNumber ?? "BILL-001" } }
        : {};
    await request(app)
      .post(`/api/v1/admin/redemptions/${redemptionId}/complete`)
      .set("authorization", `Bearer ${ctx.adminToken}`)
      .set("x-idempotency-key", `cmp-${redemptionId}`)
      .send(completeBody)
      .expect(200);
    const row = await Redemption.findById(redemptionId).lean();
    assert.equal(row.status, RedemptionStatus.COMPLETED);
    assert.equal(row.mode, mode);
    assert.ok(row.modeDetails?.settlementSnapshot);
    assert.equal(row.settlementPaise, preview.body.data.settlementPaise);
    const scheme = await Scheme.findById(ctx.scheme._id).lean();
    assert.equal(scheme.status, SchemeStatus.REDEEMED);
    const ledgerCount = await LedgerEntry.countDocuments({ schemeId: ctx.scheme._id });
    assert.ok(ledgerCount > beforeLedger);
    await request(app)
      .post(`/api/v1/admin/redemptions/${redemptionId}/complete`)
      .set("authorization", `Bearer ${ctx.adminToken}`)
      .set("x-idempotency-key", `cmp-dup-${redemptionId}`)
      .send(completeBody)
      .expect(422);
    if (mode === RedemptionMode.CASH) {
      assert.ok(row.cashOutPaise > 0);
    }
    if (mode === RedemptionMode.GOLD_HANDOVER) {
      assert.equal(row.cashOutPaise ?? 0, 0);
      assert.ok((row.weightMg ?? 0) > 0);
    }
    if (mode === RedemptionMode.PURCHASE_ADJUSTMENT) {
      assert.equal(row.cashOutPaise ?? 0, 0);
      assert.equal(row.modeDetails?.billNumber, billNumber ?? "BILL-001");
    }
    return { ctx, preview: preview.body.data, row };
  }

  for (const [label, valueBasis] of [
    ["cash-value", "CASH"],
    ["gold-weight", "GOLD_WEIGHT"],
  ]) {
    for (const mode of [
      RedemptionMode.CASH,
      RedemptionMode.GOLD_HANDOVER,
      RedemptionMode.PURCHASE_ADJUSTMENT,
    ]) {
      test(`${label} ${mode} request → approve → complete`, async () => {
        await flow({ valueBasis, mode });
      });
    }
  }
});
