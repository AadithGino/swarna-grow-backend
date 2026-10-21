import process from "node:process";
process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { Worker, Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { env } from "../src/config/env.js";
import { DIGITAL_METAL_OUTBOX_TOPICS } from "../src/lib/digital-metals-outbox.js";
import { DigitalMetalDocumentArtifact, DigitalMetalOutboxEvent } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { runDigitalMetalOutboxDispatch } from "../src/services/digital-metals-outbox-dispatch.service.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

async function redisAvailable() {
  const probe = new IORedis(env.REDIS_URL, { connectTimeout: 1500, maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    await probe.quit().catch(() => {});
  }
}

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  const { clearDocumentArtifactTestHooksForTests } = await import(
    "../src/lib/digital-metals-document-artifact-test-hooks.js"
  );
  clearDocumentArtifactTestHooksForTests();
});

test("stale outbox lease recovers via dispatch without duplicate document side effects", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const artifactId = createId("dmdoc");
  const idempotencyKey = randomUUID();
  await DigitalMetalDocumentArtifact.create({
    _id: artifactId,
    tenantId: tenant._id,
    docType: "METAL_STATEMENT",
    subjectKey: "statement:2026-10-01:2026-10-02",
    customerId: customer._id,
    status: "PENDING",
    sourceSnapshot: {
      fromBusinessDate: "2026-10-01",
      toBusinessDate: "2026-10-02",
      openingByAsset: [],
      closingByAsset: [],
      activity: [],
    },
    idempotencyKey,
  });
  const eventId = createId("dmobx");
  await DigitalMetalOutboxEvent.create({
    _id: eventId,
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.DOCUMENT_ARTIFACT_REQUEST,
    key: `${artifactId}:artifact`,
    payload: { artifactId },
    status: "PROCESSING",
    dispatchLeaseOwner: "stale_worker_sim",
    dispatchLeaseExpiresAt: new Date(Date.now() - 60_000),
    availableAt: new Date(Date.now() - 60_000),
  });

  const { storageProvider } = await import("../src/integrations/storage.provider.js");
  const originalUpload = storageProvider.uploadFile.bind(storageProvider);
  let uploadCount = 0;
  storageProvider.uploadFile = async (args) => {
    uploadCount += 1;
    return originalUpload(args);
  };
  try {
    await runDigitalMetalOutboxDispatch();
    await runDigitalMetalOutboxDispatch();
    const artifact = await DigitalMetalDocumentArtifact.findById(artifactId).lean();
    assert.equal(artifact.status, "READY");
    assert.equal(uploadCount, 1);
    assert.equal(await DigitalMetalOutboxEvent.countDocuments({ _id: eventId, status: "PROCESSED" }), 1);
  } finally {
    storageProvider.uploadFile = originalUpload;
  }
});

test("BullMQ maintenance worker runs digital-metals-outbox-dispatch job (Redis)", async () => {
  if (!(await redisAvailable())) {
    test.skip("Redis unavailable for BullMQ integration gate");
    return;
  }
  const queueName = `test-dm-outbox-${createId("q")}`;
  const connection = { url: env.REDIS_URL };
  const queue = new Queue(queueName, { connection });
  let workerHits = 0;
  const worker = new Worker(
    queueName,
    async (job) => {
      if (job.name !== "digital-metals-outbox-dispatch") return;
      workerHits += 1;
      await runDigitalMetalOutboxDispatch();
    },
    { connection, concurrency: 1 },
  );
  const waitCompleted = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker timeout")), 15_000);
      worker.once("completed", () => {
        clearTimeout(timer);
        resolve();
      });
      worker.once("failed", (_, err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  try {
    await queue.add("digital-metals-outbox-dispatch", {}, { jobId: `dm-outbox-${createId("j")}` });
    await waitCompleted();
    assert.equal(workerHits, 1);
    await queue.add("digital-metals-outbox-dispatch", {}, { jobId: `dm-outbox-${createId("j2")}` });
    await waitCompleted();
    assert.equal(workerHits, 2);
  } finally {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  }
});

test("BullMQ replacement worker recovers after primary worker stall (Redis)", async () => {
  if (!(await redisAvailable())) {
    test.skip("Redis unavailable for BullMQ integration gate");
    return;
  }
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const artifactId = createId("dmdoc");
  await DigitalMetalDocumentArtifact.create({
    _id: artifactId,
    tenantId: tenant._id,
    docType: "METAL_STATEMENT",
    subjectKey: "statement:2026-10-01:2026-10-02",
    customerId: customer._id,
    status: "PENDING",
    sourceSnapshot: {
      fromBusinessDate: "2026-10-01",
      toBusinessDate: "2026-10-02",
      openingByAsset: [],
      closingByAsset: [],
      activity: [],
    },
    idempotencyKey: randomUUID(),
  });
  const eventId = createId("dmobx");
  await DigitalMetalOutboxEvent.create({
    _id: eventId,
    tenantId: tenant._id,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.DOCUMENT_ARTIFACT_REQUEST,
    key: `${artifactId}:artifact`,
    payload: { artifactId },
    status: "PENDING",
    availableAt: new Date(),
  });

  const { armDocumentArtifactHoldAfterClaim, clearDocumentArtifactTestHooksForTests } = await import(
    "../src/lib/digital-metals-document-artifact-test-hooks.js"
  );
  armDocumentArtifactHoldAfterClaim(artifactId);

  const queueName = `test-dm-outbox-restart-${createId("q")}`;
  const connection = { url: env.REDIS_URL };
  const queue = new Queue(queueName, { connection });
  const processor = async () => {
    await runDigitalMetalOutboxDispatch();
  };
  const worker1 = new Worker(queueName, processor, {
    connection,
    concurrency: 1,
    lockDuration: 60_000,
  });

  const waitOutboxStatus = async (status) => {
    for (let i = 0; i < 60; i += 1) {
      const row = await DigitalMetalOutboxEvent.findById(eventId).lean();
      if (row?.status === status) return row;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`outbox never reached ${status}`);
  };

  const { storageProvider } = await import("../src/integrations/storage.provider.js");
  const originalUpload = storageProvider.uploadFile.bind(storageProvider);
  let uploadCount = 0;
  storageProvider.uploadFile = async (args) => {
    uploadCount += 1;
    return originalUpload(args);
  };

  try {
    const jobId = `dm-outbox-${createId("j")}`;
    await queue.add("digital-metals-outbox-dispatch", {}, { jobId });
    await waitOutboxStatus("PROCESSING");
    await worker1.close(true);
    const { digitalMetalDocumentArtifactTestHooks } = await import(
      "../src/lib/digital-metals-document-artifact-test-hooks.js"
    );
    digitalMetalDocumentArtifactTestHooks.releaseHold?.();
    clearDocumentArtifactTestHooksForTests();
    await DigitalMetalOutboxEvent.updateOne(
      { _id: eventId, status: "PROCESSING" },
      { $set: { dispatchLeaseExpiresAt: new Date(Date.now() - 5_000) } },
    );

    let worker2Hits = 0;
    const worker2 = new Worker(queueName, async () => {
      worker2Hits += 1;
      await runDigitalMetalOutboxDispatch();
    }, { connection, concurrency: 1, lockDuration: 60_000 });
    await queue.add("digital-metals-outbox-dispatch", {}, { jobId: `dm-outbox-${createId("j2")}` });
    await waitOutboxStatus("PROCESSED");
    await worker2.close();
    assert.ok(worker2Hits >= 1);
    const artifact = await DigitalMetalDocumentArtifact.findById(artifactId).lean();
    assert.equal(artifact.status, "READY");
    assert.equal(uploadCount, 1);
    assert.equal(await DigitalMetalOutboxEvent.countDocuments({ _id: eventId, status: "PROCESSED" }), 1);
  } finally {
    storageProvider.uploadFile = originalUpload;
    clearDocumentArtifactTestHooksForTests();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close().catch(() => {});
  }
});
