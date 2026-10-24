import { normalizeAssistantQuestion } from "./normalize-question.js";

/** @typedef {import("../../validators/assistant.validators.js").assistantActionSchema extends infer T ? T : never} AssistantAction */

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

/** Short corrections like "not branch" reuse the prior user question for routing. */
function routingQuestion(question, history = []) {
  const trimmed = String(question ?? "").trim();
  if (!trimmed || !history?.length) return trimmed;
  const q = normalizeQuestion(normalizeAssistantQuestion(trimmed));
  const isShort =
    q.length <= 80 &&
    (wantsMonthNotBranch(trimmed) ||
      /\b(by month|monthly|not showroom)\b/.test(q));
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

export function buildBestMonthCollectionQuery(todayIst, q) {
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

/** Best / highest collection by calendar month (not branch). */
export function isBestMonthCollectionQuestion(question) {
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

export function wantsMonthNotBranch(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  return (
    /\bnot branch\b/.test(q) ||
    /\bno branch\b/.test(q) ||
    /\bwithout branch\b/.test(q) ||
    /\bnot showroom\b/.test(q) ||
    /\bby month\b/.test(q)
  );
}

/** Owner asks for the most recent receipt / who paid / payment details — not a grouped breakdown. */
/** Rank customers by total paid in a calendar month — not the latest single receipt. */
export function isTopPayerRankingQuestion(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  if (!q) return false;
  const paymentWord = /\b(payment|collection|receipt|paid|pay)\b/.test(q);
  if (!paymentWord) return false;
  if (!/\b(most|highest|top|maximum|biggest|largest)\b/.test(q)) return false;
  if (/\b(last|latest|recent|newest)\b/.test(q) && !/\blast month\b/.test(q)) return false;
  return /\blast month\b/.test(q) || /\bthis month\b/.test(q) || /\bmonth\b/.test(q);
}

export function buildTopPayerRankingQuery(question, todayIst) {
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

export function isLastPaymentDetailQuestion(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  if (!q) return false;
  const paymentWord = /\b(payment|collection|receipt|installment|paid)\b/.test(q);
  if (!paymentWord) return false;

  if (/\blast\s+\d{1,3}\s+days?\b/.test(q)) return false;
  if (/\b(daily|break[\s-]?down|per day|day by day)\b/.test(q)) return false;
  if (/\b(how much|total|sum)\b/.test(q) && !/\b(latest|last payment|most recent payment)\b/.test(q)) {
    return false;
  }

  if (/\b(most|highest|top|maximum|biggest|rank)\b/.test(q)) return false;
  if (/\b(last|latest|most recent|newest|recent)\b/.test(q)) return true;
  if (/\bwho (paid|made|collected)\b/.test(q) && !/\bmost\b/.test(q)) return true;
  if (/\bpayment details\b/.test(q)) return true;
  if (/\bwhich (scheme|customer|branch)\b/.test(q) && /\b(last|latest|who)\b/.test(q)) {
    return true;
  }
  return false;
}

/**
 * @param {string} question
 * @param {AssistantAction} action
 * @param {{ todayIst?: string }} [context]
 * @returns {AssistantAction}
 */
export { refineQueryAction } from "./assistant-plan.js";
