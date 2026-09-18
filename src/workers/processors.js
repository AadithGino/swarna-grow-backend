import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { AuditEntityType } from "../constants/enums.js";
import { Alert, Customer, ExportJob, Grievance, Message, OutboxEvent, PaymentIntent, PaymentLink, Scheme, Tenant, WebhookEvent } from "../models/index.js";
import { writeAudit } from "../services/audit.service.js";
import { addMonthsClamped } from "../lib/date.js";
import { whatsappProvider } from "../integrations/whatsapp.provider.js";
import { recordPayment } from "../services/payment.service.js";
import { queueMessage, updateDelivery } from "../services/messaging.service.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { storageProvider } from "../integrations/storage.provider.js";
import { unseal } from "../lib/crypto.js";
import { AppError } from "../lib/app-error.js";
import { normalizePhonePeWebhookEvent } from "../lib/phonepe-webhook-payload.js";
import { isPhonePeRefundCallback } from "../integrations/phonepe.provider.js";
import { buildReportExportRows, exportReportKey, isRawExportType } from "../lib/report-export.js";
import PDFDocument from "pdfkit";

const csvCell = (value) => {
  let text = String(typeof value === "object" && value !== null ? JSON.stringify(value) : value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

export async function processMessage(job) {
  const message = await Message.findById(job.data.messageId); if (!message || message.status === "DELIVERED") return;
  try { const templateName = message.templateKey === "PAYMENT_SUCCESS_MEDIA" && !message.templateParams?.passbookImageUrl ? "PAYMENT_SUCCESS_TEXT_FALLBACK" : message.templateKey; const tenant = await Tenant.findById(message.tenantId).select("+integrationSecrets").lean(); const config = tenant?.integrationSecrets?.whatsapp; const credentials = config ? { phoneNumberId: config.phoneNumberId, accessToken: config.accessToken ? unseal(config.accessToken) : undefined } : {}; const result = await whatsappProvider.sendTemplate({ to: message.templateParams?.mobile, templateName, components: templateName === "PAYMENT_SUCCESS_TEXT_FALLBACK" ? message.templateParams?.textComponents : message.templateParams?.components, credentials }); message.status = result.status; if (env.PROVIDER_MODE === "mock" && message.status === "SENT") { message.status = "DELIVERED"; message.deliveredAt = new Date(); } message.templateKey = templateName; message.providerMessageId = result.providerMessageId; message.lastAttemptAt = new Date(); message.attemptCount += 1; await message.save(); }
  catch (error) { message.status = "FAILED"; message.failureMessage = error.message; message.failedAt = new Date(); message.attemptCount += 1; await message.save(); throw error; }
}
export async function processWebhook(job) {
  const event = await WebhookEvent.findById(job.data.webhookEventId); if (!event || event.status === "COMPLETED") return;
  event.status = "PROCESSING"; event.attempts = (event.attempts ?? 0) + 1; await event.save();
  try {
    if (event.provider === "PHONEPE") {
      const normalized = normalizePhonePeWebhookEvent(event.payload);
      const { reference, payload, transactionId } = normalized;
      if (normalized.refund || isPhonePeRefundCallback(event.payload?.type)) {
        logger.info(
          { type: event.payload?.type, orderId: payload?.orderId },
          "Refund webhook received — refund handling not yet implemented",
        );
        // TODO(refund): build out in a later pass
      } else if (normalized.completed) {
        const intent = await PaymentIntent.findOne({
          tenantId: event.tenantId,
          $or: [{ _id: reference }, { providerOrderId: reference }],
          status: { $ne: "SUCCEEDED" },
        });
        const link = intent
          ? null
          : await PaymentLink.findOne({
            tenantId: event.tenantId,
            _id: reference,
            status: { $ne: "PAID" },
          });
        const source = intent ?? link;
        if (source) {
          if (Number(normalized.amount) !== Number(source.amountPaise)) {
            const { Payment } = await import("../models/index.js");
            await Payment.updateOne(
              { _id: source.paymentId },
              {
                $set: {
                  status: "AMOUNT_MISMATCH_PENDING_REVIEW",
                  requiresReview: true,
                  reviewReason: "GATEWAY_AMOUNT_MISMATCH",
                  providerPayload: payload,
                },
              },
            );
            await Alert.findOneAndUpdate(
              {
                tenantId: event.tenantId,
                type: "GATEWAY_AMOUNT_MISMATCH",
                entityId: source.paymentId,
                status: "OPEN",
              },
              {
                $setOnInsert: {
                  branchId: source.branchId,
                  severity: "CRITICAL",
                  title: "Gateway amount mismatch",
                  message: "A verified gateway callback amount did not match the reserved payment amount.",
                  entityType: "PAYMENT",
                  metadata: {
                    expectedPaise: source.amountPaise,
                    receivedPaise: normalized.amount,
                  },
                },
              },
              { upsert: true },
            );
            if (intent?.status === "PENDING") {
              intent.status = "FAILED";
              intent.version += 1;
              await intent.save();
              await Scheme.updateOne(
                { _id: intent.schemeId },
                { $inc: { positionVersion: 1, version: 1 } },
              );
            }
            event.status = "COMPLETED";
            event.processedAt = new Date();
            await event.save();
            return;
          }
          const lateSuccess = intent
            ? intent.status !== "PENDING"
            : !["CREATED", "SENT", "OPENED"].includes(link.status);
          const fakeReq = {
            auth: { id: "phonepe", tenantId: event.tenantId, type: "WEBHOOK" },
            scope: { tenantId: event.tenantId },
            body: {
              schemeId: source.schemeId,
              amountPaise: source.amountPaise,
              mode: "ONLINE_GATEWAY",
              targetCycle: source.targetCycle,
              positionVersion: source.positionVersion,
            },
            query: { targetCycle: source.targetCycle },
            baseUrl: "/webhooks",
            traceId: event._id,
            ip: "provider",
            headers: {},
          };
          const payment = await recordPayment(fakeReq, {
            gateway: true,
            source: "WEBHOOK",
            actorType: "WEBHOOK",
            existingPaymentId: source.paymentId,
            providerTransactionId: transactionId,
            providerPayload: payload,
            lateSuccess,
            lateSuccessDetectedVia: lateSuccess ? "WEBHOOK" : undefined,
            gatewayCompletedAt: new Date(),
          });
          if (intent) {
            intent.status = "SUCCEEDED";
            intent.paymentId = payment._id;
            await intent.save();
          }
          if (link) {
            link.status = "PAID";
            link.paidAt = new Date();
            await link.save();
            if (link.paymentIntentId) {
              await PaymentIntent.updateOne(
                { _id: link.paymentIntentId },
                { $set: { status: "SUCCEEDED", paymentId: payment._id }, $inc: { version: 1 } },
              );
            }
          }
        } else {
          await Alert.findOneAndUpdate(
            {
              tenantId: event.tenantId,
              type: "GATEWAY_WEBHOOK_UNMATCHED",
              entityId: reference ?? event._id,
              status: "OPEN",
            },
            {
              $setOnInsert: {
                severity: "CRITICAL",
                title: "Unmatched gateway webhook",
                message: "A completed gateway callback did not match any payment intent or link.",
                entityType: "WEBHOOK",
                metadata: {
                  provider: event.provider,
                  reference,
                  amount: normalized.amount,
                },
              },
            },
            { upsert: true },
          );
        }
      } else if (normalized.failed) {
        const pending = await (await import("../models/index.js")).Payment.findOneAndUpdate(
          {
            tenantId: event.tenantId,
            $or: [
              { providerTransactionId: reference },
              { providerTransactionId: transactionId },
              { receiptNumber: `PENDING-${reference}` },
            ],
            status: "PENDING",
          },
          { $set: { status: "FAILED", providerPayload: payload } },
          { new: true },
        );
        if (pending) {
          const intent = await PaymentIntent.findOneAndUpdate(
            { tenantId: event.tenantId, paymentId: pending._id, status: "PENDING" },
            { $set: { status: "FAILED" }, $inc: { version: 1 } },
            { new: true },
          );
          if (intent) {
            await Scheme.updateOne(
              { _id: intent.schemeId },
              { $inc: { positionVersion: 1, version: 1 } },
            );
          }
        }
      }
    } else if (event.provider === "WHATSAPP") {
      const status = event.payload?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
      if (status) await updateDelivery(status.id, status.status?.toUpperCase(), status.errors?.[0]);
    }
    event.status = "COMPLETED"; event.processedAt = new Date(); await event.save();
  } catch (error) { event.status = job.attemptsMade >= 4 ? "DEAD_LETTER" : "FAILED"; event.error = error.message; await event.save(); if (event.status === "DEAD_LETTER") await Alert.findOneAndUpdate({ tenantId: event.tenantId, type: "WEBHOOK_FAILURE", entityId: event._id, status: "OPEN" }, { $setOnInsert: { severity: "CRITICAL", title: "Webhook processing failed", message: error.message, entityType: "WEBHOOK", metadata: { provider: event.provider } } }, { upsert: true }); throw error; }
}
export async function processOutbox(job) {
  const event = await OutboxEvent.findById(job.data.outboxEventId);
  if (!event || event.status === "COMPLETED") return;
  if (event.topic === "payment.succeeded") {
    const customer = await Customer.findOne({ _id: event.payload.customerId, tenantId: event.tenantId }).select("mobile whatsappOptedOutAt").lean();
    const exists = await Message.exists({ tenantId: event.tenantId, type: "PAYMENT_SUCCESS", "templateParams.paymentId": event.payload.paymentId });
    if (customer && !customer.whatsappOptedOutAt && !exists) {
      await queueMessage(
        { auth: { id: "outbox-worker", tenantId: event.tenantId, type: "SYSTEM" }, scope: { tenantId: event.tenantId, branchId: event.payload.branchId }, headers: {}, ip: "worker" },
        { branchId: event.payload.branchId, customerId: event.payload.customerId, schemeId: event.payload.schemeId, type: "PAYMENT_SUCCESS", templateKey: "PAYMENT_SUCCESS_MEDIA", templateParams: { paymentId: event.payload.paymentId, mobile: customer.mobile, passbookImageUrl: null, textComponents: [] } },
      );
    }
  } else if (event.topic !== "message.send") {
    event.status = "DEAD_LETTER";
    event.error = `Unhandled outbox topic: ${event.topic}`;
    await event.save();
    await Alert.findOneAndUpdate(
      { tenantId: event.tenantId, type: "SYSTEM_ERROR", entityId: String(event._id), status: "OPEN" },
      { $setOnInsert: { severity: "CRITICAL", title: "Unknown outbox topic", message: event.error, entityType: "OUTBOX_EVENT", metadata: { topic: event.topic } } },
      { upsert: true },
    );
    logger.error({ outboxEventId: event._id, topic: event.topic }, "Unknown outbox topic moved to dead letter");
    return;
  }
  event.status = "COMPLETED";
  event.processedAt = new Date();
  await event.save();
}
async function writeExportCsv(tempFile, headers, rows) {
  const output = createWriteStream(tempFile, { encoding: "utf8" });
  output.write(`${headers.map(csvCell).join(",")}\n`);
  for (const row of rows) {
    const line = row.map(csvCell).join(",");
    if (!output.write(`${line}\n`)) await once(output, "drain");
  }
  output.end();
  await once(output, "finish");
}

async function writeRawModelExport(record, tempFile) {
  const models = await import("../models/index.js");
  const model = record.type === "AUDIT"
    ? models.AuditEvent
    : record.type === "CUSTOMER"
      ? models.Customer
      : models.Scheme;
  const dateField = record.type === "AUDIT" ? "occurredAt" : "createdAt";
  const query = { tenantId: record.tenantId };
  for (const key of ["branchId", "status", "customerId", "schemeId", "mode"]) {
    if (record.filters?.[key]) query[key] = record.filters[key];
  }
  if (record.filters?.from || record.filters?.to) {
    query[dateField] = {
      ...(record.filters.from ? { $gte: new Date(`${record.filters.from}T00:00:00+05:30`) } : {}),
      ...(record.filters.to ? { $lte: new Date(`${record.filters.to}T23:59:59.999+05:30`) } : {}),
    };
  }
  const output = createWriteStream(tempFile, { encoding: "utf8" });
  let columns;
  let rowCount = 0;
  for await (const row of model.find(query).lean().cursor()) {
    if (!columns) {
      columns = Object.keys(row);
      output.write(`${columns.map(csvCell).join(",")}\n`);
    }
    const line = columns.map((key) => csvCell(row[key])).join(",");
    if (!output.write(`${line}\n`)) await once(output, "drain");
    rowCount += 1;
  }
  if (!columns) output.write("\n");
  output.end();
  await once(output, "finish");
  return rowCount;
}

async function writePdf(tempFile, title, headers, rows) {
  const output = createWriteStream(tempFile);
  const document = new PDFDocument({ margin: 36, size: "A4", layout: headers.length > 6 ? "landscape" : "portrait" });
  document.pipe(output);
  document.fontSize(16).text(title);
  document.moveDown(0.5).fontSize(8).fillColor("#444444").text(headers.join(" | "));
  document.moveDown(0.5).fillColor("#111111");
  for (const row of rows) {
    if (document.y > document.page.height - 48) document.addPage();
    document.text(row.map((value) => String(value ?? "")).join(" | "), { width: document.page.width - 72 });
  }
  document.end();
  await once(output, "finish");
}

async function writeRawModelPdf(record, tempFile) {
  const models = await import("../models/index.js");
  const model = record.type === "AUDIT" ? models.AuditEvent : record.type === "CUSTOMER" ? models.Customer : models.Scheme;
  const dateField = record.type === "AUDIT" ? "occurredAt" : "createdAt";
  const query = { tenantId: record.tenantId };
  for (const key of ["branchId", "status", "customerId", "schemeId", "mode"]) if (record.filters?.[key]) query[key] = record.filters[key];
  if (record.filters?.from || record.filters?.to) query[dateField] = { ...(record.filters.from ? { $gte: new Date(`${record.filters.from}T00:00:00+05:30`) } : {}), ...(record.filters.to ? { $lte: new Date(`${record.filters.to}T23:59:59.999+05:30`) } : {}) };
  const rows = await model.find(query).lean();
  const headers = rows.length ? Object.keys(rows[0]) : ["No records"];
  await writePdf(tempFile, `${record.type} export`, headers, rows.map((row) => headers.map((key) => typeof row[key] === "object" ? JSON.stringify(row[key]) : row[key])));
  return rows.length;
}

export async function processExport(job) {
  const record = await ExportJob.findById(job.data.exportId);
  if (!record) return;
  record.status = "PROCESSING";
  await record.save();
  try {
    const directory = path.resolve("exports");
    await fs.mkdir(directory, { recursive: true });
    const format = record.filters?.format ?? "CSV";
    const extension = format === "PDF" ? "pdf" : "csv";
    const tempFile = path.join(directory, `${record._id}.${extension}`);
    let rowCount = 0;

    if (isRawExportType(record.type)) {
      rowCount = format === "PDF" ? await writeRawModelPdf(record, tempFile) : await writeRawModelExport(record, tempFile);
    } else if (exportReportKey(record.type)) {
      const built = await buildReportExportRows(record);
      if (format === "PDF") await writePdf(tempFile, `${record.type} report`, built.headers, built.rows);
      else await writeExportCsv(tempFile, built.headers, built.rows);
      rowCount = built.rows.length;
    } else {
      throw new AppError(
        "EXPORT_TYPE_NOT_SUPPORTED",
        `Export type ${record.type} is not supported yet.`,
        501,
        { type: record.type },
      );
    }

    const objectKey = `exports/${record.tenantId}/${record._id}.${extension}`;
    const body = await fs.readFile(tempFile);
    await storageProvider.uploadFile({ objectKey, body, contentType: format === "PDF" ? "application/pdf" : "text/csv; charset=utf-8" });
    await fs.unlink(tempFile).catch(() => {});
    record.objectKey = objectKey;
    record.rowCount = rowCount;
    record.status = "READY";
    record.downloadExpiresAt = new Date(Date.now() + 15 * 60_000);
    await record.save();
  } catch (error) {
    record.status = "FAILED";
    record.error = error.message;
    await record.save();
    throw error;
  }
}
export async function processMaintenance(job) {
  const now = new Date(); const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  if (job.name === "maturity") await Scheme.updateMany({ status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] }, maturityDate: { $lte: today } }, { $set: { status: "MATURED" }, $inc: { version: 1 } });
  if (job.name === "overdue") await Scheme.updateMany({ status: "ACTIVE", paymentPattern: "FIXED", installments: { $elemMatch: { graceEndsAt: { $lt: today }, status: { $in: ["DUE", "PARTIALLY_PAID"] } } } }, { $set: { "installments.$[row].status": "OVERDUE" }, $inc: { version: 1 } }, { arrayFilters: [{ "row.graceEndsAt": { $lt: today }, "row.status": { $in: ["DUE", "PARTIALLY_PAID"] } }] });
  if (job.name === "payment-reminders") {
    const schemes = await Scheme.find({ paymentPattern: "FIXED", status: { $in: ["ACTIVE", "DEFAULTED"] }, installments: { $elemMatch: { $or: [{ dueDate: today, status: { $in: ["DUE", "PARTIALLY_PAID"] } }, { status: "OVERDUE" }] } } }).lean();
    for (const scheme of schemes) {
      const overdue = scheme.installments.some((row) => row.status === "OVERDUE");
      const customer = await Customer.findOne({ _id: scheme.customerId, tenantId: scheme.tenantId }).select("mobile whatsappOptedOutAt").lean();
      if (!customer || customer.whatsappOptedOutAt) continue;
      const type = overdue ? "PAYMENT_OVERDUE" : "PAYMENT_DUE";
      const exists = await Message.exists({ tenantId: scheme.tenantId, schemeId: scheme._id, type, "templateParams.reminderDate": today });
      if (!exists) await queueMessage(
        { auth: { id: "reminder-worker", tenantId: scheme.tenantId, type: "SYSTEM" }, scope: { tenantId: scheme.tenantId, branchId: scheme.branchId }, headers: {}, ip: "worker" },
        { branchId: scheme.branchId, customerId: scheme.customerId, schemeId: scheme._id, type, templateKey: type, templateParams: { mobile: customer.mobile, reminderDate: today, enrollmentNumber: scheme.enrollmentNumber } },
      );
    }
  }
  if (job.name === "expire-flexible-capacity") await Scheme.updateMany({ paymentPattern: "FLEXIBLE", cycles: { $elemMatch: { expiresAt: { $lt: today }, status: { $in: ["UPCOMING", "PARTIALLY_PAID"] } } } }, { $set: { "cycles.$[row].status": "EXPIRED", "cycles.$[row].remainingPaise": 0 }, $inc: { positionVersion: 1, version: 1 } }, { arrayFilters: [{ "row.expiresAt": { $lt: today }, "row.status": { $in: ["UPCOMING", "PARTIALLY_PAID"] } }] });
  if (job.name === "defaulting") {
    const candidates = await Scheme.find({ status: "ACTIVE", paymentPattern: "FIXED" }).lean();
    for (const scheme of candidates) {
      const threshold = scheme.planSnapshot?.benefit?.eligibility?.maxAllowedDefaults;
      if (threshold == null) continue;
      const overdueCount = (scheme.installments ?? []).filter((row) => row.status === "OVERDUE").length;
      if (overdueCount === 0 || overdueCount <= threshold) continue;
      const updated = await Scheme.findOneAndUpdate(
        { _id: scheme._id, status: "ACTIVE" },
        { $set: { status: "DEFAULTED" }, $inc: { version: 1 } },
        { new: true },
      );
      if (!updated) continue;
      await writeAudit({
        req: { auth: { id: "scheduler", tenantId: scheme.tenantId, type: "SYSTEM" }, headers: {}, ip: "scheduler" },
        action: "SCHEME_DEFAULTED",
        entityType: AuditEntityType.SCHEME,
        entityId: scheme._id,
        before: scheme,
        after: updated.toObject(),
        actorType: "SYSTEM",
      });
    }
  }
  if (job.name === "apply-flexible-locks") {
    const { applyFlexibleLock } = await import("../services/scheme.service.js");
    const schemes = await Scheme.find({ paymentPattern: "FLEXIBLE", flexiblePhase: "FLEXIBLE", status: { $in: ["ACTIVE", "LOCKED"] } }).lean();
    for (const scheme of schemes) {
      const freeCycles = scheme.planSnapshot?.flexibleRules?.flexiblePhaseCycles ?? 0;
      if (!freeCycles) continue;
      const boundary = addMonthsClamped(scheme.startDate, freeCycles).format("YYYY-MM-DD");
      if (today < boundary) continue;
      try {
        await applyFlexibleLock({
          auth: { id: "scheduler", tenantId: scheme.tenantId, type: "SYSTEM" },
          scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
          params: { schemeId: scheme._id },
          headers: {},
          ip: "scheduler",
        });
      } catch (error) {
        if (error?.code !== "LOCK_ALREADY_APPLIED") logger.warn({ schemeId: scheme._id, err: error.message }, "Flexible lock job skipped scheme");
      }
    }
  }
  if (job.name === "grievance-auto-close") await Grievance.updateMany({ status: "RESOLVED", resolvedAt: { $lt: new Date(Date.now() - 7 * 86_400_000) } }, { $set: { status: "CLOSED", closedAt: now }, $inc: { version: 1 } });
  if (job.name === "expire-payments") { const intents = await PaymentIntent.find({ status: "PENDING", reservationExpiresAt: { $lt: now } }).lean(); for (const intent of intents) { const claimed = await PaymentIntent.findOneAndUpdate({ _id: intent._id, status: "PENDING" }, { $set: { status: "EXPIRED" }, $inc: { version: 1 } }, { new: true }); if (claimed) { if (intent.paymentId) await (await import("../models/index.js")).Payment.updateOne({ _id: intent.paymentId, status: "PENDING" }, { $set: { status: "FAILED", providerPayload: { expirationReason: "INTENT_TTL" } } }); await Scheme.updateOne({ _id: intent.schemeId }, { $inc: { positionVersion: 1, version: 1 } }); } } await PaymentLink.updateMany({ status: { $in: ["CREATED", "SENT", "OPENED"] }, expiresAt: { $lt: now } }, { $set: { status: "EXPIRED" } }); }
}
