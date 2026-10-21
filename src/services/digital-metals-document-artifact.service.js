import { env } from "../config/env.js";
import { createId } from "../lib/ids.js";
import { randomToken } from "../lib/crypto.js";
import { errors, AppError } from "../lib/app-error.js";
import {
  renderPhysicalHandoverReceiptPdf,
  renderPayoutReceiptPdf,
  renderRedemptionChargeReceiptPdf,
  renderSellAcknowledgementPdf,
} from "../lib/digital-metals-document-pdf.js";
import { renderDigitalMetalStatementPdfBuffer } from "../lib/digital-metals-statement-pdf.js";
import {
  DIGITAL_METAL_OUTBOX_TOPICS,
  enqueueDigitalMetalOutboxEvent,
} from "../lib/digital-metals-outbox.js";
import { withTransaction } from "../lib/transaction.js";
import { ensureDocumentReadyNotificationIntent } from "./digital-metals-notification-intent-reconcile.service.js";
import { storageProvider } from "../integrations/storage.provider.js";
import {
  Counter,
  Customer,
  DigitalMetalDocumentArtifact,
  DigitalMetalPayout,
  DigitalMetalPhysicalOutEvent,
  DigitalMetalRedemptionOrder,
  DigitalMetalSellOrder,
  Tenant,
  Upload,
} from "../models/index.js";
import { UploadPurpose, UploadStatus } from "../constants/enums.js";
import { buildMetalStatementSnapshot } from "./digital-metals-statement.service.js";
import { digitalMetalDocumentArtifactTestHooks } from "../lib/digital-metals-document-artifact-test-hooks.js";
import {
  assertAdminCustomerInScope,
  assertAdminDigitalMetalsCustomerSubject,
} from "../lib/digital-metals-admin-scope.js";

const DOC_NUMBER_PREFIX = Object.freeze({
  REDEMPTION_CHARGE_RECEIPT: "RCR",
  HANDOVER_RECEIPT: "HOR",
  SELL_ACKNOWLEDGEMENT: "SLA",
  PAYOUT_RECEIPT: "PYR",
  METAL_STATEMENT: "STM",
});

const UPLOAD_PURPOSE_BY_DOC = Object.freeze({
  REDEMPTION_CHARGE_RECEIPT: UploadPurpose.DIGITAL_METAL_CHARGE_RECEIPT,
  HANDOVER_RECEIPT: UploadPurpose.DIGITAL_METAL_HANDOVER_RECEIPT,
  SELL_ACKNOWLEDGEMENT: UploadPurpose.DIGITAL_METAL_SELL_ACK,
  PAYOUT_RECEIPT: UploadPurpose.DIGITAL_METAL_PAYOUT_RECEIPT,
  METAL_STATEMENT: UploadPurpose.DIGITAL_METAL_STATEMENT,
});

function leaseMs() {
  return env.DIGITAL_METALS_DOCUMENT_LEASE_MS ?? env.DIGITAL_METALS_OUTBOX_LEASE_MS ?? 90_000;
}

function maxAttempts() {
  return env.DIGITAL_METALS_DOCUMENT_MAX_ATTEMPTS ?? env.DIGITAL_METALS_OUTBOX_MAX_ATTEMPTS ?? 8;
}

function backoffNext(attempts) {
  const sec = Math.min(1800, 30 * 2 ** Math.min(attempts, 5));
  return new Date(Date.now() + sec * 1000);
}

function mapArtifact(row) {
  return {
    id: row._id,
    docType: row.docType,
    subjectKey: row.subjectKey,
    customerId: row.customerId ?? null,
    status: row.status,
    documentNumber: row.documentNumber ?? null,
    uploadId: row.uploadId ?? null,
    idempotencyKey: row.idempotencyKey,
    lastError: row.lastError ?? null,
    processingAttempts: row.processingAttempts ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function allocateDocumentNumber(tenantId, docType) {
  const year = new Date().getFullYear();
  const counterId = `dm-doc:${tenantId}:${docType}:${year}`;
  const counter = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { value: 1 } },
    { upsert: true, new: true },
  ).lean();
  const prefix = DOC_NUMBER_PREFIX[docType] ?? "DOC";
  return `${prefix}-${year}-${String(counter.value).padStart(6, "0")}`;
}

async function buildSnapshotForRequest({ tenantId, docType, subjectKey, customerId, statementPeriod }) {
  if (docType === "METAL_STATEMENT") {
    if (!customerId) throw errors.validation([{ field: "customerId", message: "Required." }]);
    const { fromBusinessDate, toBusinessDate } = statementPeriod ?? {};
    return buildMetalStatementSnapshot({
      tenantId,
      customerId,
      fromBusinessDate,
      toBusinessDate,
    });
  }
  if (docType === "REDEMPTION_CHARGE_RECEIPT") {
    const filter = { _id: subjectKey, tenantId };
    if (customerId) filter.customerId = customerId;
    const order = await DigitalMetalRedemptionOrder.findOne(filter).lean();
    if (!order) throw errors.notFound("Order");
    const chargeReceiptStatuses = new Set([
      "CHARGE_PAID",
      "FULFILMENT_ACCEPTED",
      "PACKING",
      "DISPATCHED",
      "PICKUP_READY",
      "INVESTIGATION",
      "COMPLETED",
    ]);
    if (!chargeReceiptStatuses.has(order.status)) {
      throw errors.business("DOCUMENT_NOT_AVAILABLE", "Charge receipt available after charge is paid.");
    }
    return { order };
  }
  if (docType === "HANDOVER_RECEIPT") {
    const filter = { _id: subjectKey, tenantId, status: "COMPLETED" };
    if (customerId) filter.customerId = customerId;
    const order = await DigitalMetalRedemptionOrder.findOne(filter).lean();
    if (!order?.physicalOutEventId) throw errors.notFound("Handover");
    const event = await DigitalMetalPhysicalOutEvent.findOne({
      _id: order.physicalOutEventId,
      tenantId,
    }).lean();
    if (!event) throw errors.notFound("Handover event");
    return { order, event };
  }
  if (docType === "SELL_ACKNOWLEDGEMENT") {
    const filter = { _id: subjectKey, tenantId };
    if (customerId) filter.customerId = customerId;
    const order = await DigitalMetalSellOrder.findOne(filter).lean();
    if (!order) throw errors.notFound("Sell order");
    if (!["PAYABLE_OPEN", "SETTLED"].includes(order.status)) {
      throw errors.business("DOCUMENT_NOT_AVAILABLE", "Acknowledgement available after execution.");
    }
    return { order };
  }
  if (docType === "PAYOUT_RECEIPT") {
    const payout = await DigitalMetalPayout.findOne({ _id: subjectKey, tenantId }).lean();
    if (!payout) throw errors.notFound("Payout");
    if (!["SETTLED", "MANUAL_RECORDED"].includes(payout.status)) {
      throw errors.business(
        "DOCUMENT_NOT_AVAILABLE",
        "Payout receipt available after settlement is recorded.",
      );
    }
    return { payout };
  }
  throw errors.validation([{ field: "docType", message: "Unsupported document type." }]);
}

function subjectKeyForBody(docType, body) {
  if (docType === "METAL_STATEMENT") {
    const from = String(body.fromBusinessDate ?? "").trim();
    const to = String(body.toBusinessDate ?? "").trim();
    return `statement:${from}:${to}`;
  }
  const subjectId = String(body.subjectId ?? "").trim();
  if (!subjectId) throw errors.validation([{ field: "subjectId", message: "Required." }]);
  return subjectId;
}

export async function requestDigitalMetalDocument(req) {
  const docType = req.body.docType;
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Required." }]);
  }
  const tenantId = req.auth.tenantId;
  const existing = await DigitalMetalDocumentArtifact.findOne({ tenantId, idempotencyKey }).lean();
  if (existing) return mapArtifact(existing);

  const subjectKey = subjectKeyForBody(docType, req.body);
  const customerId =
    req.auth.type === "CUSTOMER"
      ? req.auth.id
      : (bodyCustomerId(req) ?? null);

  const snapshot = await buildSnapshotForRequest({
    tenantId,
    docType,
    subjectKey,
    customerId: customerId ?? req.auth.id,
    statementPeriod: {
      fromBusinessDate: req.body.fromBusinessDate,
      toBusinessDate: req.body.toBusinessDate,
    },
  });
  const subjectCustomerId =
    docType === "METAL_STATEMENT"
      ? (customerId ?? req.auth.id)
      : (snapshot.order?.customerId ?? snapshot.payout?.customerId ?? customerId ?? null);
  await assertAdminDigitalMetalsCustomerSubject(req, subjectCustomerId);

  const artifactId = createId("dmdoc");
  const row = await DigitalMetalDocumentArtifact.create({
    _id: artifactId,
    tenantId,
    docType,
    subjectKey,
    customerId: docType === "METAL_STATEMENT" ? (customerId ?? req.auth.id) : (snapshot.order?.customerId ?? snapshot.payout?.customerId ?? customerId),
    status: "PENDING",
    sourceSnapshot: snapshot,
    idempotencyKey,
    requestedByUserId: req.auth.id,
    requestedByType: req.auth.type === "CUSTOMER" ? "CUSTOMER" : "TENANT_USER",
  });

  await enqueueDigitalMetalOutboxEvent({
    tenantId,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.DOCUMENT_ARTIFACT_REQUEST,
    key: `${docType}:${subjectKey}:${idempotencyKey}`,
    payload: { artifactId },
  });

  return mapArtifact(row.toObject());
}

function bodyCustomerId(req) {
  const raw = req.body?.customerId;
  return raw ? String(raw).trim() : null;
}

export async function getDigitalMetalDocumentArtifact(req) {
  const artifact = await loadAuthorizedArtifact(req);
  return mapArtifact(artifact);
}

export async function findDigitalMetalDocumentBySubject(req) {
  const docType = String(req.query.docType ?? "").trim();
  const subjectKey = subjectKeyFromQuery(req);
  if (!docType || !subjectKey) {
    throw errors.validation([
      { field: "docType", message: "Required." },
      { field: "subjectId", message: "Required unless statement period supplied." },
    ]);
  }
  const artifact = await DigitalMetalDocumentArtifact.findOne({
    tenantId: req.auth.tenantId,
    docType,
    subjectKey,
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!artifact) return { artifact: null };
  await assertArtifactAccess(req, artifact);
  return { artifact: mapArtifact(artifact) };
}

function subjectKeyFromQuery(req) {
  if (req.query.fromBusinessDate && req.query.toBusinessDate) {
    return `statement:${String(req.query.fromBusinessDate).trim()}:${String(req.query.toBusinessDate).trim()}`;
  }
  const subjectId = String(req.query.subjectId ?? "").trim();
  return subjectId || null;
}

async function loadAuthorizedArtifact(req) {
  const artifact = await DigitalMetalDocumentArtifact.findOne({
    _id: req.params.artifactId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!artifact) throw errors.notFound("Document");
  await assertArtifactAccess(req, artifact);
  return artifact;
}

async function assertArtifactAccess(req, artifact) {
  if (req.auth.type === "CUSTOMER") {
    if (artifact.customerId && artifact.customerId !== req.auth.id) {
      throw errors.forbidden();
    }
    if (
      artifact.docType !== "METAL_STATEMENT"
      && artifact.customerId
      && artifact.customerId !== req.auth.id
    ) {
      throw errors.forbidden();
    }
    return;
  }
  if (req.auth.type === "TENANT_USER" && artifact.customerId) {
    await assertAdminCustomerInScope(req, artifact.customerId);
  }
}

export async function getDigitalMetalDocumentDownloadUrl(req) {
  const artifact = await loadAuthorizedArtifact(req);
  if (artifact.status !== "READY" || !artifact.uploadId) {
    throw errors.business("DOCUMENT_NOT_READY", "Document is not ready for download.", {
      status: artifact.status,
      artifactId: artifact._id,
    });
  }
  const upload = await Upload.findOne({
    _id: artifact.uploadId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!upload?.objectKey) throw errors.notFound("Upload");
  const downloadUrl = await storageProvider.presignDownload(upload.objectKey);
  return {
    artifactId: artifact._id,
    documentNumber: artifact.documentNumber,
    uploadId: upload._id,
    downloadUrl,
    fileName: upload.fileName ?? null,
    contentType: upload.contentType ?? "application/pdf",
    expiresInSeconds: 900,
  };
}

export async function retryDigitalMetalDocument(req) {
  const artifact = await loadAuthorizedArtifact(req);
  if (artifact.status === "READY") {
    await ensureDocumentReadyNotificationIntent(artifact);
    const fresh = await DigitalMetalDocumentArtifact.findById(artifact._id).lean();
    return mapArtifact(fresh ?? artifact);
  }
  if (artifact.status === "PROCESSING") {
    throw new AppError("DOCUMENT_BUSY", "Document generation is in progress.", 409);
  }
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Required." }]);
  }
  await DigitalMetalDocumentArtifact.updateOne(
    { _id: artifact._id, tenantId: req.auth.tenantId, status: { $in: ["FAILED", "PENDING"] } },
    {
      $set: {
        status: "PENDING",
        lastError: null,
        availableAt: new Date(),
        processingLeaseOwner: null,
        processingLeaseExpiresAt: null,
      },
    },
  );
  await enqueueDigitalMetalOutboxEvent({
    tenantId: req.auth.tenantId,
    topic: DIGITAL_METAL_OUTBOX_TOPICS.DOCUMENT_ARTIFACT_REQUEST,
    key: `retry:${artifact._id}:${idempotencyKey}`,
    payload: { artifactId: artifact._id },
  });
  const refreshed = await DigitalMetalDocumentArtifact.findById(artifact._id).lean();
  return mapArtifact(refreshed);
}

async function renderPdfBufferFromContext({ tenantId, docType, snapshot, documentNumber = "", customerId }) {
  const snap = snapshot ?? {};
  if (docType === "METAL_STATEMENT") {
    const tenant = await Tenant.findById(tenantId).lean();
    const custId = customerId ?? snap.customerId;
    const customer = await Customer.findOne({ _id: custId, tenantId }).lean();
    return renderDigitalMetalStatementPdfBuffer({
      tenant,
      customer,
      documentNumber,
      fromBusinessDate: snap.fromBusinessDate,
      toBusinessDate: snap.toBusinessDate,
      lines: snap.activity ?? [],
      openingByAsset: snap.openingByAsset ?? [],
      closingByAsset: snap.closingByAsset ?? [],
    });
  }
  const docCtx = { documentNumber };
  if (docType === "REDEMPTION_CHARGE_RECEIPT") {
    return renderRedemptionChargeReceiptPdf({ ...docCtx, order: snap.order });
  }
  if (docType === "HANDOVER_RECEIPT") {
    return renderPhysicalHandoverReceiptPdf({ ...docCtx, event: snap.event, order: snap.order });
  }
  if (docType === "SELL_ACKNOWLEDGEMENT") {
    return renderSellAcknowledgementPdf({ ...docCtx, order: snap.order });
  }
  if (docType === "PAYOUT_RECEIPT") {
    return renderPayoutReceiptPdf({ ...docCtx, payout: snap.payout });
  }
  throw new Error(`Unsupported docType ${docType}`);
}

function pdfFilename(docType, subjectKey) {
  const safe = String(subjectKey).replace(/[^\w.-]+/g, "_").slice(0, 80);
  return `${docType.toLowerCase()}-${safe}.pdf`;
}

/** Customer/admin PDF routes — generate on demand (no prior artifact upload required). */
export async function serveLegacyPdfRoute(
  req,
  res,
  { docType, subjectKey, customerId, statementPeriod },
) {
  const tenantId = req.auth.tenantId;
  const snapshot = await buildSnapshotForRequest({
    tenantId,
    docType,
    subjectKey,
    customerId,
    statementPeriod,
  });
  const subjectCustomerId =
    customerId ?? snapshot.order?.customerId ?? snapshot.payout?.customerId ?? null;
  await assertAdminDigitalMetalsCustomerSubject(req, subjectCustomerId);
  const buffer = await renderPdfBufferFromContext({
    tenantId,
    docType,
    snapshot,
    customerId: customerId ?? snapshot.order?.customerId ?? snapshot.payout?.customerId,
  });
  const filename = pdfFilename(docType, subjectKey);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

async function renderPdfFromSnapshot(artifact) {
  return renderPdfBufferFromContext({
    tenantId: artifact.tenantId,
    docType: artifact.docType,
    snapshot: artifact.sourceSnapshot ?? {},
    documentNumber: artifact.documentNumber ?? "",
    customerId: artifact.customerId,
  });
}

function buildLease(artifactId) {
  return `dmdoc_${artifactId}_${randomToken(6)}`;
}

export async function reclaimStaleDocumentArtifacts(at = new Date()) {
  const result = await DigitalMetalDocumentArtifact.updateMany(
    {
      status: "PROCESSING",
      processingLeaseExpiresAt: { $lte: at },
    },
    {
      $set: {
        status: "PENDING",
        processingLeaseOwner: null,
        processingLeaseExpiresAt: null,
        availableAt: at,
      },
    },
  );
  return result.modifiedCount ?? 0;
}

/** Worker entry — idempotent; never reissues document numbers or replaces READY uploads. */
export async function processDigitalMetalDocumentArtifactRequest({ tenantId, artifactId }) {
  const at = new Date();
  await reclaimStaleDocumentArtifacts(at);

  const leaseOwner = buildLease(artifactId);
  const claimed = await DigitalMetalDocumentArtifact.findOneAndUpdate(
    {
      _id: artifactId,
      tenantId,
      status: { $in: ["PENDING", "FAILED"] },
      availableAt: { $lte: at },
      $or: [
        { processingLeaseExpiresAt: { $lte: at } },
        { processingLeaseExpiresAt: null },
        { processingLeaseExpiresAt: { $exists: false } },
      ],
    },
    {
      $set: {
        status: "PROCESSING",
        processingLeaseOwner: leaseOwner,
        processingLeaseExpiresAt: new Date(at.getTime() + leaseMs()),
      },
      $inc: { processingAttempts: 1 },
    },
    { new: true },
  ).lean();

  if (!claimed) {
    const existing = await DigitalMetalDocumentArtifact.findOne({ _id: artifactId, tenantId }).lean();
    if (existing?.status === "READY" && existing.uploadId) {
      await ensureDocumentReadyNotificationIntent(existing);
      return { outcome: "ALREADY_READY", uploadId: existing.uploadId };
    }
    return { outcome: "NOT_CLAIMABLE" };
  }

  if (claimed.status === "READY" && claimed.uploadId) {
    await ensureDocumentReadyNotificationIntent(claimed);
    return { outcome: "ALREADY_READY", uploadId: claimed.uploadId };
  }

  if (
    process.env.NODE_ENV === "test"
    && digitalMetalDocumentArtifactTestHooks.holdAfterClaimForArtifactId === artifactId
  ) {
    await digitalMetalDocumentArtifactTestHooks.holdAfterClaimGate;
  }

  try {
    let documentNumber = claimed.documentNumber;
    if (!documentNumber) {
      documentNumber = await allocateDocumentNumber(tenantId, claimed.docType);
      const reserved = await DigitalMetalDocumentArtifact.findOneAndUpdate(
        {
          _id: artifactId,
          tenantId,
          documentNumber: null,
          processingLeaseOwner: leaseOwner,
        },
        { $set: { documentNumber } },
        { new: true },
      ).lean();
      if (!reserved?.documentNumber) {
        const again = await DigitalMetalDocumentArtifact.findOne({ _id: artifactId, tenantId }).lean();
        documentNumber = again?.documentNumber;
        if (!documentNumber) throw new Error("DOCUMENT_NUMBER_RACE");
      }
    }

    const withNumber = await DigitalMetalDocumentArtifact.findOne({ _id: artifactId, tenantId }).lean();
    const pdf = await renderPdfFromSnapshot(withNumber);
    const uploadId = withNumber.uploadId ?? createId("upload");
    const objectKey = `${tenantId}/digital_metal_doc/${uploadId}/${withNumber.docType}.pdf`;
    await storageProvider.uploadFile({
      objectKey,
      body: pdf,
      contentType: "application/pdf",
    });

    const purpose = UPLOAD_PURPOSE_BY_DOC[withNumber.docType];
    const existingUpload = withNumber.uploadId
      ? await Upload.findOne({ _id: withNumber.uploadId, tenantId }).lean()
      : null;
    if (!existingUpload) {
      await Upload.create({
        _id: uploadId,
        tenantId,
        ownerId: withNumber.customerId ?? withNumber.requestedByUserId,
        purpose,
        fileName: `${withNumber.documentNumber}.pdf`,
        contentType: "application/pdf",
        sizeBytes: pdf.length,
        objectKey,
        status: UploadStatus.UPLOADED,
        expiresAt: null,
      });
    }

    let finalized = null;
    await withTransaction(async (session) => {
      finalized = await DigitalMetalDocumentArtifact.findOneAndUpdate(
        {
          _id: artifactId,
          tenantId,
          processingLeaseOwner: leaseOwner,
          status: "PROCESSING",
        },
        {
          $set: {
            status: "READY",
            uploadId: existingUpload?._id ?? uploadId,
            processingLeaseOwner: null,
            processingLeaseExpiresAt: null,
            lastError: null,
          },
        },
        { new: true, session },
      ).lean();
      if (!finalized?.customerId) return;
      await ensureDocumentReadyNotificationIntent(finalized, { session });
    });

    if (!finalized) return { outcome: "FINALIZE_RACE" };
    return { outcome: "READY", uploadId: finalized.uploadId, documentNumber: finalized.documentNumber };
  } catch (err) {
    const attempts = claimed.processingAttempts ?? 1;
    const giveUp = attempts >= maxAttempts();
    await DigitalMetalDocumentArtifact.updateOne(
      { _id: artifactId, tenantId, processingLeaseOwner: leaseOwner },
      {
        $set: {
          status: giveUp ? "FAILED" : "PENDING",
          processingLeaseOwner: null,
          processingLeaseExpiresAt: null,
          availableAt: giveUp ? claimed.availableAt : backoffNext(attempts),
          lastError: String(err?.message ?? err).slice(0, 500),
        },
      },
    );
    return { outcome: giveUp ? "FAILED" : "RETRY_SCHEDULED" };
  }
}
