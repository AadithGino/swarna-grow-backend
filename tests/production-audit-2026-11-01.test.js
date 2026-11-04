/**
 * Production audit 2026-11-01 — regression tests asserting safe behavior (MongoDB replica set).
 * Maps to findings F01, F07; complements production-remediation-regressions.test.js (F04/F08).
 */
process.env.NODE_ENV = "test";

import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import { withTransaction } from "../src/lib/transaction.js";
import { DigitalMetalLot, DigitalMetalReservation, DigitalMetalWallet } from "../src/models/index.js";
import {
  creditWalletForTest,
  releaseReservation,
  reserveWalletQuantity,
} from "../src/services/digital-metals-ledger.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const G1 = UG_PER_G;

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("F01: concurrent sell reservations cannot over-allocate a single lot", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G1,
      idempotencyKey: randomUUID(),
    }),
  );

  const run = () =>
    withTransaction((session) =>
      reserveWalletQuantity(session, {
        tenantId: tenant._id,
        customerId: customer._id,
        metal: "GOLD",
        finenessPpm: 999_000,
        quantityUg: G1,
        purpose: "SELL",
        idempotencyKey: randomUUID(),
      }),
    );

  const results = await Promise.allSettled([run(), run()]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one reservation may claim the lot");
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0].reason?.code === "LOT_ALLOCATION_CONFLICT"
      || rejected[0].reason?.code === "INSUFFICIENT_AVAILABLE_UG",
  );

  const wallet = await DigitalMetalWallet.findOne({ tenantId: tenant._id, customerId: customer._id }).lean();
  const lots = await DigitalMetalLot.find({ tenantId: tenant._id, walletId: wallet._id }).lean();
  const remaining = lots.reduce((s, l) => s + Number(l.remainingUg ?? 0), 0);
  const reserved = Number(wallet.reservedUg ?? 0);
  const held = Number(wallet.heldUg ?? 0);
  assert.equal(remaining + reserved, held);
  assert.equal(await DigitalMetalReservation.countDocuments({ tenantId: tenant._id, status: "ACTIVE" }), 1);
});

test("F01: release restores lot remainingUg for a failed follow-up commit path", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const key = randomUUID();
  await withTransaction(async (session) => {
    await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G1,
      idempotencyKey: randomUUID(),
    });
    await reserveWalletQuantity(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G1,
      purpose: "SELL",
      idempotencyKey: key,
    });
    await releaseReservation(session, tenant._id, key, `rel-${key}`);
  });
  const wallet = await DigitalMetalWallet.findOne({ tenantId: tenant._id, customerId: customer._id }).lean();
  const lots = await DigitalMetalLot.find({ tenantId: tenant._id, walletId: wallet._id }).lean();
  assert.equal(lots.reduce((s, l) => s + Number(l.remainingUg ?? 0), 0), G1);
  assert.equal(wallet.reservedUg, 0);
  assert.equal(wallet.heldUg, G1);
});
