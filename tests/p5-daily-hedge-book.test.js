process.env.NODE_ENV = "test";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";

import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import dayjs from "dayjs";
import { istBusinessDayBounds } from "../src/lib/digital-metals-business-calendar.js";
import { resetCalendarDateOverrideForTests } from "../src/lib/date.js";
import { performance } from "node:perf_hooks";
import { DigitalMetalJournal, DigitalMetalWallet, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { withTransaction } from "../src/lib/transaction.js";
import { creditWalletForTest } from "../src/services/digital-metals-ledger.service.js";
import {
  buildDailyHedgeBookLine,
  computeClosingMetalOwed,
} from "../src/lib/digital-metals-daily-hedge-book.js";

const app = createApp();
const G2 = 2 * UG_PER_G;

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  resetCalendarDateOverrideForTests();
});

async function enablePlan(tenantId) {
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "subscription.planFeaturesSnapshot.digitalMetals": true,
        "subscription.tier": PlanTier.GROWTH,
        "operations.digitalMetalsEnabled": true,
      },
    },
  );
}

test("closing metal owed formula", () => {
  const closing = computeClosingMetalOwed({
    openingMetalOwedUg: G2,
    creditedBuyUg: UG_PER_G,
    executedSellUg: UG_PER_G,
    physicalHandoverUg: 0,
    correctionUg: 0,
  });
  assert.equal(closing, G2);
});

test("as-of cutoff matches ledger held including reservations", async () => {
  const { today } = await import("../src/lib/date.js");
  const reportDate = today();
  const { tenant, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G2,
      idempotencyKey: randomUUID(),
    }),
  );
  const { end } = istBusinessDayBounds(reportDate);
  const line = await buildDailyHedgeBookLine(tenant._id, "GOLD", 999_000, reportDate, end, null);
  assert.equal(line.ledgerReconcileDeltaUg, 0);
  assert.equal(line.closingMetalOwedUg, G2);
  assert.equal(line.ledgerHeldUg, G2);
});

test("wallet totals endpoint is independent of hedge live and respects branch scope", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G2,
      idempotencyKey: randomUUID(),
    }),
  );
  const token = bearerFor(user);
  const [totals, hedge] = await Promise.all([
    request(app)
      .get("/api/v1/admin/digital-metals/dashboard/wallet-totals")
      .set("Authorization", `Bearer ${token}`),
    request(app)
      .get("/api/v1/admin/digital-metals/hedge/live")
      .set("Authorization", `Bearer ${token}`),
  ]);
  assert.equal(totals.status, 200);
  assert.equal(hedge.status, 200);
  assert.equal(hedge.body.data.reportType, "DAILY_HEDGE_BOOK");
  const goldTotal = totals.body.data.lines.find((l) => l.metal === "GOLD");
  assert.equal(Number(goldTotal?.heldUg), G2);
  assert.ok(totals.body.data.computedAt);
  assert.ok(Array.isArray(totals.body.data.lines));
});

test("unclassified journal delta is tracked separately from ordinary corrections", async () => {
  const { today } = await import("../src/lib/date.js");
  const reportDate = today();
  const { tenant, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G2,
      idempotencyKey: randomUUID(),
    }),
  );
  const wallet = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  assert.ok(wallet);
  const mysteryUg = UG_PER_G;
  const { end } = istBusinessDayBounds(reportDate);
  await withTransaction(async (session) => {
    const nextSeq = (wallet.journalSequence ?? 0) + 1;
    await DigitalMetalJournal.create(
      [
        {
          _id: createId("dmj"),
          tenantId: tenant._id,
          walletId: wallet._id,
          sequence: nextSeq,
          entryType: "CREDIT",
          quantityUgDelta: mysteryUg,
          reservedUgDelta: 0,
          idempotencyKey: randomUUID(),
          referenceType: "LEGACY_IMPORT_UNKNOWN",
          referenceId: "p5-unclassified",
          createdAt: end,
        },
      ],
      { session },
    );
    await DigitalMetalWallet.updateOne(
      { _id: wallet._id },
      { $set: { journalSequence: nextSeq }, $inc: { heldUg: mysteryUg } },
    ).session(session);
  });
  const line = await buildDailyHedgeBookLine(tenant._id, "GOLD", 999_000, reportDate, end, null);
  assert.equal(line.movements.unclassifiedJournalUg, mysteryUg);
  assert.equal(line.movements.correctionUg, G2);
  assert.notEqual(line.ledgerReconcileDeltaUg, 0);
});

test("wallet projection drift compares stored heldUg with ledger replay at cutoff", async () => {
  const { today } = await import("../src/lib/date.js");
  const reportDate = today();
  const { tenant, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G2,
      idempotencyKey: randomUUID(),
    }),
  );
  const wallet = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  await DigitalMetalWallet.updateOne({ _id: wallet._id }, { $inc: { heldUg: UG_PER_G } });
  const { end } = istBusinessDayBounds(reportDate);
  const line = await buildDailyHedgeBookLine(tenant._id, "GOLD", 999_000, reportDate, end, null);
  assert.equal(line.walletProjectionDriftUg, UG_PER_G);
  assert.equal(line.ledgerHeldUg, G2);
  assert.equal(line.walletStoredHeldUg, G2 + UG_PER_G);
});

test("wallet projection drift is not computed for same-day mid-day asOf cutoff", async () => {
  const { today } = await import("../src/lib/date.js");
  const reportDate = today();
  const { tenant, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G2,
      idempotencyKey: randomUUID(),
    }),
  );
  const wallet = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  await DigitalMetalWallet.updateOne({ _id: wallet._id }, { $inc: { heldUg: UG_PER_G } });
  const { start, end } = istBusinessDayBounds(reportDate);
  const midDay = new Date(Math.floor((start.getTime() + end.getTime()) / 2));
  // Ledger cutoff is exclusive of entries after midDay; pin journal time before midDay (wall-clock "now" may be later).
  const journalAt = new Date(start.getTime() + 60 * 60 * 1000);
  assert.ok(journalAt.getTime() < midDay.getTime(), "fixture journal must precede mid-day cutoff");
  await DigitalMetalJournal.collection.updateMany(
    { walletId: wallet._id },
    { $set: { createdAt: journalAt, updatedAt: journalAt } },
  );
  const line = await buildDailyHedgeBookLine(tenant._id, "GOLD", 999_000, reportDate, midDay, null);
  assert.equal(line.walletProjectionDriftApplicable, false);
  assert.equal(line.walletProjectionDriftUg, 0);
  assert.equal(line.ledgerHeldUg, G2);
});

test("wallet projection drift is not computed for historical business dates", async () => {
  const { today, setCalendarDateOverrideForTests } = await import("../src/lib/date.js");
  const reportDate = today();
  setCalendarDateOverrideForTests(reportDate);
  const { tenant, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G2,
      idempotencyKey: randomUUID(),
    }),
  );
  const wallet = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: customer._id,
    metal: "GOLD",
    finenessPpm: 999_000,
  }).lean();
  await DigitalMetalWallet.updateOne({ _id: wallet._id }, { $inc: { heldUg: UG_PER_G } });
  const ymd = dayjs(reportDate).subtract(1, "day").format("YYYY-MM-DD");
  const { end } = istBusinessDayBounds(ymd);
  const line = await buildDailyHedgeBookLine(tenant._id, "GOLD", 999_000, ymd, end, null);
  assert.equal(line.walletProjectionDriftApplicable, false);
  assert.equal(line.walletProjectionDriftUg, 0);
  resetCalendarDateOverrideForTests();
});

test("daily hedge book HTTP responds within performance budget", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: UG_PER_G,
      idempotencyKey: randomUUID(),
    }),
  );
  const token = bearerFor(user);
  const started = performance.now();
  const res = await request(app)
    .get("/api/v1/admin/digital-metals/hedge/live")
    .set("Authorization", `Bearer ${token}`);
  const elapsedMs = performance.now() - started;
  assert.equal(res.status, 200);
  assert.ok(elapsedMs < 5000, `hedge live should respond in under 5s, took ${elapsedMs.toFixed(0)}ms`);
});
