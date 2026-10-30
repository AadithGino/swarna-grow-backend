import { GUIDE_CATALOG } from "./guide-catalog.js";

/**
 * On-screen walkthroughs Sidekick can launch in the admin portal.
 *
 * Each id matches a tour in the admin app (admin/src/lib/tours/registry.ts). When an
 * answer carries `guide: { id }`, the chat shows a "Show me step by step" button that
 * opens the right page and highlights every click. The steps below are the text
 * version, used in the answer itself and by the model.
 */

/**
 * The catalogue is generated from the portal's guide registry (admin/src/lib/tours)
 * by `pnpm guides:export` in admin/, so ids and steps always match what the portal runs.
 */
export const GUIDES = GUIDE_CATALOG;

export const GUIDE_IDS = Object.freeze(GUIDES.map((g) => g.id));

const BY_ID = new Map(GUIDES.map((g) => [g.id, g]));

export function getGuide(id) {
  return BY_ID.get(String(id ?? "").trim()) ?? null;
}

/** Compact catalogue for the tool description: "id: title" per guide. */
export function guideCatalogForPrompt() {
  return GUIDES.map((g) => `${g.id}: ${g.title}`).join("; ");
}

/** What the chat card needs; steps stay in the narrative. */
export function guideForClient(guide) {
  return { id: guide.id, title: guide.title };
}

/* ----------------------------- instant matching ----------------------------- */

const STOP = new Set(["a", "an", "the", "to", "in", "into", "for", "my", "our", "of", "on", "i", "do", "can"]);

function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

// "how do I…", "where is…", "steps to…", "kaise", "kahan", "sikhao", "forgot how"…
const HOW_INTENT =
  /\b(how|where|steps?|guide|tutorial|teach|show me|walk me|help me|forgot|forget|can'?t find|cannot find|unable to|not able to|kaise|kese|kaise karen?|kahan|kaha|kidhar|sikha|sikhao|batao|bataiye|samjhao)\b/;
// Data questions that merely mention a task ("how many customers were added?") go to the agent.
const DATA_QUESTION =
  /\b(how many|how much|improve|increase|reduce|why|better|grow|tips|advice|strategy|kitne|kitna|kitni|count|total|list|who|which|when|today'?s? (collection|payment)|this (week|month|year)|last (week|month|year)|yesterday|report of)\b|\d/;
const IMPERATIVE_START = /^(please\s+)?(add|create|new|set|update|record|enrol|enroll|register|make|publish|upload|collect|start)\b/;

function keywordScore(msgTokens, keyword) {
  const kw = tokens(keyword).filter((t) => !STOP.has(t));
  if (!kw.length) return 0;
  return kw.every((t) => msgTokens.has(t)) ? kw.length : 0;
}

/**
 * The guide a short "how do I…" message is clearly asking for, or null when it is
 * ambiguous, a data question, or not about a task (the agent handles those).
 */
export function matchGuideIntent(message) {
  const text = String(message ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text || text.length > 140) return null;
  if (DATA_QUESTION.test(text)) return null;
  const words = text.split(" ").length;
  const howIntent = HOW_INTENT.test(text);
  if (!howIntent && !(IMPERATIVE_START.test(text) && words <= 6)) return null;

  const msgTokens = new Set(tokens(text));
  const scored = GUIDES.map((g) => ({
    g,
    score: Math.max(0, ...[g.title, ...g.keywords].map((k) => keywordScore(msgTokens, k))),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  // Single-word hits ("enrol", "catalog") are fine; ties between guides are not.
  if (scored[1] && scored[1].score === scored[0].score) return null;
  if (scored[0].g.id === "welcome" && !howIntent) return null;
  return scored[0].g;
}

/** Instant (no-model) reply for a matched guide. */
export function guideInstantReply(guide) {
  const steps = guide.steps.map((step) => `- ${step}`).join("\n");
  const related = GUIDES.filter((g) => g.category === guide.category && g.id !== guide.id && g.id !== "welcome").slice(0, 2);
  return {
    title: guide.title,
    answer: `Here's how. Tap **Show me step by step** and I'll open the page and highlight each click for you.\n${steps}`,
    followUps: related.map((r) => `Show me how to ${r.title.charAt(0).toLowerCase()}${r.title.slice(1)}`),
  };
}
