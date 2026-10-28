/**
 * Sidekick agent loop (the "ChatGPT-style" engine).
 *
 *   question → Gemini (with tools) → tool calls → results back to Gemini → … → final_answer
 *
 * The model decides which tools to call and how many times (bounded), reads compact
 * results, and finishes with final_answer whose visual blocks are rendered from the
 * server-side results — so every number on screen comes from the database.
 */
import { env } from "../../../config/env.js";
import { AppError } from "../../../lib/app-error.js";
import { logger } from "../../../config/logger.js";
import { generateAgentTurn } from "../../../integrations/llm/gemini-agent.js";
import { assistantDataScope } from "../query-compiler.js";
import { semanticLayerForPrompt } from "./semantic-layer.js";
import { DATA_TOOL_NAMES, DEFAULT_STEP_LABELS, TOOL_DECLARATIONS, executeTool } from "./tools.js";
import { buildTurnContext, contextBlock } from "./turn-context.js";
import { checkAnswerNumbers, collectNumbers } from "./number-guard.js";
import { buildAgentBundle } from "./answer-bundle.js";
import { addUsage, costUsd, emptyUsage } from "./usage.js";

const MAX_CALLS_PER_ROUND = 4;

export const AGENT_SYSTEM_PROMPT = `You are Sidekick, the AI business analyst inside Swarna Grow — software Indian jewellery shops use for gold savings schemes (also called chitti or kuri), Digi Gold, an online store and their own branded customer app. You talk with the shop owner or their staff.

HOW YOU WORK
- You act only by calling functions. Always finish with final_answer.
- Questions about the shop's own business (collections, payments, customers, schemes, dues, staff, branches, Digi Gold, store orders…): get the facts with data tools first. Never guess or invent figures, names or dates.
- Questions that need no shop data (gold/jewellery knowledge, business advice, drafting a message, greetings): answer directly with final_answer. For "how do I … in Swarna Grow" use help_articles.
- Understand any wording or language — English, Hinglish, Hindi, Malayalam, Tamil, typos, short forms. Reply in the language and script the user wrote in; keep names, numbers and ₹ amounts exactly as tools gave them.
- <context> has today's date and ready dateWindows. Copy those dates instead of calculating (e.g. "last 30 days" → dateWindows.last30Days). If a totals question names no period, use thisMonth and say so. "Last / latest / when was" questions: no date range, sort by date desc, limit 1.
- Resolve branch and plan names with <context>.branches / <context>.plans and pass their ids. For a customer named in the question, call find_customer first. If several match, ask which one (final_answer with needsClarification and the names as followUps).
- Follow-ups ("and last month?", "only UPI", "is he in any scheme?") continue the previous turns: reuse the same entity, filters and ids and change only what the user changed.
- Prefer one well-built query over many. Call independent tools together in one round. If a tool returns an error, fix the call using its hint or try another tool.

CHOOSING TOOLS
- Period collection totals, by branch or payment mode, net of refunds → run_report COLLECTION (same as the Reports screen). Day-by-day collections or comparing modes (Cash vs UPI) → collection_trend.
- Lists, rankings, "who / which / when / last", counts with conditions, anything custom → query_data.
- Standard reports for dues & ageing (OUTSTANDING), overdue customers (DEFAULTER), enrolments, staff, branch, scheme, customer performance, maturity, gold liability (GOLD_ACCRUAL), cash handover, store sales → run_report.
- One customer's full picture → find_customer then customer_overview.

query_data RULES
- Entities and fields come only from DATA below. Related fields use dots: customer.name, scheme.planName, branch.name, collectedBy.name.
- groupBy a relation name (customer, branch, scheme, collectedBy, staff, plan) to group by that record and show its name.
- Money in filters is rupees ("5000"), weights are grams, dates YYYY-MM-DD.
- UPI and ONLINE_GATEWAY are different payment modes: "UPI" → mode UPI; "online / app / gateway payment" → ONLINE_GATEWAY.
- compareToPrevious (with dateFrom/dateTo) returns the previous period's totals and % change.
- Metric aliases for sort: count, sum_<field>, avg_<field>, min_<field>, max_<field>, distinct_<field>; "period" for time buckets.
- Examples:
  last UPI payment → {entity:"payments", filters:[{field:"mode",op:"eq",value:"UPI"}], sort:{by:"paidAt",dir:"desc"}, limit:1}
  top 5 payers this month → {entity:"payments", dateFrom, dateTo, groupBy:["customer"], metrics:[{fn:"sum",field:"amount"},{fn:"count"}], sort:{by:"sum_amount",dir:"desc"}, limit:5}
  collection by mode per day → {entity:"payments", dateFrom, dateTo, timeBucket:"day", groupBy:["mode"], metrics:[{fn:"sum",field:"amount"}]}
  enrolments maturing next 30 days → {entity:"schemes", dateField:"maturityDate", dateFrom:today, dateTo:…, filters:[{field:"status",op:"eq",value:"ACTIVE"}]}
  customers with 2+ overdue instalments → {entity:"schemes", filters:[{field:"overdueInstallments",op:"gte",value:"2"}], select:["customer.name","customer.mobile","planName","overdueInstallments","overdueAmount"], sort:{by:"overdueInstallments",dir:"desc"}}

final_answer RULES
- answer: 1–4 short sentences, warm and direct, leading with the answer itself. **bold** the key figure; "- " bullets only for short lists. No headings, no markdown tables (use blocks).
- Use ONLY numbers, names and dates that appear in tool results or <context>. Quote ₹ amounts exactly as shown. Differences or % changes must come from tool results (e.g. compareToPrevious); otherwise compare in words.
- If nothing was found, say so plainly and suggest a sensible next check (e.g. a wider date range).
- blocks reference resultIds: "stats" for headline totals, "chart" for trends and comparisons (line for time, bar for categories, donut for share of ≤ 6 parts), "table" for lists. One record → a table with that row. Skip blocks for pure text answers.
- followUps: 2–3 short next questions the owner would likely ask, in their language.
- title: ≤ 7 words naming what the answer covers.
- You cannot change data (record payments, send reminders, edit records). Say so kindly and point to the right screen (help_articles).

DATA (entities for query_data)
${semanticLayerForPrompt()}`;

const TOOLS = [{ functionDeclarations: TOOL_DECLARATIONS }];

function generationConfig(model) {
  const raw = String(env.ASSISTANT_TEMPERATURE ?? "").trim();
  const t = raw === "" ? null : Number(raw);
  const temperature = Number.isFinite(t) ? t : /^gemini-2\./.test(model) ? 0.2 : undefined;
  return { ...(temperature !== undefined ? { temperature } : {}), maxOutputTokens: 2048 };
}

function historyToContents(history = []) {
  const contents = [];
  for (const turn of history.slice(-8)) {
    if (turn.role === "user") {
      const text = String(turn.text ?? "").trim();
      if (text) contents.push({ role: "user", parts: [{ text }] });
      continue;
    }
    const narrative = String(turn.narrative ?? turn.summary ?? "").trim();
    const memory = Array.isArray(turn.memory) && turn.memory.length
      ? `\n[data used: ${turn.memory.map((m) => `${m.tool} ${JSON.stringify(m.args)} → ${m.summary}`).join(" | ")}]`
      : turn.action
        ? `\n[previous action: ${JSON.stringify(turn.action).slice(0, 400)}]`
        : "";
    const text = `${narrative}${memory}`.trim();
    if (text) contents.push({ role: "model", parts: [{ text: text.slice(0, 2500) }] });
  }
  // Gemini expects the conversation to start with a user turn.
  while (contents.length && contents[0].role !== "user") contents.shift();
  return contents;
}

function functionCallsOf(content) {
  return (content?.parts ?? []).filter((p) => p?.functionCall?.name).map((p) => p.functionCall);
}

function textOf(content) {
  return (content?.parts ?? [])
    .filter((p) => typeof p?.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
}

function allowedNumbers({ question, ctx, toolPayloads }) {
  const set = new Set();
  collectNumbers(question, set);
  collectNumbers(ctx, set);
  for (const p of toolPayloads) collectNumbers(p, set);
  return set;
}

/**
 * Run one Sidekick turn.
 * @param {{ req: object, message: string, history: object[], onEvent?: (event: object) => void }} args
 */
export async function runAgentTurn({ req, message, history = [], onEvent }) {
  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {
      /* streaming is best-effort */
    }
  };
  const model = env.ASSISTANT_MODEL || "gemini-2.5-flash-lite";
  const maxSteps = Number(env.ASSISTANT_MAX_STEPS) || 5;
  const scope = assistantDataScope(req);
  const ctxData = await buildTurnContext(req, scope);
  const shopName = req.tenant?.displayName || req.tenant?.name || undefined;

  const contents = [
    ...historyToContents(history),
    { role: "user", parts: [{ text: `${contextBlock(ctxData, shopName)}\n\nOwner's message: ${message}` }] },
  ];

  const results = new Map();
  let seq = 0;
  const toolCtx = {
    req,
    scope,
    results,
    nextId: () => `r${++seq}`,
    log: req.log ?? logger,
  };
  const usage = emptyUsage();
  const steps = [];
  const calls = [];
  const toolPayloads = [];
  let final = null;
  let guardRetried = false;
  let fallbackText = "";

  emit({ type: "step", id: "think", label: "Understanding your question", status: "running" });

  for (let round = 0; round < maxSteps; round += 1) {
    const lastRound = round === maxSteps - 1;
    const response = await generateAgentTurn({
      model,
      systemInstruction: AGENT_SYSTEM_PROMPT,
      tools: TOOLS,
      toolConfig: {
        functionCallingConfig: lastRound
          ? { mode: "ANY", allowedFunctionNames: ["final_answer"] }
          : { mode: "ANY" },
      },
      contents,
      generationConfig: generationConfig(model),
    });
    addUsage(usage, response.usage);
    if (round === 0) emit({ type: "step", id: "think", label: "Understanding your question", status: "done" });

    const fcalls = functionCallsOf(response.content);
    if (!fcalls.length) {
      fallbackText = textOf(response.content);
      if (fallbackText) break;
      if (lastRound) break;
      // Empty turn (safety stop or glitch) — nudge once.
      contents.push({ role: "user", parts: [{ text: "Please continue by calling a function." }] });
      continue;
    }
    contents.push({ role: "model", parts: response.content.parts });

    const finalCall = fcalls.find((c) => c.name === "final_answer");
    const dataCalls = fcalls.filter((c) => c.name !== "final_answer").slice(0, MAX_CALLS_PER_ROUND);

    if (finalCall && !dataCalls.length) {
      const args = finalCall.args ?? {};
      const usedTools = calls.some((c) => DATA_TOOL_NAMES.has(c.name));
      const check = checkAnswerNumbers(args.answer, allowedNumbers({ question: message, ctx: ctxData, toolPayloads }));
      const inventedMoney = !usedTools && /₹\s?\d/.test(String(args.answer ?? ""));
      if ((!check.ok && usedTools) || inventedMoney) {
        if (!guardRetried && !lastRound) {
          guardRetried = true;
          contents.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "final_answer",
                  ...(finalCall.id ? { id: finalCall.id } : {}),
                  response: {
                    error: inventedMoney
                      ? "You stated rupee amounts without calling a data tool. If this is about the shop's data, call a data tool first; if it is general knowledge, avoid specific rupee figures."
                      : `These figures are not in the tool results: ${check.unknown.join(", ")}. Rewrite final_answer using only figures from the results (or describe the comparison in words).`,
                  },
                },
              },
            ],
          });
          continue;
        }
        // Second miss: keep the server-built visuals, drop the unverified prose.
        logger.warn({ unknown: check.unknown, tenantId: scope.tenantId }, "assistant answer failed number check");
        final = { ...args, answer: "Here's what I found in your data." };
        break;
      }
      final = args;
      break;
    }

    // Execute data/help tools for this round (final_answer mixed with data calls is ignored this round).
    const responseParts = [];
    for (const call of dataCalls) {
      const stepId = `s${steps.length + 1}`;
      const label = String(call.args?.purpose ?? "").trim().slice(0, 90) || DEFAULT_STEP_LABELS[call.name] || "Working on it";
      emit({ type: "step", id: stepId, label, status: "running", tool: call.name });
      const started = Date.now();
      const out = await executeTool(call.name, call.args, toolCtx);
      const payload = out.error ? { error: out.error } : out.forModel;
      toolPayloads.push(payload);
      const step = {
        id: stepId,
        tool: call.name,
        label,
        status: out.error ? "error" : "done",
        detail: out.error ? out.error.message : out.detail,
        ms: Date.now() - started,
      };
      steps.push(step);
      calls.push({ name: call.name, args: call.args, resultId: out.resultId, forModel: out.forModel, error: out.error });
      emit({ type: "step", ...step });
      responseParts.push({
        functionResponse: {
          name: call.name,
          ...(call.id ? { id: call.id } : {}),
          response: payload ?? { ok: true },
        },
      });
    }
    if (finalCall) {
      responseParts.push({
        functionResponse: {
          name: "final_answer",
          ...(finalCall.id ? { id: finalCall.id } : {}),
          response: { error: "Call final_answer alone, after the data tools have returned. Use the results above." },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  if (!final && !fallbackText) {
    fallbackText = results.size
      ? "Here's what I found in your data."
      : "Sorry — I couldn't work that out. Could you rephrase or add a little more detail?";
  }

  emit({ type: "step", id: "compose", label: "Preparing the answer", status: "done" });

  const usageOut = { ...usage, costUsd: costUsd(usage, model) };
  const bundle = buildAgentBundle({ final, results, steps, calls, usage: usageOut, model, fallbackText });
  return {
    bundle,
    usage,
    model,
    toolCalls: calls.length,
    resultCount: results.size,
  };
}

export function assertAgentAvailable() {
  if (!env.ASSISTANT_ENABLED || !String(env.GEMINI_API_KEY ?? "").trim()) {
    throw new AppError("ASSISTANT_DISABLED", "Analytics assistant is not enabled on this server.", 503);
  }
}
