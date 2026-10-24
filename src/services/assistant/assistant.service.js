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
import { resolveActionWithHistory } from "./follow-up.js";
import { normalizeAssistantQuestion } from "./normalize-question.js";
import {
  ASSISTANT_PLANNER_SCHEMA_VERSION,
  planFingerprint,
  validateAndNormalizeAssistantPlan,
} from "./assistant-plan.js";
import {
  appendTurn,
  getOrCreateConversation,
  loadConversationFocus,
  loadLastResolvedPlan,
  loadRecentContext,
  saveConversationFocus,
  saveLastResolvedPlan,
} from "./assistant-history.service.js";
import {
  bundlePayloadFromCollectionDaily,
  runCollectionDailyAssistant,
} from "./collection-daily-assistant.service.js";
import { resolveActionDateBounds } from "./assistant-date-window.js";
import {
  applyConversationFocusToAction,
  deriveConversationFocusFromTurn,
  focusFingerprint,
  normalizeConversationFocus,
} from "./conversation-focus.js";

const CACHE_TTL_SEC = 120;

function normalizeQuestion(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function canonicalFilterObject(filters) {
  if (!filters || typeof filters !== "object") return {};
  const out = {};
  for (const key of Object.keys(filters).sort()) {
    if (filters[key] !== undefined) out[key] = filters[key];
  }
  return out;
}

function stableActionFingerprint(action) {
  if (!action || typeof action !== "object") return "";
  try {
    if (action.kind === "report") {
      return JSON.stringify({
        kind: "report",
        reportKey: action.reportKey,
        filters: canonicalFilterObject(action.filters),
      });
    }
    if (action.kind === "query") {
      const spec = action.spec ?? {};
      const filters = [...(spec.filters ?? [])].sort((a, b) =>
        `${a.field ?? ""}:${a.op ?? ""}:${a.value ?? ""}`.localeCompare(
          `${b.field ?? ""}:${b.op ?? ""}:${b.value ?? ""}`,
        ),
      );
      return JSON.stringify({
        kind: "query",
        spec: {
          entity: spec.entity,
          period: spec.period,
          from: spec.from,
          to: spec.to,
          groupBy: spec.groupBy,
          timeBucket: spec.timeBucket,
          topN: spec.topN,
          limit: spec.limit,
          sort: spec.sort,
          aggregate: spec.aggregate,
          filters,
        },
      });
    }
    if (action.kind === "composite") {
      return JSON.stringify({
        kind: "composite",
        reports: (action.reports ?? []).map((r) => ({
          reportKey: r.reportKey,
          filters: canonicalFilterObject(r.filters),
        })),
      });
    }
    if (action.kind === "collectionDaily") {
      return JSON.stringify({
        kind: "collectionDaily",
        v: ASSISTANT_PLANNER_SCHEMA_VERSION,
        filters: canonicalFilterObject(action.filters),
        analytics: action.analytics ?? null,
      });
    }
    return JSON.stringify({ kind: action.kind });
  } catch {
    return String(action.kind ?? "");
  }
}

export function assistantCacheKey(
  req,
  question,
  _history = [],
  conversationFocus = null,
  action = null,
) {
  const scope = assistantDataScope(req);
  const role = req.auth?.role ?? "";
  const bounds = resolveActionDateBounds(action, "");
  const material = `${normalizeQuestion(question)}|${focusFingerprint(conversationFocus)}|${stableActionFingerprint(action)}|${bounds.from ?? ""}|${bounds.to ?? ""}|${ASSISTANT_PLANNER_SCHEMA_VERSION}`;
  const hash = crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);
  return `assistant:v1:${scope.tenantId}:${scope.branchId ?? "all"}:${role}:${hash}`;
}

export function cachePayloadFromResponse(response) {
  const rest = { ...response };
  delete rest.messageId;
  delete rest.conversationId;
  delete rest.cached;
  delete rest.cacheAgeSeconds;
  return rest;
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

  if (action.kind === "collectionDaily") {
    const result = await runCollectionDailyAssistant(req, action);
    return {
      bundle: { narrative: null, ...bundlePayloadFromCollectionDaily(result, action) },
      compositeParts: null,
    };
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

  const conversationFocus =
    normalizeConversationFocus(conversation.conversationFocus) ??
    (conversation.messageCount > 0 ? await loadConversationFocus(req, conversationId) : null);
  const lastResolvedPlan =
    conversation.lastResolvedPlan ??
    (conversation.messageCount > 0 ? await loadLastResolvedPlan(req, conversationId) : null);

  const context = {
    ...buildContext(req),
    conversationFocus: conversationFocus ?? undefined,
    lastResolvedPlan: lastResolvedPlan ?? undefined,
  };
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
  action = resolveActionWithHistory(message, trimmedHistory, action, context.todayIst, {
    lastResolvedPlan,
  });
  action = applyConversationFocusToAction(action, conversationFocus, message);
  action = validateAndNormalizeAssistantPlan(message, action, {
    todayIst: context.todayIst,
    history: trimmedHistory,
    conversationFocus,
    lastResolvedPlan,
  });

  const key = assistantCacheKey(req, message, trimmedHistory, conversationFocus, action);
  const cachedPayload = await readCache(key);
  async function finalizeTurn(bundle, actionForTurn, dataAsOfIso) {
    const { assistantMessageId } = await appendTurn(
      req,
      conversationId,
      messageRaw || message,
      bundle,
    );
    const nextFocus = deriveConversationFocusFromTurn(
      { action: actionForTurn, bundle },
      conversationFocus,
    );
    if (
      nextFocus?.customerId !== conversationFocus?.customerId ||
      nextFocus?.schemeId !== conversationFocus?.schemeId ||
      nextFocus?.customerName !== conversationFocus?.customerName
    ) {
      await saveConversationFocus(req, conversationId, nextFocus);
    }
    const resolvedBounds = resolveActionDateBounds(actionForTurn, context.todayIst);
    await saveLastResolvedPlan(req, conversationId, {
      action: actionForTurn,
      bounds: resolvedBounds,
      plannerVersion: ASSISTANT_PLANNER_SCHEMA_VERSION,
      fingerprint: planFingerprint(actionForTurn),
    });
    return assistantMessageId;
  }

  if (cachedPayload) {
    const cachedAtMs = cachedPayload._cachedAt
      ? Date.parse(String(cachedPayload._cachedAt))
      : NaN;
    const hitBundle = cachePayloadFromResponse(cachedPayload);
    hitBundle.asOf = cachedPayload.asOf ?? hitBundle.asOf;
    const assistantMessageId = await finalizeTurn(hitBundle, action, cachedPayload.asOf);
    return {
      ...hitBundle,
      cached: true,
      cacheAgeSeconds: Number.isFinite(cachedAtMs)
        ? Math.max(0, Math.floor((Date.now() - cachedAtMs) / 1000))
        : undefined,
      conversationId,
      messageId: assistantMessageId,
    };
  }

  const dataAsOf = now().toISOString();
  const { bundle, compositeParts } = await executeAction(req, action);
  bundle.asOf = bundle.asOf ?? dataAsOf;
  const shouldNarrate =
    (action.kind === "report" || action.kind === "query" || action.kind === "collectionDaily") &&
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

  const assistantMessageId = await finalizeTurn(bundle, action, dataAsOf);
  const response = {
    ...bundle,
    cached: false,
    conversationId,
    messageId: assistantMessageId,
  };

  await writeCache(key, {
    ...cachePayloadFromResponse(response),
    _cachedAt: dataAsOf,
    asOf: bundle.asOf ?? dataAsOf,
  });
  await writeAudit({
    req,
    action: "ASSISTANT_CHAT",
    entityType: "TENANT",
    entityId: context.tenantId,
    metadata: {
      kind: action.kind,
      reportKey: action.kind === "report" ? action.reportKey : undefined,
      entity: action.kind === "query" ? action.spec?.entity : undefined,
      plannerVersion: ASSISTANT_PLANNER_SCHEMA_VERSION,
      resolvedPeriod: resolveActionDateBounds(action, context.todayIst),
      cacheStatus: response.cached ? "hit" : "miss",
      questionLength: message.length,
    },
  }).catch(() => {});

  return response;
}
