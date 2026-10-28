/**
 * Gemini function-calling transport for the Sidekick agent.
 * One call = one model turn: we send the conversation + tool declarations and get back
 * the model's content (function calls and/or text) plus token usage.
 */
import { env } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";

/** @type {null | ((req: GeminiAgentRequest) => Promise<GeminiAgentResponse>)} */
let testHook = null;

/**
 * @typedef {{ model: string, systemInstruction: string, tools: object[], toolConfig?: object, contents: object[], generationConfig?: object }} GeminiAgentRequest
 * @typedef {{ content: { role: string, parts: object[] }, finishReason?: string, usage: { promptTokens: number, cachedTokens: number, outputTokens: number, thoughtsTokens: number } }} GeminiAgentResponse
 */

export function setGeminiAgentForTests(fn) {
  testHook = fn;
}

export function clearGeminiAgentForTests() {
  testHook = null;
}

export function geminiAgentTestHookActive() {
  return Boolean(testHook);
}

function timeoutMs() {
  const raw = Number(env.ASSISTANT_LLM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 3_000 ? raw : 20_000;
}

function normalizeUsage(meta = {}) {
  return {
    promptTokens: Number(meta.promptTokenCount ?? 0),
    cachedTokens: Number(meta.cachedContentTokenCount ?? 0),
    outputTokens: Number(meta.candidatesTokenCount ?? 0),
    thoughtsTokens: Number(meta.thoughtsTokenCount ?? 0),
  };
}

function isRetryable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * @param {GeminiAgentRequest} request
 * @returns {Promise<GeminiAgentResponse>}
 */
export async function generateAgentTurn(request) {
  if (testHook) {
    const out = await testHook(request);
    return {
      content: out?.content ?? { role: "model", parts: [] },
      finishReason: out?.finishReason ?? "STOP",
      usage: { promptTokens: 0, cachedTokens: 0, outputTokens: 0, thoughtsTokens: 0, ...(out?.usage ?? {}) },
    };
  }
  const apiKey = String(env.GEMINI_API_KEY ?? "").trim();
  if (!env.ASSISTANT_ENABLED || !apiKey) {
    throw new AppError("ASSISTANT_DISABLED", "Analytics assistant is not enabled on this server.", 503);
  }
  const model = request.model;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: request.systemInstruction }] },
    tools: request.tools,
    ...(request.toolConfig ? { toolConfig: request.toolConfig } : {}),
    contents: request.contents,
    ...(request.generationConfig ? { generationConfig: request.generationConfig } : {}),
  };

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs()),
      });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        lastError = new AppError("ASSISTANT_LLM_TIMEOUT", "Assistant request timed out.", 504);
      } else {
        lastError = new AppError("ASSISTANT_LLM_ERROR", "Could not reach the AI service.", 502);
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      throw lastError;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let message = "The AI service returned an error.";
      try {
        const parsed = JSON.parse(detail);
        if (typeof parsed?.error?.message === "string") message = parsed.error.message;
      } catch {
        /* keep generic */
      }
      lastError = new AppError("ASSISTANT_LLM_ERROR", message, 502, {
        status: res.status,
        detail: detail.slice(0, 500),
      });
      if (attempt === 0 && isRetryable(res.status)) {
        await new Promise((r) => setTimeout(r, res.status === 429 ? 1500 : 700));
        continue;
      }
      throw lastError;
    }
    const json = await res.json();
    const candidate = json?.candidates?.[0];
    const content = candidate?.content ?? { role: "model", parts: [] };
    if (!content.role) content.role = "model";
    if (!Array.isArray(content.parts)) content.parts = [];
    return {
      content,
      finishReason: candidate?.finishReason ?? json?.promptFeedback?.blockReason ?? "STOP",
      usage: normalizeUsage(json?.usageMetadata),
    };
  }
  throw lastError ?? new AppError("ASSISTANT_LLM_ERROR", "The AI service returned an error.", 502);
}
