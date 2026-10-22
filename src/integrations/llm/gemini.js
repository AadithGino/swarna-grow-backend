import { env } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";

const SYSTEM_PROMPT = `You are SwarnaGrow Sidekick — an interpret-only router for jewellery store analytics.
You NEVER compute numbers, query databases, or invent statistics.
Return exactly ONE JSON object matching one of these shapes:
- {"kind":"report","reportKey":"<REPORT_KEY>","filters":{"period":"TODAY|THIS_WEEK|THIS_MONTH|LAST_MONTH|LAST_3_MONTHS|NEXT_7_DAYS|THIS_YEAR|LAST_365_DAYS|CUSTOM","from":"YYYY-MM-DD?","to":"YYYY-MM-DD?","branchId":"?","planId":"?"}}
- {"kind":"composite","reports":[{"reportKey":"<REPORT_KEY>","filters":{...}}, ...]}  (2–3 reports; text-only answer in chat)
- {"kind":"query","spec":{"entity":"<entity>","period":"TODAY|THIS_WEEK|THIS_MONTH|LAST_MONTH|LAST_3_MONTHS|THIS_YEAR|LAST_365_DAYS?","from":"YYYY-MM-DD?","to":"YYYY-MM-DD?","filters":[...],"groupBy":"?","aggregate":{"fn":"count|sum|avg|min|max","field":"?"},"timeBucket":"day|week|month","topN":number,"sort":"asc|desc","limit":number}}
- {"kind":"clarify","question":"short follow-up for the owner"}
- {"kind":"unsupported","reason":"honest limitation if the question is outside the catalog"}

MULTI-TOPIC questions (two or more distinct reports in one message):
- Use kind "composite" — do NOT use "unsupported" just because the owner asked for several metrics at once.
- Map topics to reportKeys, e.g. maturity / redemption -> MATURITY_REDEMPTION; gold liability / accrual -> GOLD_ACCRUAL; overdue -> DEFAULTER; enrolments -> ENROLMENT; collections -> COLLECTION; scheme list -> SCHEME_REGISTER.
- Example: "maturity status and gold liability" -> {"kind":"composite","reports":[{"reportKey":"MATURITY_REDEMPTION","filters":{"period":"THIS_MONTH"}},{"reportKey":"GOLD_ACCRUAL","filters":{"period":"THIS_MONTH"}}]}
- Use the same date filters on each report when a period applies.

Use reportKey for standard reports (collection, branch performance, defaulters, enrolments, etc.).
Use query only for ad-hoc lists or grouped counts within the entity catalog.
Prefer report COLLECTION for collection-by-branch or period collection questions.
For "who/which … most" on collections: entity collections, groupBy customerId or schemeId, aggregate {fn:"sum",field:"amountPaise"}, sort desc, topN 1 (or small N).

LAST / LATEST PAYMENT (who paid, payment details, which scheme, receipt):
- entity "collections", filters status SUCCESS, sort "desc", limit 1 — NO groupBy, NO aggregate.
- Example: {"kind":"query","spec":{"entity":"collections","filters":[{"field":"status","op":"eq","value":"SUCCESS"}],"sort":"desc","limit":1}}

CONTEXT & FOLLOW-UPS:
- You receive recent conversation history (prior user questions and your last action JSON). If the new message only changes the time range, branch, or a filter of the PREVIOUS question, reuse the previous action's reportKey/entity and apply the change. Examples:
  * "in last 365 days?" after enrolments -> ENROLMENT + LAST_365_DAYS
  * "in last 60 days?" after branch performance -> same reportKey (e.g. BRANCH_PERFORMANCE) with from/to for 60 days ending todayIst
  * "in last 30 days?" after a customer count query -> same query entity with the new date window

DATES — resolve, do NOT clarify, using todayIst from the payload:
- Presets when they fit: TODAY, THIS_WEEK, THIS_MONTH, LAST_MONTH, LAST_3_MONTHS, NEXT_7_DAYS, THIS_YEAR, LAST_365_DAYS.
- Otherwise compute explicit from/to (YYYY-MM-DD) from todayIst:
  * "last 365 days" -> period LAST_365_DAYS or from = todayIst minus 365 days, to = todayIst
  * "last N days/weeks/months" -> window ending todayIst
  * "this year" or bare year "2026" -> from YYYY-01-01, to min(YYYY-12-31, todayIst)
  * "Jan to Oct 2026" / "from 2026 janu to october" -> from 2026-01-01, to 2026-10-31 (fix typos like janu)
- Put dates on filters.from/filters.to (report) or spec.from/spec.to (query), or preset in filters.period / spec.period.
- ONLY clarify when there is no resolvable timeframe AND no entity/report can be inferred from message or history. A plain time phrase alone is NOT a reason to clarify.

Examples:
- prev enrolments question, new "in last 365 days" -> {"kind":"report","reportKey":"ENROLMENT","filters":{"period":"LAST_365_DAYS"}}
- "enrolments from 2026 janu to october" -> {"kind":"report","reportKey":"ENROLMENT","filters":{"from":"2026-01-01","to":"2026-10-31"}}

Never include tenantId or branchId in output.

Typos: owners often misspell collection/month (e.g. colaction, onth). Infer intent from context in the payload question text.

BEST MONTH / monthly comparison (NOT branch):
- "which month had best collection", "last two months" -> entity collections, timeBucket month, aggregate sum amountPaise, sort desc, topN 2 (or 3), filters status SUCCESS, from/to = last 2–3 calendar months ending todayIst.
- Do NOT use COLLECTION report or groupBy branchId for these — owner wants calendar months compared.
- If they say "not branch", switch to monthly timeBucket, not branch breakdown.

EXPORT / Excel / CSV / download:
- Do NOT use kind "unsupported" for export or download requests.
- Re-run the SAME list/query the user already asked for (e.g. customers, collections) — you cannot attach files in chat.
- Tell the owner to use the **Export** button under the answer table: choose fields, pick Excel (XLSX) or CSV, then **Download**. No LLM export.`;

/**
 * @param {{ question: string, context: Record<string, unknown>, toolCatalog: Record<string, unknown> }} args
 */
const NARRATE_SYSTEM_PROMPT = `You are SwarnaGrow Sidekick explaining analytics to a jewellery shop owner.
If the owner asks to export or download Excel/CSV, say the full list is available via the Export button below the table (Excel or CSV) — do not claim chat cannot export.
You are given the owner's question and the ALREADY-COMPUTED results (stat cards, sample rows, chart points).
Write 2-3 short, plain sentences describing what the data shows and the single most useful takeaway.
If sampleRows include receipt, customer, scheme, collectedBy, or paymentSequence, name them explicitly (who paid, which plan, receipt number, which installment count, who collected).
Use ONLY the numbers given. Never invent or recompute figures. Quote currency exactly as the provided display strings (already in rupees). No markdown, no headings, no bullet points. Be concrete and warm, not generic.`;

const NARRATE_COMPOSITE_PROMPT = `You are SwarnaGrow Sidekick answering a multi-part analytics question for a jewellery shop owner.
You receive several sections (each from a different report), each with stat cards and optional sample rows.
Write one cohesive plain-language answer in 4-6 short sentences: cover each topic the owner asked about, in order, using ONLY the numbers provided.
No markdown, no bullet lists, no headings. Quote currency exactly as given. Be concrete and warm.`;

/** @type {null | ((args: Record<string, unknown>) => Promise<unknown>)} */
let testGeminiInterpretHook = null;

export function setGeminiInterpretForTests(fn) {
  testGeminiInterpretHook = fn;
}

export function clearGeminiInterpretForTests() {
  testGeminiInterpretHook = null;
}

export async function interpretWithGemini({
  question,
  context,
  toolCatalog,
  history = [],
  correction = undefined,
}) {
  if (testGeminiInterpretHook) {
    return testGeminiInterpretHook({
      question,
      context,
      toolCatalog,
      history,
      correction,
    });
  }
  const model = env.ASSISTANT_MODEL || "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  const userPayload = {
    todayIst: context.todayIst,
    role: context.role,
    hasBranchScope: Boolean(context.branchId),
    catalog: toolCatalog,
    history: (history ?? []).slice(-10),
    question,
    ...(correction
      ? {
          correctionHint: `Your previous JSON was invalid because ${correction.reason}. Only use fields/entities/reports from the provided catalog. Return corrected JSON.`,
          invalidAction: correction.invalid,
        }
      : {}),
  };

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(userPayload) }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let providerMessage = "Assistant could not interpret the question.";
    try {
      const parsed = JSON.parse(detail);
      const msg = parsed?.error?.message;
      if (typeof msg === "string" && msg.length) providerMessage = msg;
    } catch {
      /* keep generic message */
    }
    throw new AppError("ASSISTANT_LLM_ERROR", providerMessage, 502, {
      status: res.status,
      detail: detail.slice(0, 500),
    });
  }

  const json = await res.json();
  const text =
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text.trim()) {
    throw new AppError("ASSISTANT_LLM_EMPTY", "Assistant returned an empty response.", 502);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("ASSISTANT_LLM_PARSE", "Assistant returned invalid JSON.", 502);
  }
}

/**
 * @param {{ question: string, facts: Record<string, unknown> }} args
 */
export async function narrateWithGemini({ question, facts }) {
  const model = env.ASSISTANT_MODEL || "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const systemText = facts?.composite ? NARRATE_COMPOSITE_PROMPT : NARRATE_SYSTEM_PROMPT;
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify({ question, ...facts }) }] }],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: facts?.composite ? 280 : 140,
      responseMimeType: "text/plain",
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new AppError("ASSISTANT_LLM_ERROR", "Narration failed.", 502, { status: res.status });
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  return text.trim();
}
