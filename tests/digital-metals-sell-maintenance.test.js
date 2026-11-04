process.env.NODE_ENV = "test";

import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import { createId } from "../src/lib/ids.js";
import { withTransaction } from "../src/lib/transaction.js";
import {
  DigitalMetalLot,
  DigitalMetalReservation,
  DigitalMetalSellOrder,
  DigitalMetalWallet,
} from "../src/models/index.js";
import {
  creditWalletForTest,
  releaseReservation,
  reserveWalletQuantity,
} from "../src/services/digital-metals-ledger.service.js";
import { expireAndReleaseSellOrder } from "../src/services/digital-metals-sell-maintenance.service.js";
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

test("expire sell order rolls back when lot restoration fails", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const idempotencyKey = randomUUID();
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
  const reserveKey = `${idempotencyKey}:reserve`;
  const { reservation } = await withTransaction((session) =>
    reserveWalletQuantity(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G1,
      purpose: "SELL",
      idempotencyKey: reserveKey,
    }),
  );
  const order = await DigitalMetalSellOrder.create({
    _id: createId("dmso"),
    tenantId: tenant._id,
    customerId: customer._id,
    quoteId: createId("dmqt"),
    reservationId: reservation._id,
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: G1,
    settlementPaise: 50_000,
    status: "RESERVED",
    idempotencyKey,
    quoteExpiresAt: new Date(Date.now() - 60_000),
    termsAcceptedAt: new Date(),
    termsVersion: "v1",
    termsContentHash: "hash",
  });

  const originalRestore = DigitalMetalLot.updateOne.bind(DigitalMetalLot);
  DigitalMetalLot.updateOne = async (filter, update, opts) => {
    if (update?.$inc?.remainingUg > 0) {
      return { modifiedCount: 0, matchedCount: 0, acknowledged: true };
    }
    return originalRestore(filter, update, opts);
  };

  try {
    await assert.rejects(
      () => expireAndReleaseSellOrder(order.toObject()),
      (err) => err?.code === "LOT_RESTORE_FAILED",
    );
  } finally {
    DigitalMetalLot.updateOne = originalRestore;
  }

  const reloaded = await DigitalMetalSellOrder.findById(order._id).lean();
  assert.equal(reloaded.status, "RESERVED");
  const rsv = await DigitalMetalReservation.findById(reservation._id).lean();
  assert.equal(rsv.status, "ACTIVE");
  const wallet = await DigitalMetalWallet.findOne({ tenantId: tenant._id, customerId: customer._id }).lean();
  assert.equal(wallet.reservedUg, G1);
});

test("release after prior release is idempotent without masking restore errors", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const idempotencyKey = randomUUID();
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
  await withTransaction((session) =>
    reserveWalletQuantity(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G1,
      purpose: "SELL",
      idempotencyKey,
    }),
  );
  await withTransaction((session) =>
    releaseReservation(session, tenant._id, idempotencyKey, `release-1:${idempotencyKey}`),
  );
  await withTransaction((session) =>
    releaseReservation(session, tenant._id, idempotencyKey, `release-2:${idempotencyKey}`),
  );
});
