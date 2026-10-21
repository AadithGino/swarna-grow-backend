/**
 * Phase 9 API smoke (supertest + in-memory Mongo). Not a browser run.
 * Run: NODE_ENV=test node --import ./tests/global-test-db-serial.js scripts/digital-metals-phase9-api-smoke.js
 */
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import request from "supertest";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import { DigitalMetalProcurementEntry, Tenant } from "../src/models/index.js";
import { runDigitalMetalOutboxDispatch } from "../src/services/digital-metals-outbox-dispatch.service.js";
import { resetTestDb, seedFixture, startTestDb, stopTestDb } from "../tests/helpers/db.js";

const app = createApp();
const results = [];

function pass(label) {
  results.push({ label, ok: true });
}
function fail(label, err) {
  results.push({ label, ok: false, err: String(err?.message ?? err) });
}

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

async function customerBearer(fixture) {
  const { signAccessToken } = await import("../src/services/token.service.js");
  const { createId } = await import("../src/lib/ids.js");
  const { Session } = await import("../src/models/index.js");
  const session = await Session.create({
    _id: createId("session"),
    customerId: fixture.customer._id,
    tenantId: fixture.tenant._id,
    deviceId: "c",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return `Bearer ${signAccessToken({
    id: fixture.customer._id,
    type: "CUSTOMER",
    tenantId: fixture.tenant._id,
    branchId: fixture.branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "c",
    securityVersion: 0,
    sessionId: session._id,
  })}`;
}

async function approverFor(tenantId, branchId, creatorId) {
  const { User, Session } = await import("../src/models/index.js");
  const { createId } = await import("../src/lib/ids.js");
  const { TenantRole, UserType, UserStatus } = await import("../src/constants/enums.js");
  const { ROLE_PERMISSIONS } = await import("../src/constants/permissions.js");
  const argon2 = await import("argon2");
  const approver = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId,
    branchId,
    name: "Approver",
    mobile: `+9197777${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`,
    role: TenantRole.TENANT_ADMIN,
    permissions: ROLE_PERMISSIONS[TenantRole.TENANT_ADMIN] ?? [],
    status: UserStatus.ACTIVE,
    passwordHash: await argon2.hash("1234", { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: approver._id,
    tenantId,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  approver.$locals = { testSessionId: session._id };
  const { bearerFor } = await import("../tests/helpers/db.js");
  assert.notEqual(approver._id, creatorId);
  return bearerFor(approver);
}

await startTestDb();
try {
  await resetTestDb();
  const fixture = await seedFixture({});
  await enablePlan(fixture.tenant._id);
  const auth = (token) => (token.startsWith("Bearer ") ? token : `Bearer ${token}`);
  const makerToken = auth(fixture.token);
  const approverToken = auth(await approverFor(fixture.tenant._id, fixture.branch._id, fixture.user._id));

  try {
    const commitment = await request(app)
      .post("/api/v1/admin/digital-metals/procurement/entries")
      .set("Authorization", makerToken)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        entryType: "COMMITMENT",
        metal: "GOLD",
        finenessPpm: 916000,
        quantityUg: 3_000_000,
        effectiveDate: "2026-10-18",
        evidenceUploadIds: ["upl_evidence"],
      });
    assert.ok([200, 201].includes(commitment.status));
    const commitmentId = commitment.body.data.id;
    const approveCommit = await request(app)
      .post(`/api/v1/admin/digital-metals/procurement/entries/${commitmentId}/approve`)
      .set("Authorization", approverToken)
      .set("X-Idempotency-Key", randomUUID());
    assert.equal(approveCommit.status, 200);

    const receipt = await request(app)
      .post("/api/v1/admin/digital-metals/procurement/entries")
      .set("Authorization", makerToken)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        entryType: "RECEIPT",
        metal: "GOLD",
        finenessPpm: 916000,
        quantityUg: 1_000_000,
        effectiveDate: "2026-10-18",
        commitmentEntryId: commitmentId,
      });
    assert.ok([200, 201].includes(receipt.status));
    await request(app)
      .post(`/api/v1/admin/digital-metals/procurement/entries/${receipt.body.data.id}/approve`)
      .set("Authorization", approverToken)
      .set("X-Idempotency-Key", randomUUID());

    const detail = await request(app)
      .get(`/api/v1/admin/digital-metals/procurement/entries/${commitmentId}`)
      .set("Authorization", makerToken);
    assert.equal(detail.body.data.remainingCommitmentUg, "2000000");

    const reversal = await request(app)
      .post("/api/v1/admin/digital-metals/procurement/entries")
      .set("Authorization", makerToken)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        entryType: "REVERSAL",
        metal: "GOLD",
        finenessPpm: 916000,
        quantityUg: 500_000,
        effectiveDate: "2026-10-18",
        reversesEntryId: receipt.body.data.id,
        evidenceUploadIds: ["upl_evidence"],
      });
    await request(app)
      .post(`/api/v1/admin/digital-metals/procurement/entries/${reversal.body.data.id}/approve`)
      .set("Authorization", approverToken)
      .set("X-Idempotency-Key", randomUUID());

    pass("procurement commitment → approve → partial receipt → remaining → reversal");
  } catch (err) {
    fail("procurement flow", err);
  }

  try {
    const customerToken = await customerBearer(fixture);
    const queued = await request(app)
      .post("/api/v1/app/digital-metals/documents/request")
      .set("Authorization", customerToken)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        docType: "METAL_STATEMENT",
        fromBusinessDate: "2026-10-01",
        toBusinessDate: "2026-10-18",
      });
    assert.ok([200, 202].includes(queued.status));
    assert.equal(queued.body.data.status, "PENDING");
    await runDigitalMetalOutboxDispatch();
    await runDigitalMetalOutboxDispatch();
    const ready = await request(app)
      .get(`/api/v1/app/digital-metals/documents/${queued.body.data.id}`)
      .set("Authorization", customerToken);
    assert.equal(ready.body.data.status, "READY");
    const dl = await request(app)
      .get(`/api/v1/app/digital-metals/documents/${queued.body.data.id}/download-url`)
      .set("Authorization", customerToken);
    assert.equal(dl.status, 200);
    pass("customer statement request → ready → download-url");
  } catch (err) {
    fail("customer statement documents", err);
  }

  try {
    await DigitalMetalProcurementEntry.create({
      _id: "dmpce_open_smoke",
      tenantId: fixture.tenant._id,
      entryType: "OPENING_POSITION",
      status: "APPROVED",
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: 1_000_000,
      obligationQuantityUg: 1_000_000,
      effectiveDate: "2020-01-01",
      evidenceUploadIds: ["upl1"],
      createdByUserId: fixture.user._id,
      approvedByUserId: fixture.user._id,
      idempotencyKey: randomUUID(),
    });
    const d1 = "2026-10-16";
    const d2 = "2026-10-17";
    assert.equal(
      (
        await request(app)
          .post("/api/v1/admin/digital-metals/hedge/snapshots/close-day")
          .set("Authorization", approverToken)
          .set("X-Idempotency-Key", randomUUID())
          .send({ businessDate: d1 })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/v1/admin/digital-metals/hedge/snapshots/close-day")
          .set("Authorization", approverToken)
          .set("X-Idempotency-Key", randomUUID())
          .send({ businessDate: d2 })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/v1/admin/digital-metals/hedge/snapshots/close-day")
          .set("Authorization", approverToken)
          .set("X-Idempotency-Key", randomUUID())
          .send({ businessDate: d1, revisionReason: "Revision smoke" })
      ).status,
      200,
    );
    const live = await request(app)
      .get("/api/v1/admin/digital-metals/hedge/live")
      .set("Authorization", approverToken);
    assert.equal(live.status, 200);
    assert.equal(live.body.data.recomputationRequired, true);
    const invalidated = await request(app)
      .get("/api/v1/admin/digital-metals/hedge/snapshots-invalidated")
      .set("Authorization", approverToken);
    assert.ok(invalidated.body.data.items.length >= 1);
    for (const row of invalidated.body.data.items) {
      assert.equal(
        (
          await request(app)
            .post("/api/v1/admin/digital-metals/hedge/snapshots/close-day")
            .set("Authorization", approverToken)
            .set("X-Idempotency-Key", randomUUID())
            .send({ businessDate: row.businessDate, revisionReason: "Re-close invalidated day" })
        ).status,
        200,
      );
    }
    const live2 = await request(app)
      .get("/api/v1/admin/digital-metals/hedge/live")
      .set("Authorization", approverToken);
    const invalidated2 = await request(app)
      .get("/api/v1/admin/digital-metals/hedge/snapshots-invalidated")
      .set("Authorization", approverToken);
    assert.equal(live2.body.data.recomputationRequired, false);
    assert.equal(invalidated2.body.data.items.length, 0);
    pass("hedge revision → invalidation → re-close clears recomputation flag");
  } catch (err) {
    fail("hedge invalidation smoke", err);
  }

  try {
    await Tenant.updateOne(
      { _id: fixture.tenant._id },
      { $set: { "operations.digitalMetalsPaused": true } },
    );
    const customerToken = await customerBearer(fixture);
    const cap = await request(app)
      .get("/api/v1/app/digital-metals/capability")
      .set("Authorization", customerToken);
    assert.equal(cap.body.data.canPlaceNewBuy, false);
    assert.equal(cap.body.data.canViewHoldings, true);
    pass("paused trading blocks new buy but keeps holdings access");
  } catch (err) {
    fail("disabled trading capability", err);
  }
} finally {
  await stopTestDb();
}

const failed = results.filter((r) => !r.ok);
for (const row of results) {
  process.stdout.write(`${row.ok ? "PASS" : "FAIL"} ${row.label}${row.err ? `: ${row.err}` : ""}\n`);
}
if (failed.length) process.exit(1);
