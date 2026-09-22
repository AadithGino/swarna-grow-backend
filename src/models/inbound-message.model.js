import mongoose from "mongoose";
import { baseOptions, branchField, enumField, stringId, tenantField } from "./schema-helpers.js";

export const InboundMessageStatus = Object.freeze({
  RECEIVED: "RECEIVED",
  READ: "READ",
  UNMATCHED: "UNMATCHED",
});

const inboundMessageSchema = new mongoose.Schema(
  {
    _id: stringId("inb"),
    tenantId: tenantField,
    branchId: branchField,
    providerMessageId: { type: String, required: true },
    customerId: String,
    senderMobile: { type: String, required: true },
    messageType: { type: String, required: true },
    text: String,
    mediaMetadata: mongoose.Schema.Types.Mixed,
    receivedAt: { type: Date, required: true },
    status: enumField(InboundMessageStatus, { default: InboundMessageStatus.RECEIVED }),
    webhookEventId: String,
    readAt: Date,
    readBy: String,
    providerMetadata: mongoose.Schema.Types.Mixed,
  },
  baseOptions,
);
inboundMessageSchema.index({ tenantId: 1, providerMessageId: 1 }, { unique: true });
inboundMessageSchema.index({ tenantId: 1, branchId: 1, receivedAt: -1 });

export const InboundMessage = mongoose.model("InboundMessage", inboundMessageSchema);
