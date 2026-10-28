# Sidekick agent engine

Sidekick now answers open-ended questions the way ChatGPT/Claude do: Gemini reads the
question, calls read-only tools against your live data (as many rounds as it needs, up to
`ASSISTANT_MAX_STEPS`), reads the compact results, and finishes with `final_answer`. Cards,
charts and tables are built on the server from the tool results — the model never types a
number that appears in a visual, and a number guard checks the written answer too.

```
question ──► Gemini (function calling) ──► tool calls ──► results ──► … ──► final_answer
                       ▲                                     │
                       └──────── compact results ◄───────────┘
UI blocks (stats / chart / table) ◄── server-side results by resultId
```

## Files

| Path | What it does |
| --- | --- |
| `src/services/assistant/agent/semantic-layer.js` | The only data the agent can reach: 15 entities (payments, customers, schemes, plans, redemptions, branches, staff, gold rates, Digi Gold buys/sells/holdings, store orders/items/products, cash handovers), their fields, enums and relations. KYC numbers, addresses, bank details, tokens etc. are simply not listed. |
| `src/services/assistant/agent/query-data.js` | Compiles a `query_data` spec into a MongoDB aggregation. Injects tenant + branch scope, re-applies the tenant filter inside every `$lookup`, caps rows/groups, `maxTimeMS`. Lists, group-by, time buckets, metrics, previous-period comparison, export pipelines. |
| `src/services/assistant/agent/tools.js` | Tool declarations + executors: `query_data`, `run_report` (the 18 existing report builders), `collection_trend` (existing collectionDaily), `find_customer`, `customer_overview`, `help_articles`, `final_answer`. Tool errors go back to the model with a hint so it can correct itself. |
| `src/services/assistant/agent/agent.service.js` | The loop + system prompt (static, so Gemini can cache it). |
| `src/services/assistant/agent/turn-context.js` | Per-turn context: today (IST), ready date windows (last 30 days, this FY…), branches, plans, latest gold rate. |
| `src/services/assistant/agent/number-guard.js` | Rejects figures in the answer that don't trace to tool results (sums/differences/% of traced figures are allowed). One rewrite, then a safe fallback line. |
| `src/services/assistant/agent/answer-bundle.js` | final_answer + results → `AssistantBundle` with ordered `blocks`, `steps`, `followUps`. Legacy fields (`statCards`, `chart`, `table`) are filled from the first blocks for old clients. |
| `src/services/assistant/agent/agent-chat.service.js` | History, 2-minute cache for opening questions, daily cap, persistence, usage + audit. |
| `src/services/assistant/agent/usage.js` | Token cost per model (Gemini price table, overridable) and the `AssistantUsageDaily` per-tenant counter. |
| `src/integrations/llm/gemini-agent.js` | Gemini `generateContent` with tools (API key in header, one retry on 429/5xx). |
| `src/controllers/assistant.controller.js` → `chatStream` | `POST /admin/assistant/chat/stream` (Server-Sent Events): live `step` events while tools run, then `final`. |

## Configuration

```
ASSISTANT_ENABLED=true
GEMINI_API_KEY=...
ASSISTANT_MODEL=gemini-2.5-flash-lite
ASSISTANT_ENGINE=agent              # router = old fixed-intent engine (instant rollback)
ASSISTANT_MAX_STEPS=5               # model rounds per question
ASSISTANT_DAILY_QUESTION_LIMIT=300  # per tenant per IST day, 0 = unlimited
# Optional: ASSISTANT_TEMPERATURE, ASSISTANT_PRICE_INPUT_PER_M / _OUTPUT_PER_M / _CACHED_PER_M
```

Run `npm run db:sync-indexes` once (new `AssistantUsageDaily` collection).
If the API sits behind nginx, `X-Accel-Buffering: no` is already sent on the stream; make sure
proxy buffering/timeouts allow a ~30 s response.

## Cost tracking

Each answer stores token usage on the assistant message (`bundle.usage`, not sent to the
browser) and adds it to `assistantusagedailies` (`questions`, `llmCalls`, `promptTokens`,
`cachedTokens`, `outputTokens`, `costMicroUsd` per tenant per day). Example:

```js
db.assistantusagedailies.aggregate([
  { $match: { day: { $gte: "2026-11-01" } } },
  { $group: { _id: "$tenantId", questions: { $sum: "$questions" }, usd: { $sum: { $divide: ["$costMicroUsd", 1e6] } } } },
  { $sort: { usd: -1 } },
])
```

## Rollout

1. Deploy with `ASSISTANT_ENGINE=agent` on a staging tenant; ask the questions owners really ask
   (export the last few hundred from `assistantmessages` where `role: "USER"`).
2. Compare answers against Reports. Wrong tool choices are fixed in the system prompt or the
   semantic layer descriptions — not with regex rules.
3. Switch production to `agent`. The legacy router (`assistant-plan.js`, `follow-up.js`,
   `conversation-focus.js`, …) is still there behind `ASSISTANT_ENGINE=router`; delete it once
   you're happy.

## Adding data the agent can answer about

Add an entity (or fields/relations) to `semantic-layer.js` — model, date field, branch scoping,
fields with types, short descriptions. Nothing else changes: the prompt, validation, compiler,
UI tables and export pick it up automatically.
