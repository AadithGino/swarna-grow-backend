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

export const AssistantConversation = mongoose.model("AssistantConversation", conversationSchema);
export const AssistantMessage = mongoose.model("AssistantMessage", messageSchema);
