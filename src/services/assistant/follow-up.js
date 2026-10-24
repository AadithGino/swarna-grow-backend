import { parseRelativeDateWindow } from "./assistant-date-window.js";
import {
  analyticsFromAction,
  parseCompareModesFromQuestion,
  wantsModeComparison,
  wantsOverallTotalsOnly,
  wantsDayWiseGrain,
} from "./collection-analytics-plan.js";
import {
  isCollectionDailyBreakdownQuestion,
  resolveCollectionAnalyticsAction,
} from "./assistant-plan.js";

/** @typedef {import("../../validators/assistant.validators.js").assistantActionSchema extends infer T ? T : never} AssistantAction */

/** Report titles from baseEnvelope → reportKey (summaryText prefix before ·). */
const REPORT_TITLE_TO_KEY = Object.freeze({
  "collection report": "COLLECTION",
  "daily collection": "COLLECTION",
  "daily collection comparison": "COLLECTION",
  "enrolment report": "ENROLMENT",
  "branch performance comparison": "BRANCH_PERFORMANCE",
  "outstanding & ageing": "OUTSTANDING",
  "defaulter report": "DEFAULTER",
  "scheme register": "SCHEME_REGISTER",
  "staff performance": "STAFF_PERFORMANCE",
  "maturity & redemption": "MATURITY_REDEMPTION",
  "gold accrual & liability": "GOLD_ACCRUAL",
  "cash handover": "CASH_HANDOVER",
  "reminder delivery": "REMINDER_DELIVERY",
  "whatsapp usage": "WHATSAPP_USAGE",
});

function normalizeFollowUpQuestion(question) {
  return String(question ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s*[?!.]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** @returns {{ period?: string, from?: string, to?: string } | null} */
export function parseTimeframeFromText(text, todayIst) {
  return parseRelativeDateWindow(text, todayIst);
}

/** Short messages that only adjust the date window of the prior question. */
export function isTimeframeFollowUp(question) {
  const q = String(question ?? "").trim();
  if (!q || q.length > 100) return false;
  const lower = normalizeFollowUpQuestion(q);

  if (
    /^(?:in\s+)?(?:the\s+)?(?:last|past)\s+\d{1,3}\s+days?$/.test(lower) ||
    /^(?:what about|how about|same for)\s+(?:the\s+)?(?:last|past)\s+\d{1,3}\s+days?$/.test(lower)
  ) {
    return true;
  }
  if (/^(?:in\s+)?(?:the\s+)?last\s+365\s+days?$/.test(lower)) return true;
  if (/^(?:this|last)\s+month$/.test(lower)) return true;
  if (/^(?:this|last)\s+week$/.test(lower)) return true;
  if (/^this\s+year$/.test(lower)) return true;

  return false;
}

function isCollectionPlanFollowUp(question) {
  return (
    wantsModeComparison(question) ||
    wantsOverallTotalsOnly(question) ||
    wantsDayWiseGrain(question) ||
    parseCompareModesFromQuestion(question)?.length ||
    /\bwhat about\b/.test(normalizeFollowUpQuestion(question))
  );
}

/**
 * @param {string | undefined} summary
 * @returns {AssistantAction | null}
 */
export function inferActionFromSummary(summary) {
  const text = String(summary ?? "").trim();
  if (!text) return null;

  const titlePart = text.split("·")[0]?.trim().toLowerCase();
  if (titlePart) {
    const reportKey = REPORT_TITLE_TO_KEY[titlePart];
    if (reportKey) {
      return { kind: "report", reportKey, filters: {} };
    }
    if (titlePart.startsWith("daily collection")) {
      return { kind: "collectionDaily", filters: {} };
    }
  }

  const queryMatch = text.match(/^query\s·\s*(\w+)/i);
  if (queryMatch) {
    const entity = queryMatch[1].toLowerCase();
    return { kind: "query", spec: { entity, filters: [] } };
  }

  return null;
}

/**
 * @param {Array<{ role: string, action?: AssistantAction }>} history
 * @returns {AssistantAction | null}
 */
export function lastAssistantAction(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const row = history[i];
    if (row?.role !== "assistant") continue;
    const kind = row.action?.kind;
    if (kind === "report" || kind === "query" || kind === "composite" || kind === "collectionDaily") {
      return row.action;
    }
    const inferred = inferActionFromSummary(row.summary);
    if (inferred) return inferred;
  }
  return null;
}

/**
 * @param {AssistantAction} action
 * @param {{ period?: string, from?: string, to?: string }} tf
 * @returns {AssistantAction}
 */
function applyTimeframeToAction(action, tf) {
  if (!tf) return action;
  if (action.kind === "report") {
    const filters = { ...(action.filters ?? {}) };
    if (tf.period) {
      filters.period = tf.period;
      delete filters.from;
      delete filters.to;
    } else if (tf.from && tf.to) {
      delete filters.period;
      filters.from = tf.from;
      filters.to = tf.to;
    }
    return { ...action, filters };
  }
  if (action.kind === "query") {
    const spec = { ...action.spec };
    if (tf.period) {
      spec.period = tf.period;
      delete spec.from;
      delete spec.to;
    } else if (tf.from && tf.to) {
      delete spec.period;
      spec.from = tf.from;
      spec.to = tf.to;
    }
    return { ...action, spec };
  }
  if (action.kind === "collectionDaily") {
    const filters = { ...(action.filters ?? {}) };
    if (tf.period) {
      filters.period = tf.period;
      delete filters.from;
      delete filters.to;
    } else if (tf.from && tf.to) {
      delete filters.period;
      filters.from = tf.from;
      filters.to = tf.to;
    }
    return { ...action, filters };
  }
  return action;
}

/**
 * When the model clarifies or the user only changes dates, reuse the prior report/query.
 *
 * @param {string} question
 * @param {object[]} history
 * @param {AssistantAction} action
 * @param {string} todayIst
 * @param {{ lastResolvedPlan?: object }} [options]
 * @returns {AssistantAction}
 */
export function resolveActionWithHistory(question, history, action, todayIst, options = {}) {
  const prev = lastAssistantAction(history) ?? options.lastResolvedPlan?.action ?? null;
  if (!prev) return action;

  const tf = parseTimeframeFromText(question, todayIst);
  const lastPlan = options.lastResolvedPlan?.action ?? prev;

  if (
    (prev?.kind === "collectionDaily" || analyticsFromAction(lastPlan)) &&
    (isCollectionPlanFollowUp(question) || isCollectionDailyBreakdownQuestion(question) || tf)
  ) {
    const base = tf ? applyTimeframeToAction(prev, tf) : prev;
    return resolveCollectionAnalyticsAction(question, action?.kind === "clarify" ? base : action ?? base, {
      todayIst,
      history,
      lastResolvedPlan: options.lastResolvedPlan ?? { action: prev },
    });
  }

  if (!tf) return action;

  if (isTimeframeFollowUp(question)) {
    return applyTimeframeToAction(prev, tf);
  }

  if (action.kind === "clarify" || action.kind === "unsupported") {
    return applyTimeframeToAction(prev, tf);
  }

  return action;
}

export {
  applyConversationFocusToAction,
  deriveConversationFocusFromTurn,
} from "./conversation-focus.js";
