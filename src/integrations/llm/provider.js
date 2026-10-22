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

async function interpretAndValidate(args, { allowRetry = true } = {}) {
  const raw = await interpretWithGemini(args);
  try {
    return validateAssistantAction(raw);
  } catch (err) {
    if (!allowRetry) throw err;
    try {
      const corrected = await interpretWithGemini({
        ...args,
        correction: { invalid: raw, reason: validationErrorMessage(err) },
      });
      return validateAssistantAction(corrected);
    } catch {
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
