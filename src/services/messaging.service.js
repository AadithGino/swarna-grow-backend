import {
  Customer,
  Message,
  OutboxEvent,
  Payment,
  Scheme,
  Tenant,
} from "../models/index.js";
import { MessageStatus } from "../constants/enums.js";
import { createId } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import { withTransaction } from "../lib/transaction.js";
import { writeAudit } from "./audit.service.js";
import { errors } from "../lib/app-error.js";
import dayjs from "dayjs";
import { env } from "../config/env.js";
import { dateMatch, searchRegex } from "../lib/query-filters.js";

export async function messageBranchScope(req) {
  const scope = { tenantId: req.auth.tenantId };
  const branchId = req.scope.branchId;
  if (!branchId) return scope;

  const [customerRows, schemeRows] = await Promise.all([
    Customer.find({ tenantId: req.auth.tenantId, branchId })
      .select("_id")
      .lean(),
    Scheme.find({ tenantId: req.auth.tenantId, branchId }).select("_id").lean(),
  ]);
  const customerIds = customerRows.map((row) => row._id);
  const schemeIds = schemeRows.map((row) => row._id);
  const or = [{ branchId }];
  if (customerIds.length) or.push({ customerId: { $in: customerIds } });
  if (schemeIds.length) or.push({ schemeId: { $in: schemeIds } });
  scope.$or = or;
  return scope;
}

async function messageMatch(req) {
  const match = await messageBranchScope(req);
  Object.assign(match, dateMatch("createdAt", req.query));
  return match;
}

async function aggregateMessageSummary(req) {
  const match = await messageMatch(req);
  const [statusRows, total] = await Promise.all([
    Message.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Message.countDocuments(match),
  ]);
  const byStatus = Object.fromEntries(
    statusRows.map((row) => [row._id, row.count]),
  );
  const read = Number(byStatus.READ ?? 0);
  let delivered = Number(byStatus.DELIVERED ?? 0);
  const failed = Number(byStatus.FAILED ?? 0);
  const queued = Number(byStatus.QUEUED ?? 0);
  const sentExplicit = Number(byStatus.SENT ?? 0);
  if (env.PROVIDER_MODE === "mock") delivered += sentExplicit;
  const sent = sentExplicit + Number(byStatus.DELIVERED ?? 0) + read + failed || total;
  return {
    sent,
    delivered: delivered + read,
    read,
    failed,
    queued,
    total,
    byStatus,
  };
}

function chartBlocksFromMessages(req, messages) {
  const byDay = new Map();
  for (const row of messages) {
    const day = row.createdAt
      ? new Date(row.createdAt).toLocaleDateString("en-CA", {
          timeZone: "Asia/Kolkata",
        })
      : "—";
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const days = [...byDay.keys()].sort();
  const volumePoints = days.map((x) => ({
    x,
    y: byDay.get(x) ?? 0,
    yDisplay: String(byDay.get(x) ?? 0),
  }));

  const byType = new Map();
  for (const row of messages) {
    const key = row.type ?? "OTHER";
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }
  const typePoints = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([x, y]) => ({ x, y, yDisplay: String(y) }));

  return {
    volumeTrend: {
      chartType: "line",
      title: "Message volume",
      yAxis: { type: "count", label: "Messages" },
      series: [{ key: "VOLUME", name: "Sent", data: volumePoints }],
    },
    deliveryByType: {
      chartType: "bar",
      title: "Messages by type",
      yAxis: { type: "count", label: "Messages" },
      series: [{ key: "TYPE", name: "Count", data: typePoints }],
    },
  };
}

export async function getMessagingSummaryForAdmin(req) {
  const summary = await aggregateMessageSummary(req);
  const monthStart = dayjs().startOf("month").toDate();
  const tenant = await Tenant.findById(req.auth.tenantId)
    .select("subscription")
    .lean();
  const quotaLimit = Number(
    tenant?.subscription?.limits?.whatsappMessages ?? 0,
  );
  const quotaMatch = {
    ...(await messageBranchScope(req)),
    createdAt: { $gte: monthStart },
  };
  const quotaUsed = await Message.countDocuments(quotaMatch);
  const quotaUsedPercent = quotaLimit
    ? Math.min(100, Math.round((quotaUsed / quotaLimit) * 1000) / 10)
    : 0;
  const messages = await Message.find(await messageMatch(req))
    .select("type createdAt status")
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  return {
    ...summary,
    quotaLimit,
    quotaUsed,
    quotaUsedPercent,
    quotaRemaining: Math.max(0, quotaLimit - quotaUsed),
    resetsOn: dayjs().add(1, "month").startOf("month").format("YYYY-MM-DD"),
    periodLabel: req.query.from && req.query.to
      ? `${req.query.from} – ${req.query.to}`
      : "Selected period",
    charts: chartBlocksFromMessages(req, messages),
  };
}

export async function queueMessage(req, payload) {
  return withTransaction(async (session) => {
    const branchId =
      payload.branchId ?? req.scope?.branchId ?? req.auth.branchId ?? null;
    const message = (
      await Message.create(
        [
          {
            _id: createId("message"),
            tenantId: req.auth.tenantId,
            branchId,
            status: MessageStatus.QUEUED,
            channel: "WHATSAPP",
            ...payload,
            branchId: payload.branchId ?? branchId,
          },
        ],
        { session },
      )
    )[0];
    await OutboxEvent.create(
      [
        {
          tenantId: req.auth.tenantId,
          topic: "message.send",
          key: message._id,
          payload: { messageId: message._id, branchId: message.branchId },
        },
      ],
      { session },
    );
    const auditEventId = await writeAudit({
      req,
      action: "MESSAGE_QUEUED",
      entityType: "MESSAGE",
      entityId: message._id,
      after: message.toObject(),
      session,
    });
    return { ...message.toObject(), auditEventId };
  });
}
export async function listMessages(req) {
  const filters = {};
  for (const key of ["status", "type", "customerId", "schemeId", "channel"]) if (req.query[key]) filters[key] = req.query[key];
  Object.assign(filters, dateMatch("createdAt", req.query));
  const pattern = searchRegex(req.query.q);
  if (pattern) {
    const matchedCustomers = await Customer.find({
      tenantId: req.auth.tenantId,
      ...(req.scope.branchId ? { branchId: req.scope.branchId } : {}),
      $or: [{ name: pattern }, { mobile: pattern }, { customerNumber: pattern }],
    }).select("_id").lean();
    filters.$or = [
      { body: pattern },
      { templateKey: pattern },
      { customerId: { $in: matchedCustomers.map((row) => row._id) } },
    ];
  }
  const result = await paginate(Message, {
    scope: await messageBranchScope(req),
    filters,
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: "createdAt:desc",
  });
  const summary = await aggregateMessageSummary(req);
  result.meta = { ...(result.meta ?? {}), summary };
  if (!result.data.length) return result;
  const customerIds = [...new Set(result.data.map((row) => row.customerId).filter(Boolean))];
  const customers = customerIds.length
    ? await Customer.find({ _id: { $in: customerIds } }).select("_id name mobile customerNumber").lean()
    : [];
  const customerMap = new Map(customers.map((row) => [row._id, row]));
  result.data = result.data.map((row) => {
    const customer = customerMap.get(row.customerId);
    return {
      ...row,
      customer: customer
        ? { _id: customer._id, id: customer._id, name: customer.name, mobile: customer.mobile, customerNumber: customer.customerNumber }
        : undefined,
    };
  });
  return result;
}
export async function resendMessage(req) {
  const original = await Message.findOne({
    _id: req.params.messageId ?? req.params.id,
    ...(await messageBranchScope(req)),
  }).lean();
  if (!original) throw errors.notFound("Message");
  return queueMessage(req, {
    branchId: original.branchId,
    customerId: original.customerId,
    schemeId: original.schemeId,
    type: original.type,
    channel: original.channel,
    templateKey: original.templateKey,
    templateParams: original.templateParams,
  });
}

export async function bulkResendMessages(req) {
  const messageIds = [
    ...new Set((req.body.messageIds ?? []).map(String).filter(Boolean)),
  ];
  let queued = 0;
  const skipped = [];
  for (const messageId of messageIds) {
    try {
      await resendMessage({ ...req, params: { ...req.params, messageId } });
      queued += 1;
    } catch (err) {
      skipped.push({
        messageId,
        reason: err?.code ?? "FAILED",
      });
    }
  }
  return { queued, accepted: queued, skipped };
}

export async function getMessageForAdmin(req) {
  const row = await Message.findOne({
    _id: req.params.messageId ?? req.params.id,
    ...(await messageBranchScope(req)),
  }).lean();
  if (!row) throw errors.notFound("Message");
  return row;
}
export async function updateDelivery(providerMessageId, status, details = {}) { return Message.findOneAndUpdate({ providerMessageId }, { $set: { status, ...(status === "DELIVERED" ? { deliveredAt: new Date() } : {}), ...(status === "READ" ? { readAt: new Date() } : {}), ...(status === "FAILED" ? { failedAt: new Date(), failureCode: details.code, failureMessage: details.message } : {}) } }, { new: true }); }
export async function sharePayment(req) { const payment = await Payment.findOne({ _id: req.params.paymentId, ...req.scope }).lean(); if (!payment) throw errors.notFound("Payment"); const customer = await Customer.findOne({ _id: payment.customerId, tenantId: payment.tenantId }).select("mobile whatsappOptedOutAt").lean(); if (!customer || customer.whatsappOptedOutAt) throw errors.business("WHATSAPP_OPTED_OUT", "The customer has opted out of WhatsApp messages."); return queueMessage(req, { branchId: payment.branchId, customerId: payment.customerId, schemeId: payment.schemeId, type: "PAYMENT_SUCCESS", channel: "WHATSAPP", templateKey: "PAYMENT_SUCCESS_MEDIA", templateParams: { mobile: customer.mobile, paymentId: payment._id, passbookImageUrl: null, textComponents: [] } }); }
