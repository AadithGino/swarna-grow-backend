/**
 * Sidekick cost tracking and the per-tenant daily question cap.
 * Prices are USD per 1M tokens from the Gemini API pricing page (standard paid tier,
 * checked 2026-10-24). Override with ASSISTANT_PRICE_* env vars when prices change.
 */
import { env } from "../../../config/env.js";
import { AppError } from "../../../lib/app-error.js";
import { today } from "../../../lib/date.js";
import { AssistantUsageDaily } from "../../../models/assistant.models.js";

const PRICE_TABLE = [
  { prefix: "gemini-2.5-flash-lite", input: 0.1, output: 0.4, cached: 0.01 },
  { prefix: "gemini-2.5-flash", input: 0.3, output: 2.5, cached: 0.03 },
  { prefix: "gemini-3.1-flash-lite", input: 0.25, output: 1.5, cached: 0.025 },
  { prefix: "gemini-3.5-flash-lite", input: 0.3, output: 2.5, cached: 0.03 },
  { prefix: "gemini-3.6-flash", input: 0.75, output: 3.75, cached: 0.075 },
  { prefix: "gemini-3.8-flash", input: 0.75, output: 3.75, cached: 0.075 },
];

function envPrice(raw) {
  const n = Number(String(raw ?? "").trim());
  return String(raw ?? "").trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
}

export function priceFor(model) {
  const row = PRICE_TABLE.find((p) => String(model ?? "").startsWith(p.prefix)) ?? { input: 0.3, output: 2.5, cached: 0.03 };
  return {
    input: envPrice(env.ASSISTANT_PRICE_INPUT_PER_M) ?? row.input,
    output: envPrice(env.ASSISTANT_PRICE_OUTPUT_PER_M) ?? row.output,
    cached: envPrice(env.ASSISTANT_PRICE_CACHED_PER_M) ?? row.cached,
  };
}

export function emptyUsage() {
  return { llmCalls: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, thoughtsTokens: 0 };
}

export function addUsage(total, u) {
  total.llmCalls += 1;
  total.promptTokens += u?.promptTokens ?? 0;
  total.cachedTokens += u?.cachedTokens ?? 0;
  total.outputTokens += u?.outputTokens ?? 0;
  total.thoughtsTokens += u?.thoughtsTokens ?? 0;
  return total;
}

/** Estimated cost in USD (cached prompt tokens billed at the cache rate; thinking billed as output). */
export function costUsd(usage, model) {
  const p = priceFor(model);
  const uncached = Math.max(0, usage.promptTokens - usage.cachedTokens);
  const cost =
    (uncached * p.input + usage.cachedTokens * p.cached + (usage.outputTokens + usage.thoughtsTokens) * p.output) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Count the question against today's cap; throws 429 when the tenant is over the limit. */
export async function reserveDailyQuestion(tenantId) {
  const limit = Number(env.ASSISTANT_DAILY_QUESTION_LIMIT ?? 0);
  const day = today();
  const doc = await AssistantUsageDaily.findOneAndUpdate(
    { tenantId, day },
    { $inc: { questions: 1 }, $setOnInsert: { tenantId, day } },
    { upsert: true, new: true, lean: true },
  );
  if (limit > 0 && doc.questions > limit) {
    await AssistantUsageDaily.updateOne({ tenantId, day }, { $inc: { questions: -1 } });
    throw new AppError(
      "ASSISTANT_DAILY_LIMIT",
      `Sidekick has reached today's limit of ${limit} questions for your shop. It resets at midnight.`,
      429,
    );
  }
  return { day, questions: doc.questions };
}

export async function recordUsage(tenantId, usage, { model, toolCalls = 0 } = {}) {
  const day = today();
  const micro = Math.round(costUsd(usage, model) * 1_000_000);
  await AssistantUsageDaily.updateOne(
    { tenantId, day },
    {
      $inc: {
        llmCalls: usage.llmCalls,
        promptTokens: usage.promptTokens,
        cachedTokens: usage.cachedTokens,
        outputTokens: usage.outputTokens + usage.thoughtsTokens,
        costMicroUsd: micro,
        toolCalls,
      },
      $set: { model },
      $setOnInsert: { tenantId, day },
    },
    { upsert: true },
  );
}
