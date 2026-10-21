import { env } from "../config/env.js";
import { writeAudit } from "./audit.service.js";
import { DigitalMetalDocumentArtifact, DigitalMetalOutboxEvent } from "../models/index.js";
import { runDigitalMetalOutboxDispatch } from "./digital-metals-outbox-dispatch.service.js";
import { retryDigitalMetalDocument } from "./digital-metals-document-artifact.service.js";

function redactError(message) {
  return String(message ?? "")
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .slice(0, 240);
}

function ageMs(fromDate) {
  if (!fromDate) return null;
  return Math.max(0, Date.now() - new Date(fromDate).getTime());
}

function mapOutboxRow(row) {
  return {
    id: row._id,
    kind: "OUTBOX",
    topic: row.topic,
    status: row.status,
    dispatchAttempts: row.dispatchAttempts ?? 0,
    availableAt: row.availableAt,
    lastError: redactError(row.lastError),
    ageMs: ageMs(row.createdAt),
    stuck: row.status === "PROCESSING" || row.status === "FAILED" || (row.dispatchAttempts ?? 0) > 2,
    safeActions: row.status === "FAILED" || row.status === "PROCESSING" ? ["RETRY_OUTBOX"] : [],
  };
}

function mapDocumentRow(row) {
  return {
    id: row._id,
    kind: "DOCUMENT",
    docType: row.docType,
    status: row.status,
    processingAttempts: row.processingAttempts ?? 0,
    lastError: redactError(row.lastError),
    ageMs: ageMs(row.createdAt),
    stuck: ["PENDING", "FAILED", "PROCESSING"].includes(row.status),
    safeActions: row.status === "FAILED" || row.status === "PENDING" ? ["RETRY_DOCUMENT"] : [],
  };
}

export async function getAdminDigitalMetalsWorkQueue(req) {
  const tenantId = req.auth.tenantId;
  const at = new Date();
  const leaseStaleBefore = new Date(at.getTime() - (env.DIGITAL_METALS_OUTBOX_LEASE_MS ?? 90_000));

  const [outboxPending, outboxFailed, outboxStuck, docsStuck] = await Promise.all([
    DigitalMetalOutboxEvent.find({
      tenantId,
      status: "PENDING",
      availableAt: { $lte: at },
    })
      .sort({ availableAt: 1 })
      .limit(40)
      .lean(),
    DigitalMetalOutboxEvent.find({ tenantId, status: "FAILED" })
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean(),
    DigitalMetalOutboxEvent.find({
      tenantId,
      status: "PROCESSING",
      dispatchLeaseExpiresAt: { $lte: leaseStaleBefore },
    })
      .sort({ dispatchLeaseExpiresAt: 1 })
      .limit(20)
      .lean(),
    DigitalMetalDocumentArtifact.find({
      tenantId,
      status: { $in: ["PENDING", "FAILED", "PROCESSING"] },
    })
      .sort({ updatedAt: 1 })
      .limit(30)
      .lean(),
  ]);

  const items = [
    ...outboxPending.map(mapOutboxRow),
    ...outboxFailed.map(mapOutboxRow),
    ...outboxStuck.map(mapOutboxRow),
    ...docsStuck.map(mapDocumentRow),
  ];

  return {
    generatedAt: at.toISOString(),
    summary: {
      outboxPending: outboxPending.length,
      outboxFailed: outboxFailed.length,
      outboxLeaseStale: outboxStuck.length,
      documentsRetryable: docsStuck.length,
    },
    items,
    notes: [
      "Operational retries re-queue notifications or document generation only — never repeat financial settlement.",
      "Push/inbox delivery is separate from business success; inspect outbox topic and lastError for provider issues.",
    ],
  };
}

export async function retryAdminDigitalMetalsOutboxEvent(req) {
  const event = await DigitalMetalOutboxEvent.findOne({
    _id: req.params.eventId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!event) {
    const { errors } = await import("../lib/app-error.js");
    throw errors.notFound("Outbox event");
  }
  if (!["FAILED", "PROCESSING", "PENDING"].includes(event.status)) {
    const { AppError } = await import("../lib/app-error.js");
    throw new AppError("INVALID_STATE", "Only failed or stuck outbox events can be retried.", 409);
  }
  await DigitalMetalOutboxEvent.updateOne(
    { _id: event._id, tenantId: req.auth.tenantId },
    {
      $set: {
        status: "PENDING",
        availableAt: new Date(),
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        lastError: null,
      },
    },
  );
  await writeAudit({
    req,
    action: "DIGITAL_METAL_OUTBOX_RETRY",
    entityType: "MESSAGE",
    entityId: event._id,
    after: { topic: event.topic, key: event.key },
  });
  const dispatch = await runDigitalMetalOutboxDispatch();
  return { eventId: event._id, topic: event.topic, dispatch };
}

export async function getPlatformDigitalMetalsOperationsSummary(req) {
  const at = new Date();
  const tenantFilter = req.query.tenantId ? { tenantId: String(req.query.tenantId) } : {};
  const [outboxFailed, outboxPending, docsFailed] = await Promise.all([
    DigitalMetalOutboxEvent.countDocuments({ ...tenantFilter, status: "FAILED" }),
    DigitalMetalOutboxEvent.countDocuments({
      ...tenantFilter,
      status: "PENDING",
      availableAt: { $lte: at },
    }),
    DigitalMetalDocumentArtifact.countDocuments({
      ...tenantFilter,
      status: { $in: ["FAILED", "PROCESSING"] },
    }),
  ]);
  return {
    generatedAt: at.toISOString(),
    tenantId: req.query.tenantId ?? null,
    counts: {
      outboxFailed,
      outboxPending,
      documentsStuck: docsFailed,
    },
    notes: ["Aggregate counts only — no customer identifiers or presigned URLs."],
  };
}

export async function retryAdminDigitalMetalsDocumentArtifact(req) {
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? req.body?.idempotencyKey ?? "").trim();
  if (!idempotencyKey) {
    const { errors } = await import("../lib/app-error.js");
    throw errors.validation([{ field: "x-idempotency-key", message: "Required." }]);
  }
  req.headers["x-idempotency-key"] = idempotencyKey;
  const artifact = await retryDigitalMetalDocument(req);
  await writeAudit({
    req,
    action: "DIGITAL_METAL_DOCUMENT_RETRY",
    entityType: "MESSAGE",
    entityId: req.params.artifactId,
    after: { status: artifact.status, docType: artifact.docType },
  });
  return { artifact };
}
