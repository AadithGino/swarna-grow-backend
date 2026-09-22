import { canonicalMobile } from "../lib/mobile.js";
import { paginate } from "../lib/pagination.js";
import { errors } from "../lib/app-error.js";
import { Customer, InboundMessage } from "../models/index.js";
import { InboundMessageStatus } from "../models/inbound-message.model.js";

const MAX_INBOUND_TEXT_LENGTH = 4096;
const MAX_MEDIA_METADATA_JSON = 2000;

function boundText(value) {
  if (value == null) return null;
  return String(value).slice(0, MAX_INBOUND_TEXT_LENGTH);
}

function boundMediaMetadata(value) {
  if (!value || typeof value !== "object") return null;
  const json = JSON.stringify(value);
  if (json.length > MAX_MEDIA_METADATA_JSON) return null;
  return value;
}

export function sanitizeInboundMessage(row) {
  if (!row) return row;
  const {
    webhookEventId: _webhookEventId,
    providerMetadata,
    ...rest
  } = row;
  return {
    ...rest,
    providerMetadata: providerMetadata?.waId ? { waId: providerMetadata.waId } : undefined,
  };
}

function extractWhatsAppInbound(payload) {
  const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages;
  if (!Array.isArray(messages) || !messages.length) return [];
  return messages.map((message) => ({
    providerMessageId: message.id,
    senderMobile: message.from,
    messageType: message.type ?? "unknown",
    text: boundText(message.text?.body),
    mediaMetadata: boundMediaMetadata(message.image || message.document || message.audio || message.video
      ? {
        kind: message.type,
        id: message[message.type]?.id ?? null,
        mimeType: message[message.type]?.mime_type ?? null,
      }
      : null),
    receivedAt: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date(),
    providerMetadata: { waId: message.from },
  }));
}

export async function persistWhatsAppInboundFromWebhook({ tenantId, webhookEventId, payload }) {
  const rows = extractWhatsAppInbound(payload);
  if (!rows.length) return { created: 0 };
  let created = 0;
  for (const row of rows) {
    const senderMobile = canonicalMobile(row.senderMobile);
    const customer = await Customer.findOne({ tenantId, mobile: senderMobile })
      .select("_id branchId")
      .lean();
    const doc = {
      tenantId,
      branchId: customer?.branchId,
      providerMessageId: row.providerMessageId,
      customerId: customer?._id,
      senderMobile,
      messageType: row.messageType,
      text: row.text,
      mediaMetadata: row.mediaMetadata,
      receivedAt: row.receivedAt,
      status: customer ? InboundMessageStatus.RECEIVED : InboundMessageStatus.UNMATCHED,
      webhookEventId,
      providerMetadata: row.providerMetadata,
    };
    const result = await InboundMessage.updateOne(
      { tenantId, providerMessageId: row.providerMessageId },
      { $setOnInsert: doc },
      { upsert: true },
    );
    if (result.upsertedCount) created += 1;
  }
  return { created };
}

export async function listInboundMessages(req) {
  const filters = { tenantId: req.auth.tenantId };
  if (req.scope.branchId) filters.branchId = req.scope.branchId;
  if (req.query.branchId) filters.branchId = req.query.branchId;
  if (req.query.customerId) filters.customerId = req.query.customerId;
  if (req.query.status) filters.status = req.query.status;
  if (req.query.q) {
    const q = String(req.query.q).trim();
    if (q) {
      filters.$or = [{ senderMobile: q }, { text: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }];
    }
  }
  const page = await paginate(InboundMessage, {
    filters,
    cursor: req.query.cursor,
    limit: Math.min(Number(req.query.limit ?? 25), 100),
    sort: "receivedAt:desc",
  });
  return {
    data: page.data.map((row) => sanitizeInboundMessage(row)),
    meta: page.meta,
  };
}

export async function getInboundMessage(req) {
  const row = await InboundMessage.findOne({
    _id: req.params.id,
    tenantId: req.auth.tenantId,
    ...(req.scope.branchId ? { branchId: req.scope.branchId } : {}),
  }).lean();
  if (!row) throw errors.notFound("Inbound message");
  return sanitizeInboundMessage(row);
}

export async function markInboundMessageRead(req) {
  const row = await InboundMessage.findOneAndUpdate(
    {
      _id: req.params.id,
      tenantId: req.auth.tenantId,
      ...(req.scope.branchId ? { branchId: req.scope.branchId } : {}),
    },
    {
      $set: {
        status: InboundMessageStatus.READ,
        readAt: new Date(),
        readBy: req.auth.id,
      },
    },
    { new: true },
  ).lean();
  if (!row) throw errors.notFound("Inbound message");
  return sanitizeInboundMessage(row);
}
