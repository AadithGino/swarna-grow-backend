import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import { istBusinessDateFromInstant } from "../src/lib/digital-metals-business-calendar.js";
import { setCalendarDateOverrideForTests, resetCalendarDateOverrideForTests } from "../src/lib/date.js";
import {
  DigitalMetalBuyOrder,
  DigitalMetalPhysicalOutEvent,
  DigitalMetalProcurementEntry,
  Tenant,
} from "../src/models/index.js";
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

const app = createApp();
const G1 = UG_PER_G;

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

async function seedApprover(tenantId, branchId) {
  const { User, Session } = await import("../src/models/index.js");
  const { createId } = await import("../src/lib/ids.js");
  const { TenantRole, UserType, UserStatus } = await import("../src/constants/enums.js");
  const { ROLE_PERMISSIONS } = await import("../src/constants/permissions.js");
  const argon2 = await import("argon2");
  const approverUser = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId,
    branchId,
    name: "Approver",
    mobile: "+919777766655",
    role: TenantRole.TENANT_ADMIN,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_ADMIN] ?? [],
    status: UserStatus.ACTIVE,
    passwordHash: await argon2.hash("1234", { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: approverUser._id,
    tenantId,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  approverUser.$locals = { testSessionId: session._id };
  return bearerFor(approverUser);
}

test("IST businessDate: Oct 18 report includes handover keyed to Oct 18 (mocked Mongo)", async () => {
  const reportDate = "2026-10-18";
  setCalendarDateOverrideForTests(reportDate);
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const { Branch } = await import("../src/models/index.js");
  const branch = await Branch.findOne({ tenantId: tenant._id }).lean();
  const approverToken = await seedApprover(tenant._id, branch._id);

  await DigitalMetalProcurementEntry.create({
    _id: "dmpce_open",
    tenantId: tenant._id,
    entryType: "OPENING_POSITION",
    status: "APPROVED",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: G1,
    obligationQuantityUg: G1,
    effectiveDate: "2020-01-01",
    evidenceUploadIds: ["u"],
    createdByUserId: user._id,
    approvedByUserId: user._id,
    idempotencyKey: randomUUID(),
  });

  await DigitalMetalPhysicalOutEvent.create({
    _id: "dmphy_1",
    tenantId: tenant._id,
    redemptionOrderId: "dmro_1",
    customerId: "cus_1",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: G1,
    reservationId: "dmrsv_1",
    businessDate: reportDate,
    fulfilmentMode: "PICKUP",
    idempotencyKey: randomUUID(),
  });

  const live = await request(app)
    .get(`/api/v1/admin/digital-metals/hedge/live?businessDate=${reportDate}`)
    .set("Authorization", `Bearer ${approverToken}`);
  assert.equal(live.status, 200);
  const line = live.body.data.lines.find((l) => l.metal === "GOLD");
  assert.equal(line.movements.physicalHandoverUg, String(G1));
});

test("earlier credited buy retained across gap days without snapshots (mocked Mongo)", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const { Branch } = await import("../src/models/index.js");
  const branch = await Branch.findOne({ tenantId: tenant._id }).lean();
  const approverToken = await seedApprover(tenant._id, branch._id);

  await DigitalMetalProcurementEntry.create({
    _id: "dmpce_open2",
    tenantId: tenant._id,
    entryType: "OPENING_POSITION",
    status: "APPROVED",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: G1,
    obligationQuantityUg: 0,
    effectiveDate: "2020-01-01",
    evidenceUploadIds: ["u"],
    createdByUserId: user._id,
    approvedByUserId: user._id,
    idempotencyKey: randomUUID(),
  });

  const buyDay = new Date("2026-10-10T10:00:00.000+05:30");
  await DigitalMetalBuyOrder.create({
    _id: "dmbo_gap",
    tenantId: tenant._id,
    customerId: "cus_x",
    quoteId: "q1",
    status: "CREDITED",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: G1,
    totalPayablePaise: 100,
    quoteExpiresAt: buyDay,
    paymentAcceptanceExpiresAt: buyDay,
    creditedAt: buyDay,
    termsAcceptedAt: buyDay,
    termsVersion: "v1",
    termsContentHash: "hash",
    idempotencyKey: randomUUID(),
  });

  const reportDate = "2026-10-18";
  const live = await request(app)
    .get(`/api/v1/admin/digital-metals/hedge/live?businessDate=${reportDate}`)
    .set("Authorization", `Bearer ${approverToken}`);
  assert.equal(live.status, 200);
  const line = live.body.data.lines.find((l) => l.metal === "GOLD");
  assert.equal(line.movements.completedBuyUg, String(G1));
});

test("concurrent receipt approvals cannot exceed commitment (replica-set Mongo)", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const makerToken = bearerFor(user);
  const approverToken = await seedApprover(tenant._id, branch._id);

  const commitment = await request(app)
    .post("/api/v1/admin/digital-metals/procurement/entries")
    .set("Authorization", `Bearer ${makerToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      entryType: "COMMITMENT",
      metal: "GOLD",
      finenessPpm: 999000,
      quantityUg: G1,
      effectiveDate: "2026-10-18",
    });
  assert.ok([200, 201].includes(commitment.status));
  const cid = commitment.body.data.id;
  await request(app)
    .post(`/api/v1/admin/digital-metals/procurement/entries/${cid}/approve`)
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID());

  const half = Math.floor(G1 / 2);
  const r1 = await request(app)
    .post("/api/v1/admin/digital-metals/procurement/entries")
    .set("Authorization", `Bearer ${makerToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      entryType: "RECEIPT",
      metal: "GOLD",
      finenessPpm: 999000,
      quantityUg: half,
      commitmentEntryId: cid,
      effectiveDate: "2026-10-18",
    });
  const r2 = await request(app)
    .post("/api/v1/admin/digital-metals/procurement/entries")
    .set("Authorization", `Bearer ${makerToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      entryType: "RECEIPT",
      metal: "GOLD",
      finenessPpm: 999000,
      quantityUg: half + 1,
      commitmentEntryId: cid,
      effectiveDate: "2026-10-18",
    });
  const [a1, a2] = await Promise.all([
    request(app)
      .post(`/api/v1/admin/digital-metals/procurement/entries/${r1.body.data.id}/approve`)
      .set("Authorization", `Bearer ${approverToken}`)
      .set("X-Idempotency-Key", randomUUID()),
    request(app)
      .post(`/api/v1/admin/digital-metals/procurement/entries/${r2.body.data.id}/approve`)
      .set("Authorization", `Bearer ${approverToken}`)
      .set("X-Idempotency-Key", randomUUID()),
  ]);
  assert.ok([a1.status, a2.status].includes(200));
  assert.ok([a1.status, a2.status].includes(409));
});

test("wrong-purity commitment link rejected on receipt create (mocked Mongo)", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const makerToken = bearerFor(user);
  const approverToken = await seedApprover(tenant._id, branch._id);

  const commitment = await request(app)
    .post("/api/v1/admin/digital-metals/procurement/entries")
    .set("Authorization", `Bearer ${makerToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      entryType: "COMMITMENT",
      metal: "GOLD",
      finenessPpm: 999000,
      quantityUg: G1,
      effectiveDate: "2026-10-18",
    });
  const cid = commitment.body.data.id;
  await request(app)
    .post(`/api/v1/admin/digital-metals/procurement/entries/${cid}/approve`)
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID());

  const bad = await request(app)
    .post("/api/v1/admin/digital-metals/procurement/entries")
    .set("Authorization", `Bearer ${makerToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      entryType: "RECEIPT",
      metal: "GOLD",
      finenessPpm: 916000,
      quantityUg: G1,
      commitmentEntryId: cid,
      effectiveDate: "2026-10-18",
    });
  assert.equal(bad.status, 409);
});

test("duplicate close without revision returns 409 (mocked Mongo)", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const approverToken = await seedApprover(tenant._id, branch._id);
  const businessDate = "2026-10-18";

  await DigitalMetalProcurementEntry.create({
    _id: "dmpce_open3",
    tenantId: tenant._id,
    entryType: "OPENING_POSITION",
    status: "APPROVED",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: G1,
    obligationQuantityUg: G1,
    effectiveDate: "2020-01-01",
    evidenceUploadIds: ["u"],
    createdByUserId: user._id,
    approvedByUserId: user._id,
    idempotencyKey: randomUUID(),
  });

  const c1 = await request(app)
    .post("/api/v1/admin/digital-metals/hedge/snapshots/close-day")
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ businessDate });
  assert.equal(c1.status, 200);
  const c2 = await request(app)
    .post("/api/v1/admin/digital-metals/hedge/snapshots/close-day")
    .set("Authorization", `Bearer ${approverToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ businessDate });
  assert.equal(c2.status, 409);
});

test("historical wallet reconcile uses journals at asOf cutoff (mocked Mongo)", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const approverToken = await seedApprover(tenant._id, branch._id);

  await DigitalMetalProcurementEntry.create({
    _id: "dmpce_open4",
    tenantId: tenant._id,
    entryType: "OPENING_POSITION",
    status: "APPROVED",
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: G1,
    obligationQuantityUg: 0,
    effectiveDate: "2020-01-01",
    evidenceUploadIds: ["u"],
    createdByUserId: user._id,
    approvedByUserId: user._id,
    idempotencyKey: randomUUID(),
  });

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

  const { istBusinessDayBounds } = await import("../src/lib/digital-metals-business-calendar.js");
  const cutoffDate = "2026-10-15";
  const { end: cutoffEnd } = istBusinessDayBounds(cutoffDate);
  await mongoose.connection.collection("digitalmetaljournals").updateMany(
    { tenantId: tenant._id },
    { $set: { createdAt: new Date("2026-10-14T18:30:00.000Z") } },
  );

  const livePast = await request(app)
    .get(
      `/api/v1/admin/digital-metals/hedge/live?businessDate=${cutoffDate}&asOf=${encodeURIComponent(cutoffEnd.toISOString())}`,
    )
    .set("Authorization", `Bearer ${approverToken}`);
  assert.equal(livePast.status, 200);
  const linePast = livePast.body.data.lines.find((l) => l.metal === "GOLD");
  assert.equal(linePast.walletHeldUg, String(G1));

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

  const liveHistorical = await request(app)
    .get(
      `/api/v1/admin/digital-metals/hedge/live?businessDate=${cutoffDate}&asOf=${encodeURIComponent(cutoffEnd.toISOString())}`,
    )
    .set("Authorization", `Bearer ${approverToken}`);
  const lineHist = liveHistorical.body.data.lines.find((l) => l.metal === "GOLD");
  assert.equal(lineHist.walletHeldUg, String(G1));
});

test("istBusinessDateFromInstant differs from UTC slice near midnight IST", () => {
  const instant = new Date("2026-10-17T20:30:00.000Z");
  assert.equal(istBusinessDateFromInstant(instant), "2026-10-18");
  assert.equal(instant.toISOString().slice(0, 10), "2026-10-17");
});
