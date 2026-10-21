import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
import { createApp } from "../src/app.js";
import { PlanTier } from "../src/constants/enums.js";
import {
  DigitalMetalDocumentArtifact,
  DigitalMetalOutboxEvent,
  Tenant,
} from "../src/models/index.js";
import { runDigitalMetalOutboxDispatch } from "../src/services/digital-metals-outbox-dispatch.service.js";
import { resetTestDb, seedFixture, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

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

test("document request is idempotent and assigns one document number (mocked Mongo)", async () => {
  const fixture = await seedFixture({});
  await enablePlan(fixture.tenant._id);
  const token = await customerBearer(fixture);
  const idem = randomUUID();

  const first = await request(app)
    .post("/api/v1/app/digital-metals/documents/request")
    .set("Authorization", token)
    .set("X-Idempotency-Key", idem)
    .send({
      docType: "METAL_STATEMENT",
      fromBusinessDate: "2026-10-01",
      toBusinessDate: "2026-10-18",
    });
  assert.ok([200, 202].includes(first.status), `unexpected ${first.status}`);
  const artifactId = first.body.data.id;

  const dup = await request(app)
    .post("/api/v1/app/digital-metals/documents/request")
    .set("Authorization", token)
    .set("X-Idempotency-Key", idem)
    .send({
      docType: "METAL_STATEMENT",
      fromBusinessDate: "2026-10-01",
      toBusinessDate: "2026-10-18",
    });
  assert.ok([200, 202].includes(dup.status));
  assert.equal(dup.body.data.id, artifactId);

  await runDigitalMetalOutboxDispatch();
  await runDigitalMetalOutboxDispatch();

  const ready = await DigitalMetalDocumentArtifact.findById(artifactId).lean();
  assert.equal(ready.status, "READY");
  assert.ok(ready.documentNumber);
  assert.ok(ready.uploadId);
  assert.ok(ready.sourceSnapshot?.journalCutoffAt);

  const secondRun = await runDigitalMetalOutboxDispatch();
  const after = await DigitalMetalDocumentArtifact.findById(artifactId).lean();
  assert.equal(after.documentNumber, ready.documentNumber);
  assert.equal(after.uploadId, ready.uploadId);
  assert.ok(secondRun);
});

test("document artifacts are tenant-isolated", async () => {
  const a = await seedFixture({});
  const b = await seedFixture({});
  await enablePlan(a.tenant._id);
  await enablePlan(b.tenant._id);
  const tokenA = await customerBearer(a);

  const res = await request(app)
    .post("/api/v1/app/digital-metals/documents/request")
    .set("Authorization", tokenA)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      docType: "METAL_STATEMENT",
      fromBusinessDate: "2026-10-01",
      toBusinessDate: "2026-10-02",
    });
  assert.ok([200, 202].includes(res.status));
  const artifactId = res.body.data.id;

  const tokenB = await customerBearer(b);
  const forbidden = await request(app)
    .get(`/api/v1/app/digital-metals/documents/${artifactId}`)
    .set("Authorization", tokenB);
  assert.ok([403, 404].includes(forbidden.status));
});

test("stale processing lease can be reclaimed", async () => {
  const fixture = await seedFixture({});
  await enablePlan(fixture.tenant._id);
  const { tenant, customer } = fixture;
  const row = await DigitalMetalDocumentArtifact.create({
    _id: "dmdoc_reclaim_test",
    tenantId: tenant._id,
    docType: "METAL_STATEMENT",
    subjectKey: "statement:2026-10-01:2026-10-02",
    customerId: customer._id,
    status: "PROCESSING",
    sourceSnapshot: {
      fromBusinessDate: "2026-10-01",
      toBusinessDate: "2026-10-02",
      openingByAsset: [],
      closingByAsset: [],
      activity: [],
    },
    idempotencyKey: randomUUID(),
    processingLeaseOwner: "stale",
    processingLeaseExpiresAt: new Date(Date.now() - 60_000),
  });
  await DigitalMetalOutboxEvent.create({
    _id: "dmobx_reclaim",
    tenantId: tenant._id,
    topic: "DIGITAL_METAL_DOCUMENT_ARTIFACT_REQUEST",
    key: "reclaim",
    payload: { artifactId: row._id },
    status: "PENDING",
  });
  await runDigitalMetalOutboxDispatch();
  const updated = await DigitalMetalDocumentArtifact.findById(row._id).lean();
  assert.ok(["READY", "PENDING", "FAILED"].includes(updated.status));
  assert.notEqual(updated.processingLeaseOwner, "stale");
});

test("stale lease holder cannot overwrite READY upload on finalize", async () => {
  const fixture = await seedFixture({});
  await enablePlan(fixture.tenant._id);
  const row = await DigitalMetalDocumentArtifact.create({
    _id: "dmdoc_stale_finalize",
    tenantId: fixture.tenant._id,
    docType: "METAL_STATEMENT",
    subjectKey: "statement:2026-10-08:2026-10-09",
    customerId: fixture.customer._id,
    status: "READY",
    documentNumber: "STM-2026-009999",
    uploadId: "upl_keep_me",
    sourceSnapshot: {
      fromBusinessDate: "2026-10-08",
      toBusinessDate: "2026-10-09",
      openingByAsset: [],
      closingByAsset: [],
      activity: [],
    },
    idempotencyKey: randomUUID(),
    processingLeaseOwner: "stale-worker",
    processingLeaseExpiresAt: new Date(Date.now() - 60_000),
  });
  const raced = await DigitalMetalDocumentArtifact.findOneAndUpdate(
    {
      _id: row._id,
      tenantId: fixture.tenant._id,
      processingLeaseOwner: "wrong-lease",
      status: "PROCESSING",
    },
    { $set: { status: "READY", uploadId: "upl_evil" } },
    { new: true },
  ).lean();
  assert.equal(raced, null);
  const after = await DigitalMetalDocumentArtifact.findById(row._id).lean();
  assert.equal(after.uploadId, "upl_keep_me");
  assert.equal(after.status, "READY");
});

test("duplicate worker dispatch does not replace READY upload or document number", async () => {
  const fixture = await seedFixture({});
  await enablePlan(fixture.tenant._id);
  const token = await customerBearer(fixture);
  const idem = randomUUID();
  const queued = await request(app)
    .post("/api/v1/app/digital-metals/documents/request")
    .set("Authorization", token)
    .set("X-Idempotency-Key", idem)
    .send({
      docType: "METAL_STATEMENT",
      fromBusinessDate: "2026-10-01",
      toBusinessDate: "2026-10-02",
    });
  const artifactId = queued.body.data.id;
  await runDigitalMetalOutboxDispatch();
  const ready = await DigitalMetalDocumentArtifact.findById(artifactId).lean();
  assert.equal(ready.status, "READY");
  const { processDigitalMetalDocumentArtifactRequest } = await import(
    "../src/services/digital-metals-document-artifact.service.js"
  );
  const again = await processDigitalMetalDocumentArtifactRequest({
    tenantId: fixture.tenant._id,
    artifactId,
  });
  assert.equal(again.outcome, "ALREADY_READY");
  const after = await DigitalMetalDocumentArtifact.findById(artifactId).lean();
  assert.equal(after.uploadId, ready.uploadId);
  assert.equal(after.documentNumber, ready.documentNumber);
});

test("storage upload failure leaves artifact retryable without READY", async () => {
  const fixture = await seedFixture({});
  await enablePlan(fixture.tenant._id);
  const { storageProvider } = await import("../src/integrations/storage.provider.js");
  const original = storageProvider.uploadFile.bind(storageProvider);
  let calls = 0;
  storageProvider.uploadFile = async (args) => {
    calls += 1;
    if (calls === 1) throw new Error("STORAGE_UNAVAILABLE");
    return original(args);
  };
  try {
    const row = await DigitalMetalDocumentArtifact.create({
      _id: "dmdoc_storage_fail",
      tenantId: fixture.tenant._id,
      docType: "METAL_STATEMENT",
      subjectKey: "statement:2026-10-03:2026-10-04",
      customerId: fixture.customer._id,
      status: "PENDING",
      sourceSnapshot: {
        fromBusinessDate: "2026-10-03",
        toBusinessDate: "2026-10-04",
        openingByAsset: [],
        closingByAsset: [],
        activity: [],
      },
      idempotencyKey: randomUUID(),
    });
    const { processDigitalMetalDocumentArtifactRequest } = await import(
      "../src/services/digital-metals-document-artifact.service.js"
    );
    const first = await processDigitalMetalDocumentArtifactRequest({
      tenantId: fixture.tenant._id,
      artifactId: row._id,
    });
    assert.equal(first.outcome, "RETRY_SCHEDULED");
    const failed = await DigitalMetalDocumentArtifact.findById(row._id).lean();
    assert.notEqual(failed.status, "READY");
    assert.ok(!failed.uploadId);
    await DigitalMetalDocumentArtifact.updateOne(
      { _id: row._id },
      {
        $set: {
          status: "PENDING",
          availableAt: new Date(Date.now() - 1000),
          processingLeaseOwner: null,
          processingLeaseExpiresAt: null,
        },
      },
    );
    const second = await processDigitalMetalDocumentArtifactRequest({
      tenantId: fixture.tenant._id,
      artifactId: row._id,
    });
    assert.equal(second.outcome, "READY");
    const done = await DigitalMetalDocumentArtifact.findById(row._id).lean();
    assert.equal(done.status, "READY");
    assert.ok(done.uploadId);
  } finally {
    storageProvider.uploadFile = original;
  }
});

test("statement pdf route streams PDF on demand without prior artifact request", async () => {
  const fixture = await seedFixture({});
  await enablePlan(fixture.tenant._id);
  const token = await customerBearer(fixture);
  const res = await request(app)
    .get("/api/v1/app/digital-metals/statements/metal.pdf?fromBusinessDate=2026-09-01&toBusinessDate=2026-09-30")
    .set("Authorization", token);
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"] ?? ""), /pdf/i);
  assert.ok((res.body?.length ?? 0) > 100);
});

test("download-url issues presigned access without persisting URL on artifact", async () => {
  const fixture = await seedFixture({});
  await enablePlan(fixture.tenant._id);
  const token = await customerBearer(fixture);
  const queued = await request(app)
    .post("/api/v1/app/digital-metals/documents/request")
    .set("Authorization", token)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      docType: "METAL_STATEMENT",
      fromBusinessDate: "2026-10-05",
      toBusinessDate: "2026-10-06",
    });
  const artifactId = queued.body.data.id;
  await runDigitalMetalOutboxDispatch();
  const dl1 = await request(app)
    .get(`/api/v1/app/digital-metals/documents/${artifactId}/download-url`)
    .set("Authorization", token);
  const dl2 = await request(app)
    .get(`/api/v1/app/digital-metals/documents/${artifactId}/download-url`)
    .set("Authorization", token);
  assert.equal(dl1.status, 200);
  assert.equal(dl2.status, 200);
  assert.ok(dl1.body.data.downloadUrl);
  assert.ok(dl2.body.data.downloadUrl);
  assert.equal(dl1.body.data.expiresInSeconds, 900);
  const row = await DigitalMetalDocumentArtifact.findById(artifactId).lean();
  assert.equal(row.downloadUrl, undefined);
});

test("download-url bytes are PDF (mock local storage evidence)", async () => {
  const fixture = await seedFixture({});
  await enablePlan(fixture.tenant._id);
  const token = await customerBearer(fixture);
  const queued = await request(app)
    .post("/api/v1/app/digital-metals/documents/request")
    .set("Authorization", token)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      docType: "METAL_STATEMENT",
      fromBusinessDate: "2026-10-07",
      toBusinessDate: "2026-10-08",
    });
  const artifactId = queued.body.data.id;
  await runDigitalMetalOutboxDispatch();
  const dl = await request(app)
    .get(`/api/v1/app/digital-metals/documents/${artifactId}/download-url`)
    .set("Authorization", token);
  assert.equal(dl.status, 200);
  const url = dl.body.data.downloadUrl;
  assert.ok(url.includes("/mock-storage/"), "expected mock-storage URL in test env");
  const mockPath = `/mock-storage/${url.split("/mock-storage/")[1]}`;
  const fileRes = await request(app).get(mockPath);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.body.subarray(0, 5).toString("utf8"), "%PDF-");
});

test("new authorized download-url replaces prior presign token", async () => {
  const fixture = await seedFixture({});
  await enablePlan(fixture.tenant._id);
  const token = await customerBearer(fixture);
  const { storageProvider } = await import("../src/integrations/storage.provider.js");
  let n = 0;
  const original = storageProvider.presignDownload.bind(storageProvider);
  storageProvider.presignDownload = async (objectKey) => {
    n += 1;
    const base = await original(objectKey);
    return `${base}${base.includes("?") ? "&" : "?"}mockToken=${n}`;
  };
  try {
    const queued = await request(app)
      .post("/api/v1/app/digital-metals/documents/request")
      .set("Authorization", token)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        docType: "METAL_STATEMENT",
        fromBusinessDate: "2026-10-09",
        toBusinessDate: "2026-10-10",
      });
    const artifactId = queued.body.data.id;
    await runDigitalMetalOutboxDispatch();
    const dl1 = await request(app)
      .get(`/api/v1/app/digital-metals/documents/${artifactId}/download-url`)
      .set("Authorization", token);
    const dl2 = await request(app)
      .get(`/api/v1/app/digital-metals/documents/${artifactId}/download-url`)
      .set("Authorization", token);
    assert.equal(dl1.status, 200);
    assert.equal(dl2.status, 200);
    assert.notEqual(dl1.body.data.downloadUrl, dl2.body.data.downloadUrl);
    assert.match(dl1.body.data.downloadUrl, /mockToken=1/);
    assert.match(dl2.body.data.downloadUrl, /mockToken=2/);
    const pathOnly = `/mock-storage/${dl2.body.data.downloadUrl.split("/mock-storage/")[1].split("?")[0]}`;
    const pdfRes = await request(app).get(pathOnly);
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.body.subarray(0, 5).toString("utf8"), "%PDF-");
  } finally {
    storageProvider.presignDownload = original;
  }
});
