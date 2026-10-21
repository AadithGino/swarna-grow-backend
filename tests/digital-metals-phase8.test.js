import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import { setCalendarDateOverrideForTests, resetCalendarDateOverrideForTests, today } from "../src/lib/date.js";
import { computeClosingPerimeter } from "../src/lib/digital-metals-hedge-perimeter.js";
import { DigitalMetalHedgeSnapshot, Tenant } from "../src/models/index.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { makeTenantQuoteReady } from "./helpers/digital-metals-live-ready.js";
import { withTransaction } from "../src/lib/transaction.js";
import { creditWalletForTest } from "../src/services/digital-metals-ledger.service.js";

const app = createApp();
const G1 = UG_PER_G;
const G3 = 3 * UG_PER_G;

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  resetCalendarDateOverrideForTests();
  process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
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

test("perimeter math: open 0, buy 3g, sell 1g, handover 1g, procure 2g => obligation 1g hedge 1g", () => {
  const r = computeClosingPerimeter({
    openingObligationUg: 0,
    openingHedgePositionUg: 0,
    completedBuyUg: G3,
    executedSellUg: G1,
    physicalHandoverUg: G1,
    procurementReceiptUg: G1 + G1,
    supplierDisposalUg: 0,
  });
  assert.equal(r.closingObligationUg, G1);
  assert.equal(r.closingHedgePositionUg, G1);
  assert.equal(r.uncoveredUg, 0);
});

test("missing opening position marks coverageIncomplete on live hedge report", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
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
  const adminToken = bearerFor(user);
  const live = await request(app)
    .get("/api/v1/admin/digital-metals/hedge/live")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(live.status, 200);
  const line = live.body.data.lines.find((l) => l.metal === "GOLD");
  assert.ok(line);
  assert.equal(line.coverageIncomplete, true);
});

test("procurement opening approve + close-day snapshot (mocked Mongo)", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const adminToken = bearerFor(user);
  const businessDate = today();
  setCalendarDateOverrideForTests(businessDate);
  const openingDate = "2020-01-01";

  const opening = await request(app)
    .post("/api/v1/admin/digital-metals/procurement/entries")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      entryType: "OPENING_POSITION",
      metal: "GOLD",
      finenessPpm: 999000,
      quantityUg: G1,
      obligationQuantityUg: G1,
      effectiveDate: openingDate,
      evidenceUploadIds: ["upl_open"],
      reasonNote: "Go-live",
    });
  assert.ok([200, 201].includes(opening.status));
  const entryId = opening.body.data.id;
  const approve = await request(app)
    .post(`/api/v1/admin/digital-metals/procurement/entries/${entryId}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID());
  assert.equal(approve.status, 403);

  const { User, Branch } = await import("../src/models/index.js");
  const { createId } = await import("../src/lib/ids.js");
  const { TenantRole, UserType, UserStatus } = await import("../src/constants/enums.js");
  const { ROLE_PERMISSIONS } = await import("../src/constants/permissions.js");
  const argon2 = await import("argon2");
  const branch = await Branch.findOne({ tenantId: tenant._id }).lean();
  const approverUser = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    name: "Approver",
    mobile: "+919777766655",
    role: TenantRole.TENANT_ADMIN,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_ADMIN] ?? [],
    status: UserStatus.ACTIVE,
    passwordHash: await argon2.hash("1234", { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
  });
  const { Session } = await import("../src/models/index.js");
  const session = await Session.create({
    _id: createId("session"),
    userId: approverUser._id,
    tenantId: tenant._id,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  approverUser.$locals = { testSessionId: session._id };
  const approverToken = bearerFor(approverUser);
  const ok = await request(app)
    .post(`/api/v1/admin/digital-metals/procurement/entries/${entryId}/approve`)
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID());
  assert.equal(ok.status, 200);

  const close = await request(app)
    .post("/api/v1/admin/digital-metals/hedge/snapshots/close-day")
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ businessDate });
  assert.equal(close.status, 200);
  const snap = await DigitalMetalHedgeSnapshot.findOne({ tenantId: tenant._id, businessDate }).lean();
  assert.ok(snap);
  assert.equal(snap.coverageIncomplete, false);
});

test("customer buy without procurement stock gate remains allowed", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await enablePlan(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(user));
  const tokenRes = await request(app)
    .post("/api/v1/app/digital-metals/quotes/buy")
    .set("Authorization", `Bearer ${await (async () => {
      const { signAccessToken } = await import("../src/services/token.service.js");
      const { createId } = await import("../src/lib/ids.js");
      const { Session } = await import("../src/models/index.js");
      const session = await Session.create({
        _id: createId("session"),
        customerId: customer._id,
        tenantId: tenant._id,
        deviceId: "c",
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
        deviceId: "c",
        securityVersion: 0,
        sessionId: session._id,
      });
    })()}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ inputMode: "QUANTITY_UG", metal: "GOLD", finenessPpm: 999000, quantityUg: G1 });
  assert.equal(tokenRes.status, 201);
});
