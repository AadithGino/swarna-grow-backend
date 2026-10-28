import mongoose from "mongoose";
import { baseOptions, enumField, stringId, tenantField } from "./schema-helpers.js";

export const AssistantRole = Object.freeze({
  USER: "USER",
  ASSISTANT: "ASSISTANT",
});

const conversationSchema = new mongoose.Schema(
  {
    _id: stringId("acv"),
    tenantId: tenantField,
    userId: { type: String, required: true, index: true },
    title: { type: String, default: "New chat" },
    lastMessageAt: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 0 },
    conversationFocus: {
      customerId: { type: String, default: undefined },
      customerName: { type: String, default: undefined },
      schemeId: { type: String, default: undefined },
      schemeLabel: { type: String, default: undefined },
    },
    lastResolvedPlan: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  baseOptions,
);
conversationSchema.index({ tenantId: 1, userId: 1, lastMessageAt: -1 });

const messageSchema = new mongoose.Schema(
  {
    _id: stringId("amg"),
    tenantId: tenantField,
    userId: { type: String, required: true },
    conversationId: { type: String, required: true },
    role: enumField(AssistantRole, { required: true }),
    text: String,
    bundle: mongoose.Schema.Types.Mixed,
  },
  baseOptions,
);
messageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 });
messageSchema.index({ tenantId: 1, userId: 1 });

/** Per-tenant, per-IST-day Sidekick usage: question count (daily cap) and LLM token cost. */
const usageDailySchema = new mongoose.Schema(
  {
    _id: stringId("aud"),
    tenantId: tenantField,
    day: { type: String, required: true },
    questions: { type: Number, default: 0 },
    llmCalls: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    cachedTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    costMicroUsd: { type: Number, default: 0 },
    toolCalls: { type: Number, default: 0 },
    model: String,
  },
  baseOptions,
);
usageDailySchema.index({ tenantId: 1, day: 1 }, { unique: true });

export const AssistantConversation = mongoose.model("AssistantConversation", conversationSchema);
export const AssistantUsageDaily = mongoose.model("AssistantUsageDaily", usageDailySchema);
export const AssistantMessage = mongoose.model("AssistantMessage", messageSchema);
