/**
 * Instant replies for small talk ("hi", "thanks", "ok", "bye", "who are you").
 * These never need shop data, so answering them locally skips the model entirely:
 * the owner gets a reply in milliseconds and no daily question is spent.
 *
 * Matching is deliberately strict — the whole message must be small talk (≤ 5 words,
 * no digits). Anything with a real question in it still goes to the agent.
 */

const GREETING = /^(hi+|hii+|hello+|hey+|hai|helo|namaste|namaskar(am)?|vanakkam|good\s*(morning|afternoon|evening|day)|gm|yo)$/;
const THANKS = /^(thanks?|thank\s*(you|u)|thx|ty|tq|thankyou|thanks\s*a\s*lot|many\s*thanks|great|awesome|nice|super|perfect|cool|nandi|dhanyavad|shukriya)$/;
const ACK = /^(ok(ay)?|k|kk|fine|got\s*it|alright|sure|noted|hmm+|right)$/;
const BYE = /^(bye|good\s*bye|goodbye|see\s*you|cya|good\s*night|gn|tata)$/;
const WHO = /^(who\s*are\s*you|what\s*(are|can)\s*you(\s*do)?|what\s*is\s*sidekick|help|what\s*can\s*i\s*ask(\s*you)?)$/;

const STARTERS = [
  "How much did we collect this month?",
  "Who has overdue instalments?",
  "Show today's Digi Gold activity",
];

function normalize(message) {
  return String(message ?? "")
    .toLowerCase()
    .replace(/[!.?,🙏👍😊🙂]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*(sidekick|bro|sir|madam|there|team)$/u, "")
    .trim();
}

/**
 * @param {string} message
 * @param {{ firstName?: string | null }} [opts]
 * @returns {null | { answer: string, title: string, followUps: string[] }}
 */
export function instantReply(message, opts = {}) {
  const text = normalize(message);
  if (!text || text.length > 40 || /\d/.test(text) || text.split(" ").length > 5) return null;
  const name = opts.firstName ? ` ${opts.firstName}` : "";

  if (GREETING.test(text)) {
    return {
      title: "Hello",
      answer: `Hi${name}! Ask me anything about your collections, customers, schemes, Digi Gold or store orders.`,
      followUps: STARTERS,
    };
  }
  if (THANKS.test(text)) {
    return { title: "You're welcome", answer: "Happy to help! Anything else you'd like to check?", followUps: STARTERS.slice(0, 2) };
  }
  if (ACK.test(text)) {
    return { title: "Sidekick", answer: "Sure. What would you like to look at next?", followUps: STARTERS };
  }
  if (BYE.test(text)) {
    return { title: "Goodbye", answer: "Bye for now! I'll be here whenever you need numbers.", followUps: [] };
  }
  if (WHO.test(text)) {
    return {
      title: "What I can do",
      answer:
        "I'm Sidekick, your shop's analyst. I read your live data to answer questions about **collections, dues, customers, schemes, Digi Gold and store orders**, and I can explain gold or scheme terms. I can't change records — I'll point you to the right screen for that.",
      followUps: STARTERS,
    };
  }
  return null;
}
