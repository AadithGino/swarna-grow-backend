import { AppError } from "../lib/app-error.js";
import { sendList, sendSuccess } from "../lib/response.js";
import { validateAssistantAction } from "../validators/assistant.validators.js";
import { handleChat } from "../services/assistant/assistant.service.js";
import {
  exportReportAction,
  streamCollectionDailyExportToResponse,
  streamQueryExportToResponse,
} from "../services/assistant/assistant-export.service.js";
import {
  deleteConversation,
  listConversations,
  listMessages,
  messageToClient,
  renameConversation,
} from "../services/assistant/assistant-history.service.js";

export async function chat(req, res) {
  const bundle = await handleChat(req, {
    message: req.body.message,
    conversationId: req.body.conversationId,
  });
  return sendSuccess(res, bundle);
}

export async function exportResult(req, res) {
  const action = validateAssistantAction(req.body.action);
  const { fields, format } = req.body;
  if (action.kind === "query") {
    await streamQueryExportToResponse(req, res, action.spec, { fields, format });
    return;
  }
  if (action.kind === "report") {
    const job = await exportReportAction(req, action, format);
    return sendSuccess(res, job, {}, 202);
  }
  if (action.kind === "collectionDaily") {
    await streamCollectionDailyExportToResponse(req, res, action, { fields, format });
    return;
  }
  throw new AppError(
    "ASSISTANT_EXPORT_UNSUPPORTED",
    "Only query or report answers can be exported.",
    422,
  );
}

export async function getConversations(req, res) {
  const { cursor, limit } = req.query;
  const page = await listConversations(req, { cursor, limit });
  return sendList(res, page);
}

export async function getMessages(req, res) {
  const { cursor, limit } = req.query;
  const page = await listMessages(req, req.params.id, { cursor, limit });
  return sendList(res, {
    data: page.data.map(messageToClient),
    meta: page.meta,
  });
}

export async function removeConversation(req, res) {
  const result = await deleteConversation(req, req.params.id);
  return sendSuccess(res, result);
}

export async function patchConversation(req, res) {
  const result = await renameConversation(req, req.params.id, req.body.title);
  return sendSuccess(res, result);
}
