import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier, TenantRole } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import { withTransaction } from "../src/lib/transaction.js";
import { Tenant } from "../src/models/index.js";
import {
  creditWalletForTest,
  rebuildWalletProjection,
  releaseReservation,
  reserveWalletQuantity,
  reverseJournalEntry,
} from "../src/services/digital-metals-ledger.service.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { publishDefaultAssetSettings, platformApproveTaxAndTerms } from "./helpers/digital-metals-live-ready.js";
import { createId } from "../src/lib/ids.js";
import { signAccessToken } from "../src/services/token.service.js";
import { Session } from "../src/models/index.js";

const app = createApp();
const G4 = 4 * UG_PER_G;
const G5 = 5 * UG_PER_G;

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

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

async function customerToken({ tenant, branch, customer }) {
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "cust",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "cust",
    securityVersion: 0,
    sessionId: session._id,
  });
}

test("sale versus redemption reservation race: only one 4g hold from 5g", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction(async (session) => {
    await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G5,
      idempotencyKey: "race-seed",
    });
  });
  const run = (purpose, key) =>
    withTransaction((session) =>
      reserveWalletQuantity(session, {
        tenantId: tenant._id,
        customerId: customer._id,
        metal: "GOLD",
        finenessPpm: 999_000,
        quantityUg: G4,
        purpose,
        idempotencyKey: key,
      }),
    );
  const [a, b] = await Promise.allSettled([run("SELL", "sell-race"), run("REDEMPTION", "red-race")]);
  const ok = [a, b].filter((r) => r.status === "fulfilled").length;
  assert.equal(ok, 1);
});

test("concurrent 4g reservations from 5g balance: only one succeeds", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction(async (session) => {
    await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G5,
      idempotencyKey: "seed-5g",
    });
  });
  const run = (key) =>
    withTransaction((session) =>
      reserveWalletQuantity(session, {
        tenantId: tenant._id,
        customerId: customer._id,
        metal: "GOLD",
        finenessPpm: 999_000,
        quantityUg: G4,
        purpose: "SELL",
        idempotencyKey: key,
      }),
    );
  const [a, b] = await Promise.allSettled([run("r1"), run("r2")]);
  const ok = [a, b].filter((r) => r.status === "fulfilled").length;
  const fail = [a, b].filter((r) => r.status === "rejected").length;
  assert.equal(ok, 1);
  assert.equal(fail, 1);
});

test("duplicate reserve/commit/release is idempotent", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction(async (session) => {
    await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G4,
      idempotencyKey: "dup-seed",
    });
    const first = await reserveWalletQuantity(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G4,
      purpose: "SELL",
      idempotencyKey: "dup-res",
    });
    const second = await reserveWalletQuantity(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G4,
      purpose: "SELL",
      idempotencyKey: "dup-res",
    });
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    await releaseReservation(session, tenant._id, "dup-res", "rel-1");
    await releaseReservation(session, tenant._id, "dup-res", "rel-1");
  });
});

test("FIFO holding-period boundary blocks ineligible lot", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const oldDate = new Date(Date.now() - 10 * 86_400_000);
  await withTransaction(async (session) => {
    const { journalId } = await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G4,
      idempotencyKey: "lot-old",
    });
    const { DigitalMetalLot } = await import("../src/models/index.js");
    await DigitalMetalLot.updateOne(
      { sourceJournalId: journalId },
      { $set: { acquiredAt: oldDate } },
      { session },
    );
    await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G4,
      idempotencyKey: "lot-new",
    });
    await assert.rejects(
      () =>
        reserveWalletQuantity(session, {
          tenantId: tenant._id,
          customerId: customer._id,
          metal: "GOLD",
          finenessPpm: 999_000,
          quantityUg: G5,
          purpose: "SELL",
          idempotencyKey: "fifo-res",
          holdingPeriodDays: 7,
        }),
      (err) => err.code === "INSUFFICIENT_AVAILABLE_UG",
    );
    await reserveWalletQuantity(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G4,
      purpose: "SELL",
      idempotencyKey: "fifo-partial",
      holdingPeriodDays: 7,
    });
  });
});

test("projection rebuild conflicts with concurrent posting", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  let walletId;
  await withTransaction(async (session) => {
    const credited = await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: UG_PER_G,
      idempotencyKey: "proj-seed",
    });
    walletId = credited.walletId;
  });
  const { DigitalMetalWallet } = await import("../src/models/index.js");
  const wallet = await DigitalMetalWallet.findById(walletId).lean();
  await withTransaction(async (session) => {
    await assert.rejects(
      () => rebuildWalletProjection(session, walletId, { expectedProjectionVersion: wallet.projectionVersion - 1 }),
      (err) => err.code === "PROJECTION_CONFLICT",
    );
  });
});

test("customer portfolio and passbook API envelopes", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction(async (session) => {
    await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: UG_PER_G,
      idempotencyKey: "api-seed",
    });
  });
  const token = await customerToken({ tenant, branch, customer });
  const portfolio = await request(app)
    .get("/api/v1/app/digital-metals/portfolio")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(portfolio.status, 200);
  assert.ok(Array.isArray(portfolio.body.data.items));
  assert.equal(portfolio.body.data.items[0].availableUg, String(UG_PER_G));
  const passbook = await request(app)
    .get("/api/v1/app/digital-metals/passbook")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(passbook.status, 200);
  assert.ok(Array.isArray(passbook.body.data.items));
  assert.ok(passbook.body.data.meta);

  const adminToken = bearerFor(user);
  const adminWallets = await request(app)
    .get(`/api/v1/admin/digital-metals/customers/${customer._id}/wallets`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(adminWallets.status, 200);
  assert.equal(adminWallets.body.data.items.length, 1);
});

test("tax approval invalidates when settings tax lines change", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const token = bearerFor(user);
  await publishDefaultAssetSettings(app, token);
  await platformApproveTaxAndTerms(app, tenant._id);
  await request(app)
    .patch("/api/v1/admin/digital-metals/settings")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      expectedVersion: 1,
      metal: "GOLD",
      finenessPpm: 999_000,
      taxLines: [{ code: "GST", ratePercent: 3 }],
    });
  const cap = await request(app)
    .get("/api/v1/admin/digital-metals/capability")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(cap.status, 200);
  assert.equal(cap.body.data.taxProfileApproved, false);
  const quote = await request(app)
    .post("/api/v1/admin/digital-metals/quotes/preview")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      side: "BUY",
      metal: "GOLD",
      finenessPpm: 999_000,
      inputMode: "BUDGET_INR",
      budgetPaise: 600_000,
    });
  assert.equal(quote.status, 422);
});

test("compensating reversal after credit", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction(async (session) => {
    const { journalId } = await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: UG_PER_G,
      idempotencyKey: "rev-seed",
    });
    await reverseJournalEntry(session, tenant._id, journalId, "rev-1");
    await reverseJournalEntry(session, tenant._id, journalId, "rev-1");
  });
});

test("branch manager cannot read customer wallet outside branch", async () => {
  const { tenant, user } = await seedTenantUser({
    tenantCode: "DM_BR_SCOPE",
    role: TenantRole.BRANCH_MANAGER,
  });
  await enablePlan(tenant._id);
  const { seedBranch } = await import("./helpers/db.js");
  const otherBranch = await seedBranch({ tenantId: tenant._id, code: "BR2", name: "Other Branch" });
  const customerOther = await seedCustomer({ tenantId: tenant._id, branchId: otherBranch._id });
  await withTransaction(async (session) => {
    await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customerOther._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: UG_PER_G,
      idempotencyKey: "branch-seed",
    });
  });
  const token = bearerFor(user);
  const res = await request(app)
    .get(`/api/v1/admin/digital-metals/customers/${customerOther._id}/wallets`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 403);
});

test("cross-tenant customer passbook is empty/forbidden", async () => {
  const a = await seedTenantUser({ tenantCode: "DM_ISO_A" });
  const b = await seedTenantUser({ tenantCode: "DM_ISO_B" });
  await enablePlan(a.tenant._id);
  const customerA = await seedCustomer({ tenantId: a.tenant._id, branchId: a.branch._id });
  const tokenB = await customerToken({ tenant: b.tenant, branch: b.branch, customer: await seedCustomer({ tenantId: b.tenant._id, branchId: b.branch._id }) });
  const adminA = bearerFor(a.user);
  await withTransaction(async (session) => {
    await creditWalletForTest(session, {
      tenantId: a.tenant._id,
      customerId: customerA._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: UG_PER_G,
      idempotencyKey: "iso-seed",
    });
  });
  const leak = await request(app)
    .get(`/api/v1/admin/digital-metals/customers/${customerA._id}/wallets`)
    .set("Authorization", `Bearer ${tokenB}`);
  assert.ok(leak.status === 403 || leak.status === 404);
  const ok = await request(app)
    .get(`/api/v1/admin/digital-metals/customers/${customerA._id}/wallets`)
    .set("Authorization", `Bearer ${adminA}`);
  assert.equal(ok.status, 200);
});

test("creditWalletForTest rejected outside test mode", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      () =>
        withTransaction((session) =>
          creditWalletForTest(session, {
            tenantId: "tnt_x",
            customerId: "cus_x",
            metal: "GOLD",
            finenessPpm: 999_000,
            quantityUg: 1,
            idempotencyKey: "prod-block",
          }),
        ),
      (err) => err.code === "FORBIDDEN",
    );
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("purity separation: gold wallet does not satisfy silver reserve", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await withTransaction(async (session) => {
    await creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: G5,
      idempotencyKey: "gold-only",
    });
    await assert.rejects(
      () =>
        reserveWalletQuantity(session, {
          tenantId: tenant._id,
          customerId: customer._id,
          metal: "SILVER",
          finenessPpm: 999_000,
          quantityUg: UG_PER_G,
          purpose: "SELL",
          idempotencyKey: "silver-res",
        }),
      (err) => err.code === "INSUFFICIENT_AVAILABLE_UG",
    );
  });
});
