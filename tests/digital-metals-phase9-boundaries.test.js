import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import { DigitalMetalHedgeSnapshot, DigitalMetalProcurementEntry, Tenant } from "../src/models/index.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

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

async function approverTokenFor(tenantId, branchId) {
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
    mobile: `+9198888${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`,
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

test("revision invalidates downstream snapshots and allows source reuse (mocked Mongo)", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const token = await approverTokenFor(tenant._id, branch._id);

  await DigitalMetalProcurementEntry.create({
    _id: "dmpce_open_p9",
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

  const d1 = "2026-10-16";
  const d2 = "2026-10-17";
  assert.equal((await request(app).post("/api/v1/admin/digital-metals/hedge/snapshots/close-day").set("Authorization", `Bearer ${token}`).set("X-Idempotency-Key", randomUUID()).send({ businessDate: d1 })).status, 200);
  assert.equal((await request(app).post("/api/v1/admin/digital-metals/hedge/snapshots/close-day").set("Authorization", `Bearer ${token}`).set("X-Idempotency-Key", randomUUID()).send({ businessDate: d2 })).status, 200);

  const snap2 = await DigitalMetalHedgeSnapshot.findOne({ tenantId: tenant._id, businessDate: d2, status: "CLOSED" }).lean();
  assert.ok(snap2);

  const revise = await request(app)
    .post("/api/v1/admin/digital-metals/hedge/snapshots/close-day")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ businessDate: d1, revisionReason: "Backdated correction" });
  assert.equal(revise.status, 200);

  const invalidated = await DigitalMetalHedgeSnapshot.findOne({ _id: snap2._id }).lean();
  assert.equal(invalidated.status, "INVALIDATED");
  assert.ok(invalidated.invalidatedAt);

  const live = await request(app)
    .get("/api/v1/admin/digital-metals/hedge/live")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(live.status, 200);
  assert.equal(live.body.data.recomputationRequired, true);

  const priorBaseline = await DigitalMetalHedgeSnapshot.findOne({
    tenantId: tenant._id,
    businessDate: d2,
    status: "CLOSED",
  }).lean();
  assert.equal(priorBaseline, null);

  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/digital-metals/hedge/snapshots/close-day")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Idempotency-Key", randomUUID())
        .send({ businessDate: d2, revisionReason: "Re-close after invalidation" })
    ).status,
    200,
  );

  const liveAfter = await request(app)
    .get("/api/v1/admin/digital-metals/hedge/live")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(liveAfter.body.data.recomputationRequired, false);

  const invalidatedList = await request(app)
    .get("/api/v1/admin/digital-metals/hedge/snapshots-invalidated")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(invalidatedList.body.data.items.length, 0);
});

test("statement PDF is available via durable artifact pipeline (mocked Mongo)", async () => {
  const { randomUUID } = await import("node:crypto");
  const { runDigitalMetalOutboxDispatch } = await import(
    "../src/services/digital-metals-outbox-dispatch.service.js"
  );
  const { tenant, branch } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await import("./helpers/db.js").then((h) =>
    h.seedCustomer({ tenantId: tenant._id, branchId: branch._id }),
  );
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
  const customerToken = signAccessToken({
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

  const queued = await request(app)
    .post("/api/v1/app/digital-metals/documents/request")
    .set("Authorization", `Bearer ${customerToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      docType: "METAL_STATEMENT",
      fromBusinessDate: "2026-10-01",
      toBusinessDate: "2026-10-18",
    });
  assert.ok([200, 202].includes(queued.status));
  await runDigitalMetalOutboxDispatch();

  const download = await request(app)
    .get(`/api/v1/app/digital-metals/documents/${queued.body.data.id}/download-url`)
    .set("Authorization", `Bearer ${customerToken}`);
  assert.equal(download.status, 200);
  assert.ok(download.body.data.downloadUrl);
  assert.match(download.body.data.contentType ?? "", /pdf/);
});
