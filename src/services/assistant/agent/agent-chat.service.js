/**
 * Chat endpoint glue for the agent engine: conversation history, daily cap, short-lived
 * cache for repeated opening questions, persistence, usage + audit.
 */
import crypto from "node:crypto";
import { getRedis, redisReady } from "../../../config/redis.js";
import { AppError } from "../../../lib/app-error.js";
import { now } from "../../../lib/date.js";
import { writeAudit } from "../../audit.service.js";
import { appendTurn, getOrCreateConversation, loadRecentContext } from "../assistant-history.service.js";
import { assistantDataScope } from "../query-compiler.js";
import { assertAgentAvailable, runAgentTurn } from "./agent.service.js";
import { geminiAgentTestHookActive } from "../../../integrations/llm/gemini-agent.js";
import { recordUsage, reserveDailyQuestion } from "./usage.js";
import { AssistantUsageDaily } from "../../../models/assistant.models.js";
import { today } from "../../../lib/date.js";
import { env } from "../../../config/env.js";

const CACHE_TTL_SEC = 120;
const TRANSIENT_CODES = new Set(["ASSISTANT_LLM_TIMEOUT", "ASSISTANT_LLM_ERROR", "ASSISTANT_LLM_EMPTY", "ASSISTANT_LLM_PARSE"]);

function cacheKey(req, message) {
  const scope = assistantDataScope(req);
  const normalized = String(message).trim().toLowerCase().replace(/\s+/g, " ");
  const hash = crypto
    .createHash("sha256")
    .update(`${normalized}|${env.ASSISTANT_MODEL}|${now().format("YYYY-MM-DD")}`)
    .digest("hex")
    .slice(0, 24);
  return `assistant:agent:v1:${scope.tenantId}:${scope.branchId ?? "all"}:${req.auth?.role ?? ""}:${hash}`;
}

async function readCache(key) {
  if (!redisReady()) return null;
  try {
    const raw = await getRedis().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeCache(key, bundle) {
  if (!redisReady()) return;
  try {
    await getRedis().set(key, JSON.stringify({ ...bundle, _cachedAt: new Date().toISOString() }), "EX", CACHE_TTL_SEC);
  } catch {
    /* cache is best-effort */
  }
}

function stripTransient(bundle) {
  const out = { ...bundle };
  delete out.messageId;
  delete out.conversationId;
  delete out.cached;
  delete out.cacheAgeSeconds;
  delete out._cachedAt;
  return out;
}

function transientBundle(message) {
  return {
    engine: "agent",
    summaryText: "Sidekick",
    narrative: message,
    statCards: [],
    chart: null,
    table: null,
    vizHint: "agent-text",
    blocks: [],
    steps: [],
    followUps: [],
    transientError: true,
  };
}

/**
 * @param {object} req
 * @param {{ message: string, conversationId?: string|null, onEvent?: (e: object) => void }} input
 */
export async function handleAgentChat(req, { message: rawMessage, conversationId: bodyConversationId, onEvent } = {}) {
  const message = String(rawMessage ?? "").trim();
  if (!message) throw new AppError("ASSISTANT_EMPTY_MESSAGE", "Type a question first.", 422);
  if (!geminiAgentTestHookActive()) assertAgentAvailable();
  const scope = assistantDataScope(req);
  const conversation = await getOrCreateConversation(req, bodyConversationId ?? null);
  const conversationId = conversation._id;
  const history = conversation.messageCount > 0 ? await loadRecentContext(req, conversationId, 8) : [];

  // Only the opening question of a chat is cacheable — follow-ups depend on context.
  const key = history.length ? null : cacheKey(req, message);
  if (key) {
    const cached = await readCache(key);
    if (cached) {
      const cachedAtMs = Date.parse(String(cached._cachedAt ?? ""));
      const bundle = stripTransient(cached);
      const { assistantMessageId } = await appendTurn(req, conversationId, message, bundle);
      return {
        ...clientView(bundle),
        cached: true,
        cacheAgeSeconds: Number.isFinite(cachedAtMs) ? Math.max(0, Math.floor((Date.now() - cachedAtMs) / 1000)) : undefined,
        conversationId,
        messageId: assistantMessageId,
      };
    }
  }

  await reserveDailyQuestion(scope.tenantId);

  let turn;
  try {
    turn = await runAgentTurn({ req, message, history, onEvent });
  } catch (err) {
    if (err instanceof AppError && TRANSIENT_CODES.has(err.code)) {
      await AssistantUsageDaily.updateOne({ tenantId: scope.tenantId, day: today() }, { $inc: { questions: -1 } }).catch(() => {});
      req.log?.warn?.({ err }, "assistant agent transient failure");
      const bundle = transientBundle("I had trouble reaching the AI service just now — please try again in a moment.");
      const { assistantMessageId } = await appendTurn(req, conversationId, message, bundle);
      return { ...bundle, cached: false, conversationId, messageId: assistantMessageId };
    }
    throw err;
  }

  const bundle = { ...turn.bundle, asOf: now().toISOString() };
  const { assistantMessageId } = await appendTurn(req, conversationId, message, bundle);
  await Promise.all([
    recordUsage(scope.tenantId, turn.usage, { model: turn.model, toolCalls: turn.toolCalls }).catch(() => {}),
    key && !bundle.needsClarification ? writeCache(key, bundle) : null,
    writeAudit({
      req,
      action: "ASSISTANT_CHAT",
      entityType: "TENANT",
      entityId: scope.tenantId,
      metadata: {
        engine: "agent",
        model: turn.model,
        tools: (bundle.steps ?? []).map((s) => s.tool),
        llmCalls: turn.usage.llmCalls,
        promptTokens: turn.usage.promptTokens,
        outputTokens: turn.usage.outputTokens,
        costUsd: bundle.usage?.costUsd,
        questionLength: message.length,
      },
    }).catch(() => {}),
  ]);

  return { ...clientView(bundle), cached: false, conversationId, messageId: assistantMessageId };
}

/** Internal turn memory and token usage stay server-side. */
function clientView(bundle) {
  const { memory: _memory, usage: _usage, ...rest } = bundle;
  return rest;
}
