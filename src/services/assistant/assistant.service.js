import crypto from "node:crypto";
import { getRedis, redisReady } from "../../config/redis.js";
import { now } from "../../lib/date.js";
import { AppError } from "../../lib/app-error.js";
import { CLARIFY_TRANSIENT, interpret, narrate } from "../../integrations/llm/provider.js";
import { buildAdminReport } from "../report-builders/index.js";
import { assertReportRange } from "../report-builders/report-envelope.js";
import { writeAudit } from "../audit.service.js";
import { toolCatalogForPrompt } from "./schema-registry.js";
import { assistantDataScope, compileQuerySpec, runCompiledQuery } from "./query-compiler.js";
import {
  bundleFromClarify,
  bundleFromComposite,
  bundleFromQuery,
  bundleFromReport,
  bundleFromUnsupported,
  factsFromBundle,
  factsFromComposite,
} from "./response-bundle.js";
import { lastAssistantAction, resolveActionWithHistory } from "./follow-up.js";
import { normalizeAssistantQuestion } from "./normalize-question.js";
import { refineQueryAction } from "./refine-query.js";
import {
  appendTurn,
  getOrCreateConversation,
  loadRecentContext,
} from "./assistant-history.service.js";

const CACHE_TTL_SEC = 120;

function normalizeQuestion(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function historyContextFingerprint(history = []) {
  const a = lastAssistantAction(history);
  if (!a) return "";
  if (a.kind === "composite") {
    const keys = (a.reports ?? []).map((r) => r.reportKey).join("+");
    return `c:${keys}`;
  }
  if (a.kind === "report") {
    const f = a.filters ?? {};
    return `r:${a.reportKey}:${f.period ?? ""}:${f.from ?? ""}:${f.to ?? ""}`;
  }
  if (a.kind === "query") {
    const s = a.spec ?? {};
    return `q:${s.entity ?? ""}:${s.period ?? ""}:${s.from ?? ""}:${s.to ?? ""}`;
  }
  return String(a.kind ?? "");
}

export function assistantCacheKey(req, question, history = []) {
  const scope = assistantDataScope(req);
  const role = req.auth?.role ?? "";
  const material = `${normalizeQuestion(question)}|${historyContextFingerprint(history)}`;
  const hash = crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);
  return `assistant:v1:${scope.tenantId}:${scope.branchId ?? "all"}:${role}:${hash}`;
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
    await getRedis().set(key, JSON.stringify(bundle), "EX", CACHE_TTL_SEC);
  } catch {
    /* ignore cache write failures */
  }
}

function buildContext(req) {
  const scope = assistantDataScope(req);
  const todayIst = now().format("YYYY-MM-DD");
  return {
    tenantId: scope.tenantId,
    branchId: scope.branchId,
    role: req.auth?.role,
    todayIst,
  };
}

function reqForReport(req, action) {
  const filters = action.filters ?? {};
  const query = { ...req.query };
  if (filters.period) query.period = filters.period;
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  if (filters.branchId) query.branchId = filters.branchId;
  if (filters.planId) query.planId = filters.planId;
  if (!query.period && !query.from && !query.to) query.period = "THIS_MONTH";
  assertReportRange(query);
  return { ...req, query };
}

async function runReportAction(req, reportAction) {
  const reportReq = reqForReport(req, reportAction);
  const report = await buildAdminReport(reportReq, reportAction.reportKey);
  if (!report) return null;
  return bundleFromReport(report, reportAction);
}

async function executeAction(req, action) {
  if (action.kind === "clarify") {
    return { bundle: bundleFromClarify(action), compositeParts: null };
  }
  if (action.kind === "unsupported") {
    return { bundle: bundleFromUnsupported(action), compositeParts: null };
  }

  if (action.kind === "composite") {
    const parts = [];
    for (const item of action.reports) {
      const part = await runReportAction(req, {
        kind: "report",
        reportKey: item.reportKey,
        filters: item.filters,
      });
      if (part) parts.push(part);
    }
    if (!parts.length) {
      return {
        bundle: bundleFromUnsupported({
          kind: "unsupported",
          reason: "Those reports are not available yet.",
        }),
        compositeParts: null,
      };
    }
    if (parts.length === 1) {
      return { bundle: parts[0], compositeParts: null };
    }
    return { bundle: bundleFromComposite(parts, action), compositeParts: parts };
  }

  if (action.kind === "report") {
    const bundle = await runReportAction(req, action);
    if (!bundle) {
      return {
        bundle: bundleFromUnsupported({
          kind: "unsupported",
          reason: `Report ${action.reportKey} is not available yet.`,
        }),
        compositeParts: null,
      };
    }
    return { bundle, compositeParts: null };
  }

  const scope = assistantDataScope(req);
  const compiled = compileQuerySpec(action.spec, scope);
  const result = await runCompiledQuery(compiled, scope);
  return { bundle: bundleFromQuery(result, action.spec, action), compositeParts: null };
}

export async function handleChat(req, { message: rawMessage, conversationId: bodyConversationId } = {}) {
  const messageRaw = String(rawMessage ?? req.body?.message ?? "").trim();
  const message = normalizeAssistantQuestion(messageRaw);
  const conversation = await getOrCreateConversation(
    req,
    bodyConversationId ?? req.body?.conversationId ?? null,
  );
  const conversationId = conversation._id;

  const trimmedHistory =
    conversation.messageCount > 0
      ? await loadRecentContext(req, conversationId, 10)
      : [];

  const key = assistantCacheKey(req, message, trimmedHistory);
  const cached = await readCache(key);
  if (cached) {
    return {
      ...cached,
      cached: true,
      conversationId,
      messageId: cached.messageId,
    };
  }

  const context = buildContext(req);
  const toolCatalog = toolCatalogForPrompt();
  let action;
  try {
    action = await interpret({
      question: message,
      context,
      toolCatalog,
      history: trimmedHistory,
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "ASSISTANT_DISABLED") throw err;
    action = CLARIFY_TRANSIENT;
  }
  action = resolveActionWithHistory(message, trimmedHistory, action, context.todayIst);
  action = refineQueryAction(message, action, {
    todayIst: context.todayIst,
    history: trimmedHistory,
  });
  const { bundle, compositeParts } = await executeAction(req, action);
  const shouldNarrate =
    (action.kind === "report" || action.kind === "query") &&
    (bundle.statCards?.length || bundle.table?.rows?.length);
  const shouldNarrateComposite =
    action.kind === "composite" && compositeParts && compositeParts.length > 1;

  if (shouldNarrate || shouldNarrateComposite) {
    try {
      const facts = shouldNarrateComposite
        ? factsFromComposite(compositeParts)
        : factsFromBundle(bundle);
      const narrative = await narrate({ question: message, facts });
      if (narrative) bundle.narrative = narrative;
    } catch {
      /* keep caption-only summaryText on failure */
    }
  }

  const { assistantMessageId } = await appendTurn(req, conversationId, messageRaw || message, bundle);
  const response = {
    ...bundle,
    cached: false,
    conversationId,
    messageId: assistantMessageId,
  };

  await writeCache(key, response);
  await writeAudit({
    req,
    action: "ASSISTANT_CHAT",
    entityType: "TENANT",
    entityId: context.tenantId,
    metadata: {
      kind: action.kind,
      reportKey: action.kind === "report" ? action.reportKey : undefined,
      entity: action.kind === "query" ? action.spec?.entity : undefined,
      questionLength: message.length,
    },
  }).catch(() => {});

  return response;
}
