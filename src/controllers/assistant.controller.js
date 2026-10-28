import { AppError } from "../lib/app-error.js";
import { sendList, sendSuccess } from "../lib/response.js";
import { validateAssistantAction } from "../validators/assistant.validators.js";
import { handleChat } from "../services/assistant/assistant.service.js";
import { streamDataQueryExportToResponse } from "../services/assistant/agent/agent-export.service.js";
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

/**
 * Streaming chat (Server-Sent Events): live "thinking" steps while tools run, then the final bundle.
 * Events: step {id,label,status,detail?} · final {bundle} · error {code,message}
 */
export async function chatStream(req, res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  const send = (event, data) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.flush?.();
  };
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) {
      res.write(": keep-alive\n\n");
      res.flush?.();
    }
  }, 15_000);

  try {
    const bundle = await handleChat(req, {
      message: req.body.message,
      conversationId: req.body.conversationId,
      onEvent: (event) => send(event.type ?? "step", event),
    });
    send("final", bundle);
  } catch (err) {
    const status = err instanceof AppError ? err.statusCode : 500;
    send("error", {
      code: err instanceof AppError ? err.code : "ASSISTANT_STREAM_FAILED",
      message: err instanceof AppError && status < 500 ? err.message : "Sidekick could not finish that answer. Please try again.",
      status,
    });
    if (!(err instanceof AppError) || status >= 500) req.log?.error?.({ err }, "assistant stream failed");
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}

export async function exportResult(req, res) {
  const { fields, format } = req.body;
  if (req.body.action?.kind === "dataQuery") {
    await streamDataQueryExportToResponse(req, res, req.body.action.spec, { fields, format });
    return;
  }
  const action = validateAssistantAction(req.body.action);
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
