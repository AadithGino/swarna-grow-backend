import { AppError } from "../../lib/app-error.js";
import { paginate } from "../../lib/pagination.js";
import {
  AssistantConversation,
  AssistantMessage,
  AssistantRole,
} from "../../models/assistant.models.js";
import { normalizeConversationFocus } from "./conversation-focus.js";

function historyScope(req) {
  return {
    tenantId: req.auth.tenantId,
    userId: req.auth.id,
  };
}

function shapeHistoryRow(row) {
  if (row.role === AssistantRole.USER) {
    return { role: "user", text: row.text ?? "" };
  }
  const bundle = row.bundle ?? {};
  return {
    role: "assistant",
    summary: bundle.summaryText,
    action: bundle.action,
  };
}

export async function getOwnedConversation(req, conversationId) {
  const scope = historyScope(req);
  const conv = await AssistantConversation.findOne({
    _id: conversationId,
    tenantId: scope.tenantId,
    userId: scope.userId,
  }).lean();
  if (!conv) {
    throw new AppError(
      "ASSISTANT_CONVERSATION_NOT_FOUND",
      "Conversation not found.",
      404,
    );
  }
  return conv;
}

export async function getOrCreateConversation(req, conversationId) {
  const scope = historyScope(req);
  if (conversationId) {
    return getOwnedConversation(req, conversationId);
  }
  const created = await AssistantConversation.create({
    tenantId: scope.tenantId,
    userId: scope.userId,
  });
  return created.toObject();
}

export async function listConversations(req, { cursor, limit } = {}) {
  const scope = historyScope(req);
  return paginate(AssistantConversation, {
    scope,
    cursor,
    limit,
    sort: "lastMessageAt:desc",
  });
}

export async function listMessages(req, conversationId, { cursor, limit } = {}) {
  const scope = historyScope(req);
  await getOwnedConversation(req, conversationId);
  return paginate(AssistantMessage, {
    scope,
    filters: { conversationId },
    cursor,
    limit,
    sort: "createdAt:desc",
  });
}

export async function loadConversationFocus(req, conversationId) {
  const conv = await getOwnedConversation(req, conversationId);
  return normalizeConversationFocus(conv.conversationFocus);
}

export async function loadLastResolvedPlan(req, conversationId) {
  const conv = await getOwnedConversation(req, conversationId);
  const plan = conv.lastResolvedPlan;
  return plan && typeof plan === "object" ? plan : null;
}

export async function saveLastResolvedPlan(req, conversationId, plan) {
  const scope = historyScope(req);
  const next = plan && typeof plan === "object" ? plan : null;
  const update = next
    ? { $set: { lastResolvedPlan: next } }
    : { $unset: { lastResolvedPlan: "" } };
  await AssistantConversation.updateOne(
    { _id: conversationId, tenantId: scope.tenantId, userId: scope.userId },
    update,
  );
  return next;
}

export async function saveConversationFocus(req, conversationId, focus) {
  const scope = historyScope(req);
  const next = normalizeConversationFocus(focus);
  const update = next ? { $set: { conversationFocus: next } } : { $unset: { conversationFocus: "" } };
  await AssistantConversation.updateOne(
    { _id: conversationId, tenantId: scope.tenantId, userId: scope.userId },
    update,
  );
  return next;
}

export async function loadRecentContext(req, conversationId, n = 10) {
  const scope = historyScope(req);
  await getOwnedConversation(req, conversationId);
  const rows = await AssistantMessage.find({
    tenantId: scope.tenantId,
    userId: scope.userId,
    conversationId,
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(n)
    .lean();
  return rows.reverse().map(shapeHistoryRow);
}

export async function appendTurn(req, conversationId, userText, bundle) {
  const scope = historyScope(req);
  const conversation = await getOwnedConversation(req, conversationId);
  const now = new Date();
  const trimmed = String(userText ?? "").trim();

  const userDoc = await AssistantMessage.create({
    tenantId: scope.tenantId,
    userId: scope.userId,
    conversationId: conversation._id,
    role: AssistantRole.USER,
    text: trimmed,
  });

  const assistantDoc = await AssistantMessage.create({
    tenantId: scope.tenantId,
    userId: scope.userId,
    conversationId: conversation._id,
    role: AssistantRole.ASSISTANT,
    bundle,
  });

  const setFields = { lastMessageAt: now };
  const isFirstTitle =
    !conversation.messageCount &&
    (!conversation.title || conversation.title === "New chat");
  if (isFirstTitle && trimmed) {
    setFields.title = trimmed.slice(0, 60);
  }

  await AssistantConversation.updateOne(
    { _id: conversation._id, tenantId: scope.tenantId, userId: scope.userId },
    {
      $set: setFields,
      $inc: { messageCount: 2 },
    },
  );

  return {
    userMessageId: userDoc._id,
    assistantMessageId: assistantDoc._id,
  };
}

export async function deleteConversation(req, conversationId) {
  const scope = historyScope(req);
  await getOwnedConversation(req, conversationId);
  await AssistantMessage.deleteMany({
    tenantId: scope.tenantId,
    userId: scope.userId,
    conversationId,
  });
  await AssistantConversation.deleteOne({
    _id: conversationId,
    tenantId: scope.tenantId,
    userId: scope.userId,
  });
  return { deleted: true };
}

export async function renameConversation(req, conversationId, title) {
  const scope = historyScope(req);
  await getOwnedConversation(req, conversationId);
  const nextTitle = String(title ?? "").trim().slice(0, 120);
  if (!nextTitle) {
    throw new AppError("ASSISTANT_INVALID_TITLE", "Title is required.", 422);
  }
  await AssistantConversation.updateOne(
    { _id: conversationId, tenantId: scope.tenantId, userId: scope.userId },
    { $set: { title: nextTitle } },
  );
  return { id: conversationId, title: nextTitle };
}

export function messageToClient(row) {
  if (row.role === AssistantRole.USER) {
    return {
      id: row._id,
      role: "user",
      text: row.text ?? "",
      createdAt: row.createdAt,
    };
  }
  return {
    id: row._id,
    role: "assistant",
    bundle: row.bundle ?? {},
    createdAt: row.createdAt,
  };
}
