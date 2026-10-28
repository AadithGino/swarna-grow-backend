import { AppError } from "../../lib/app-error.js";
import { env } from "../../config/env.js";
import { validateAssistantAction } from "../../validators/assistant.validators.js";
import { interpretWithGemini, narrateWithGemini } from "./gemini.js";

/** @type {null | ((args: import("./provider.js").InterpretArgs) => Promise<unknown>)} */
let testInterpretOverride = null;
/** @type {null | ((args: import("./provider.js").NarrateArgs) => Promise<string>)} */
let testNarrateOverride = null;

/**
 * @typedef {{ question: string, context: Record<string, unknown>, toolCatalog: Record<string, unknown>, history?: object[] }} InterpretArgs
 */

export function setAssistInterpretForTests(fn) {
  testInterpretOverride = fn;
}

/** True while a legacy-router test hook is installed (routes chat to the router engine). */
export function assistInterpretTestOverrideActive() {
  return Boolean(testInterpretOverride);
}

export function clearAssistInterpretForTests() {
  testInterpretOverride = null;
  testNarrateOverride = null;
}

export const CLARIFY_REPHRASE_ACTION = Object.freeze({
  kind: "clarify",
  question:
    'I didn\'t quite catch that — try rephrasing, e.g. "today\'s collection by branch", "overdue customers", or "top plans last month".',
});

export const CLARIFY_TRANSIENT_ACTION = Object.freeze({
  kind: "clarify",
  question: "I had trouble reading that just now — please try again or rephrase.",
});

const CLARIFY_REPHRASE = {
  kind: "clarify",
  question:
    'I didn\'t quite catch that — try rephrasing, e.g. "today\'s collection by branch", "overdue customers", or "top plans last month".',
};

const CLARIFY_TRANSIENT = {
  kind: "clarify",
  question: "I had trouble reading that just now — please try again or rephrase.",
};

function validationErrorMessage(err) {
  if (err?.issues?.length) return err.issues.map((i) => i.message).join("; ");
  return String(err?.message ?? err ?? "Invalid action");
}

function isTransientLlmError(err) {
  if (!(err instanceof AppError)) return false;
  return (
    err.code === "ASSISTANT_LLM_TIMEOUT" ||
    err.code === "ASSISTANT_LLM_ERROR" ||
    err.status === 502 ||
    err.status === 503 ||
    err.status === 504
  );
}

const ASSISTANT_INTERPRET_DEADLINE_MS = 45_000;

async function interpretWithGeminiBounded(args, { attempts = 2 } = {}) {
  const started = Date.now();
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    if (Date.now() - started >= ASSISTANT_INTERPRET_DEADLINE_MS) {
      throw new AppError("ASSISTANT_LLM_TIMEOUT", "Assistant request timed out.", 504);
    }
    try {
      return await interpretWithGemini(args);
    } catch (err) {
      lastErr = err;
      if (!isTransientLlmError(err) || i >= attempts - 1) throw err;
    }
  }
  throw lastErr;
}

async function interpretAndValidate(args, { allowRetry = true } = {}) {
  const raw = await interpretWithGeminiBounded(args);
  try {
    return validateAssistantAction(raw);
  } catch (err) {
    if (!allowRetry) throw err;
    try {
      const corrected = await interpretWithGeminiBounded({
        ...args,
        correction: { invalid: raw, reason: validationErrorMessage(err) },
      });
      return validateAssistantAction(corrected);
    } catch (retryErr) {
      if (isTransientLlmError(retryErr)) return CLARIFY_TRANSIENT;
      return CLARIFY_REPHRASE;
    }
  }
}

/**
 * @typedef {{ question: string, facts: Record<string, unknown> }} NarrateArgs
 */

export function setAssistNarrateForTests(fn) {
  testNarrateOverride = fn;
}

export function clearAssistNarrateForTests() {
  testNarrateOverride = null;
}

/**
 * @param {InterpretArgs} args
 * @returns {Promise<import("../../validators/assistant.validators.js").assistantActionSchema extends infer T ? T : never>}
 */
export async function interpret(args) {
  if (testInterpretOverride) {
    const raw = await testInterpretOverride(args);
    try {
      return validateAssistantAction(raw);
    } catch (err) {
      if (args.correction) throw err;
      try {
        const corrected = await testInterpretOverride({
          ...args,
          correction: { invalid: raw, reason: validationErrorMessage(err) },
        });
        return validateAssistantAction(corrected);
      } catch {
        return CLARIFY_REPHRASE;
      }
    }
  }
  if (!env.ASSISTANT_ENABLED || !String(env.GEMINI_API_KEY ?? "").trim()) {
    throw new AppError(
      "ASSISTANT_DISABLED",
      "Analytics assistant is not enabled on this server.",
      503,
    );
  }
  return interpretAndValidate(args);
}

export { CLARIFY_TRANSIENT };

/**
 * @param {NarrateArgs} args
 * @returns {Promise<string>}
 */
export async function narrate(args) {
  if (testNarrateOverride) {
    return testNarrateOverride(args);
  }
  if (!env.ASSISTANT_ENABLED || !String(env.GEMINI_API_KEY ?? "").trim()) {
    throw new AppError(
      "ASSISTANT_DISABLED",
      "Analytics assistant is not enabled on this server.",
      503,
    );
  }
  return narrateWithGemini(args);
}
