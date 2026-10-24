import { normalizeAssistantQuestion } from "./normalize-question.js";
import {
  parseRelativeDateWindow,
  resolveActionDateBounds,
  resolveInclusiveRollingDays,
} from "./assistant-date-window.js";
import {
  analyticsFromAction,
  buildCollectionDailyAction,
  mergeCollectionAnalyticsPlan,
  parseCompareModesFromQuestion,
  normalizeCompareModes,
  wantsModeComparison,
  wantsOverallTotalsOnly,
} from "./collection-analytics-plan.js";

export const ASSISTANT_PLANNER_SCHEMA_VERSION = "2026-10-24";

function normalizeQuestion(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function lastUserText(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "user") return String(history[i].text ?? "");
  }
  return "";
}

function wantsMonthNotBranch(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  return (
    /\bnot branch\b/.test(q) ||
    /\bno branch\b/.test(q) ||
    /\bwithout branch\b/.test(q) ||
    /\bnot showroom\b/.test(q) ||
    /\bby month\b/.test(q)
  );
}

function routingQuestion(question, history = []) {
  const trimmed = String(question ?? "").trim();
  if (!trimmed || !history?.length) return trimmed;
  const q = normalizeQuestion(normalizeAssistantQuestion(trimmed));
  const isShort =
    q.length <= 80 &&
    (wantsMonthNotBranch(trimmed) || /\b(by month|monthly|not showroom)\b/.test(q));
  if (!isShort) return trimmed;
  const prev = lastUserText(history).trim();
  return prev ? `${prev} ${trimmed}` : trimmed;
}

function calendarMonthsWindow(todayIst, monthCount) {
  const parts = String(todayIst ?? "").split("-").map(Number);
  if (parts.length < 3 || !parts.every(Number.isFinite)) {
    return { from: undefined, to: todayIst };
  }
  const [y, m] = parts;
  const fromDate = new Date(Date.UTC(y, m - 1 - (monthCount - 1), 1));
  const fy = fromDate.getUTCFullYear();
  const fm = String(fromDate.getUTCMonth() + 1).padStart(2, "0");
  return { from: `${fy}-${fm}-01`, to: todayIst };
}

function monthWindowFromQuestion(q, todayIst) {
  if (/\blast (three|3) month/.test(q)) return calendarMonthsWindow(todayIst, 3);
  if (/\blast (two|2) month/.test(q)) return calendarMonthsWindow(todayIst, 2);
  return calendarMonthsWindow(todayIst, 2);
}

function buildBestMonthCollectionQuery(todayIst, q) {
  const months =
    /\blast (three|3) month/.test(q) ? 3 : /\blast (two|2) month/.test(q) ? 2 : 3;
  const { from, to } = monthWindowFromQuestion(q, todayIst);
  return {
    kind: "query",
    spec: {
      entity: "collections",
      filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
      from,
      to,
      timeBucket: "month",
      aggregate: { fn: "sum", field: "amountPaise" },
      sort: "desc",
      topN: months,
    },
  };
}

function isBestMonthCollectionQuestion(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  if (!q) return false;
  const collection = /\b(collect\w*|receipts?|payments?)\b/.test(q);
  const month = /\b(month|months|monthly)\b/.test(q);
  if (!collection || !month) return false;
  if (/\b(best|highest|top|most|strongest|peak|better)\b/.test(q)) return true;
  if (/\bwhich month\b/.test(q)) return true;
  if (/\blast (two|2|three|3) month/.test(q) && collection) return true;
  return false;
}

function isTopPayerRankingQuestion(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  if (!q) return false;
  const paymentWord = /\b(payment|collection|receipt|paid|pay)\b/.test(q);
  if (!paymentWord) return false;
  if (!/\b(most|highest|top|maximum|biggest|largest)\b/.test(q)) return false;
  if (/\b(last|latest|recent|newest)\b/.test(q) && !/\blast month\b/.test(q)) return false;
  return /\blast month\b/.test(q) || /\bthis month\b/.test(q) || /\bmonth\b/.test(q);
}

function buildTopPayerRankingQuery(question, todayIst) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  const period = /\bthis month\b/.test(q) ? "THIS_MONTH" : "LAST_MONTH";
  return {
    kind: "query",
    spec: {
      entity: "collections",
      filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
      period,
      groupBy: "customerId",
      aggregate: { fn: "sum", field: "amountPaise" },
      sort: "desc",
      topN: 5,
      ...(period === "THIS_MONTH" && todayIst ? { to: todayIst } : {}),
    },
  };
}

export function isCollectionDailyBreakdownQuestion(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  if (!q) return false;
  const collection = /\b(collect\w*|receipts?|collection)\b/.test(q);
  if (!collection) return false;
  if (/\bdaily\b/.test(q) && collection) return true;
  return (
    /\b(day[\s-]?by[\s-]?day|each day|per day|every day)\b/.test(q) ||
    /\bbreak[\s-]?down\b/.test(q)
  );
}

export function shouldExecuteCollectionAnalytics(question, action, context = {}) {
  if (action?.kind === "collectionDaily") return true;
  if (context.lastResolvedPlan?.action?.kind === "collectionDaily") {
    if (
      wantsModeComparison(question) ||
      wantsOverallTotalsOnly(question) ||
      parseRelativeDateWindow(question, context.todayIst) ||
      /\b(day|daily|weekly|monthly)\b/.test(normalizeQuestion(normalizeAssistantQuestion(question)))
    ) {
      return true;
    }
  }
  if (isCollectionDailyBreakdownQuestion(question)) return true;
  if (wantsModeComparison(question) && /\b(collect\w*|collection)\b/.test(normalizeQuestion(normalizeAssistantQuestion(question)))) {
    return true;
  }
  if (action?.kind === "query" && action.spec?.entity === "collections" && action.spec?.timeBucket === "day") {
    return true;
  }
  return false;
}

export function resolveCollectionAnalyticsAction(question, action, context = {}) {
  const priorAnalytics =
    analyticsFromAction(context.lastResolvedPlan?.action) ?? analyticsFromAction(action);
  const explicitWindow = parseRelativeDateWindow(question, context.todayIst);
  let dateCarrier = action;
  if (explicitWindow) {
    dateCarrier = applyDateWindowToAction(action, explicitWindow);
  }
  const { plan, bounds } = mergeCollectionAnalyticsPlan(priorAnalytics, question, {
    todayIst: context.todayIst,
    dateAction: dateCarrier,
  });
  const modesFromQuestion = parseCompareModesFromQuestion(question);
  if (modesFromQuestion?.length) {
    plan.compareModes = normalizeCompareModes(modesFromQuestion);
    if (!plan.dimensions.includes("mode")) plan.dimensions = [...plan.dimensions, "mode"];
    plan.operation = plan.compareModes.length >= 2 ? "comparison" : "trend";
  }
  if (plan.compareModes?.length >= 2) {
    plan.dimensions = ["day", "mode"];
    plan.timeGrain = "day";
  }
  const inherited = extractFiltersFromAction(dateCarrier);
  const resolvedBounds =
    bounds?.from && bounds?.to
      ? bounds
      : resolveActionDateBounds(
          { kind: "collectionDaily", filters: inherited },
          context.todayIst,
        );
  return buildCollectionDailyAction({
    bounds: resolvedBounds,
    analytics: plan,
    branchId: inherited.branchId,
    planId: inherited.planId,
  });
}

export function isTenantWideCollectionQuestion(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  if (!q) return false;
  if (!/\b(collect\w*|receipts?|collection)\b/.test(q)) return false;
  if (/\b(we|our|us|showroom|branch|tenant)\b/.test(q)) return true;
  if (/\bhow much did we\b/.test(q)) return true;
  return false;
}

/** Latest single receipt — not period totals or daily series. */
export function isLatestSingleReceiptIntent(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  if (!q) return false;
  if (isCollectionDailyBreakdownQuestion(question)) return false;
  if (/\b(break[\s-]?down|per day|day by day)\b/.test(q)) return false;

  const paymentWord = /\b(payment|receipt|installment)\b/.test(q);
  if (!paymentWord) return false;

  if (/\b(most|highest|top|maximum|biggest|rank)\b/.test(q)) return false;

  if (/\b(how much|total|sum|collect\w*)\b/.test(q) && !/\b(latest|last payment|most recent payment)\b/.test(q)) {
    return false;
  }

  if (/\blast\s+\d{1,3}\s+days?\b/.test(q)) {
    return /\b(latest|last payment|most recent|newest)\s+(payment|receipt)\b/.test(q) ||
      /\b(payment|receipt).*\b(latest|last|most recent|newest)\b/.test(q);
  }

  if (/\b(last|latest|most recent|newest)\b/.test(q) && paymentWord) return true;
  if (/\bwho (paid|made)\b/.test(q) && !/\bmost\b/.test(q)) return true;
  if (/\bpayment details\b/.test(q)) return true;
  if (/\bwhich (scheme|customer|branch)\b/.test(q) && /\b(last|latest|who)\b/.test(q)) return true;
  return false;
}

function applyDateWindowToAction(action, window) {
  if (!window || !action) return action;
  if (action.kind === "report") {
    const filters = { ...(action.filters ?? {}) };
    if (window.period) {
      filters.period = window.period;
      delete filters.from;
      delete filters.to;
    } else if (window.from && window.to) {
      delete filters.period;
      filters.from = window.from;
      filters.to = window.to;
    }
    return { ...action, filters };
  }
  if (action.kind === "query") {
    const spec = { ...(action.spec ?? {}) };
    if (window.period) {
      spec.period = window.period;
      delete spec.from;
      delete spec.to;
    } else if (window.from && window.to) {
      delete spec.period;
      spec.from = window.from;
      spec.to = window.to;
    }
    return { ...action, spec };
  }
  if (action.kind === "collectionDaily") {
    const filters = { ...(action.filters ?? {}) };
    if (window.period) {
      filters.period = window.period;
      delete filters.from;
      delete filters.to;
    } else if (window.from && window.to) {
      delete filters.period;
      filters.from = window.from;
      filters.to = window.to;
    }
    return { ...action, filters };
  }
  return action;
}

function extractFiltersFromAction(action) {
  if (action?.kind === "report") return { ...(action.filters ?? {}) };
  if (action?.kind === "collectionDaily") return { ...(action.filters ?? {}) };
  if (action?.kind === "query") {
    const spec = action.spec ?? {};
    return {
      period: spec.period,
      from: spec.from,
      to: spec.to,
      branchId: spec.filters?.find((f) => f.field === "branchId" && f.op === "eq")?.value,
      planId: spec.filters?.find((f) => f.field === "planId" && f.op === "eq")?.value,
    };
  }
  return {};
}

export function toCollectionDailyAction(action, todayIst) {
  const inherited = extractFiltersFromAction(action);
  const bounds = resolveActionDateBounds(
    {
      kind: "collectionDaily",
      filters: inherited,
    },
    todayIst,
  );
  const filters = {
    ...inherited,
    ...(bounds.from && bounds.to
      ? { from: bounds.from, to: bounds.to, period: undefined }
      : {}),
  };
  if (filters.period === "LAST_3_MONTHS" && inherited.from && inherited.to) {
    delete filters.period;
    filters.from = inherited.from;
    filters.to = inherited.to;
  }
  return {
    kind: "collectionDaily",
    filters,
    plannerVersion: ASSISTANT_PLANNER_SCHEMA_VERSION,
  };
}

function modelDailyQuerySpec(action) {
  const spec = action?.spec;
  if (action?.kind !== "query" || !spec) return false;
  if (spec.entity !== "collections") return false;
  if (spec.timeBucket === "day" && spec.aggregate?.fn === "sum") return true;
  if (spec.timeBucket === "day" && !spec.limit) return true;
  return false;
}

function replaceIncorrectRollingPreset(question, action, todayIst) {
  const window = parseRelativeDateWindow(question, todayIst);
  if (!window?.from || !window?.to) return action;
  const rolling = question.toLowerCase().match(/\blast\s+(\d{1,3})\s+days?\b/);
  if (!rolling) return action;
  const n = Number(rolling[1]);
  if (n === 90 || n === 30) {
    const expected = resolveInclusiveRollingDays(n, todayIst);
    if (expected?.from && expected.to) {
      return applyDateWindowToAction(action, expected);
    }
  }
  return applyDateWindowToAction(action, window);
}

/**
 * Validate model output and apply server-owned dates/intent — no silent semantic destruction.
 */
export function validateAndNormalizeAssistantPlan(question, action, context = {}) {
  const effective = routingQuestion(question, context.history);
  const q = normalizeQuestion(normalizeAssistantQuestion(effective));
  const todayIst = context.todayIst;

  if (isBestMonthCollectionQuestion(effective) || (wantsMonthNotBranch(effective) && /\b(collect|month)\b/.test(q))) {
    if (todayIst) return buildBestMonthCollectionQuery(todayIst, q);
  }
  if (isTopPayerRankingQuestion(effective)) {
    return buildTopPayerRankingQuery(effective, todayIst);
  }

  let next = action;
  const explicitWindow = parseRelativeDateWindow(effective, todayIst);
  if (explicitWindow) {
    next = applyDateWindowToAction(next, explicitWindow);
    next = replaceIncorrectRollingPreset(effective, next, todayIst);
  } else if (context.lastResolvedPlan?.filters || context.lastResolvedPlan?.spec) {
    const inherited = resolveActionDateBounds(context.lastResolvedPlan, todayIst);
    if (inherited.from && inherited.to && !isTenantWideCollectionQuestion(effective)) {
      next = applyDateWindowToAction(next, { from: inherited.from, to: inherited.to });
    }
  }

  if (shouldExecuteCollectionAnalytics(effective, next, { ...context, todayIst })) {
    return resolveCollectionAnalyticsAction(effective, next, { ...context, todayIst });
  }

  if (isLatestSingleReceiptIntent(effective) && next?.kind === "query") {
    const spec = {
      entity: "collections",
      filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
      sort: "desc",
      limit: 1,
    };
    if (explicitWindow) {
      if (explicitWindow.period) spec.period = explicitWindow.period;
      else if (explicitWindow.from && explicitWindow.to) {
        spec.from = explicitWindow.from;
        spec.to = explicitWindow.to;
      }
    }
    return { kind: "query", spec };
  }

  if (next?.kind === "report" && next.reportKey === "COLLECTION" && explicitWindow) {
    next = replaceIncorrectRollingPreset(effective, next, todayIst);
  }

  return next;
}

export function refineQueryAction(question, action, context = {}) {
  return validateAndNormalizeAssistantPlan(question, action, context);
}

export function planFingerprint(action) {
  if (!action) return "";
  return JSON.stringify({
    v: ASSISTANT_PLANNER_SCHEMA_VERSION,
    kind: action.kind,
    reportKey: action.reportKey,
    filters: action.filters,
    analytics: action.analytics,
    spec: action.spec,
  });
}
