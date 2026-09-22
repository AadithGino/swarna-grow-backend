import mongoose from "mongoose";
import { baseOptions, enumField, integerField, stringId, tenantField } from "./schema-helpers.js";

export const SettlementRunStatus = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  MATCHED: "MATCHED",
  MISMATCH: "MISMATCH",
  FAILED: "FAILED",
  MISSING_STATEMENT: "MISSING_STATEMENT",
});

export const SettlementSourceType = Object.freeze({
  UPLOAD: "UPLOAD",
  API: "API",
});

const settlementRunSchema = new mongoose.Schema(
  {
    _id: stringId("stl"),
    tenantId: tenantField,
    businessDate: { type: String, required: true },
    provider: { type: String, default: "PHONEPE" },
    sourceType: enumField(SettlementSourceType, { required: true }),
    status: enumField(SettlementRunStatus, { default: SettlementRunStatus.PENDING }),
    expectedCapturePaise: integerField({ default: 0, min: 0 }),
    expectedRefundPaise: integerField({ default: 0, min: 0 }),
    providerCapturePaise: integerField({ default: 0, min: 0 }),
    providerRefundPaise: integerField({ default: 0, min: 0 }),
    mismatchCapturePaise: integerField({ default: 0 }),
    mismatchRefundPaise: integerField({ default: 0 }),
    inputChecksum: String,
    startedAt: Date,
    completedAt: Date,
    leaseOwner: String,
    leaseExpiresAt: Date,
    resolutionReason: String,
    resolvedBy: String,
    resolvedAt: Date,
  },
  baseOptions,
);
settlementRunSchema.index({ tenantId: 1, businessDate: 1, provider: 1 }, { unique: true });

const settlementItemSchema = new mongoose.Schema(
  {
    _id: stringId("sti"),
    tenantId: tenantField,
    runId: { type: String, required: true, index: true },
    providerTransactionId: String,
    providerRefundId: String,
    expectedAmountPaise: integerField(),
    settledAmountPaise: integerField(),
    matchedPaymentId: String,
    matchedRefundId: String,
    mismatchReason: String,
  },
  baseOptions,
);

export const SettlementRun = mongoose.model("SettlementRun", settlementRunSchema);
export const SettlementItem = mongoose.model("SettlementItem", settlementItemSchema);
