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
export function isLastPaymentDetailQuestion(question) {
  const q = normalizeQuestion(normalizeAssistantQuestion(question));
  if (!q) return false;
  const paymentWord = /\b(payment|collection|receipt|installment|paid)\b/.test(q);
  if (!paymentWord) return false;

  if (/\b(last|latest|most recent|newest|recent)\b/.test(q)) return true;
  if (/\bwho (paid|made|collected)\b/.test(q)) return true;
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
export function refineQueryAction(question, action, context = {}) {
  const effective = routingQuestion(question, context.history);
  const q = normalizeQuestion(normalizeAssistantQuestion(effective));
  const todayIst = context.todayIst;

  const monthComparison =
    isBestMonthCollectionQuestion(effective) ||
    (wantsMonthNotBranch(effective) && /\b(collect|month)\b/.test(q));

  if (monthComparison && todayIst) {
    return buildBestMonthCollectionQuery(todayIst, q);
  }

  if (action?.kind !== "query") return action;
  if (!isLastPaymentDetailQuestion(question)) return action;

  return {
    kind: "query",
    spec: {
      entity: "collections",
      filters: [{ field: "status", op: "eq", value: "SUCCESS" }],
      sort: "desc",
      limit: 1,
    },
  };
}
