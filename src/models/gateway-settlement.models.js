import mongoose from "mongoose";
import { baseOptions, branchField, enumField, integerField, stringId, tenantField } from "./schema-helpers.js";

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

export const SettlementMismatchStatus = Object.freeze({
  OPEN: "OPEN",
  RESOLVED: "RESOLVED",
});

export const SettlementResolutionCategory = Object.freeze({
  PROVIDER_CONFIRMED: "PROVIDER_CONFIRMED",
  BANK_CONFIRMED: "BANK_CONFIRMED",
  TIMING_DIFFERENCE: "TIMING_DIFFERENCE",
  DUPLICATE_STATEMENT_ROW: "DUPLICATE_STATEMENT_ROW",
  INTERNAL_REFERENCE_CORRECTED: "INTERNAL_REFERENCE_CORRECTED",
  ACCEPTED_MANUAL_EXCEPTION: "ACCEPTED_MANUAL_EXCEPTION",
});

export const SettlementResolutionAction = Object.freeze({
  RESOLVE: "RESOLVE",
  REOPEN: "REOPEN",
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
    sourceFileName: String,
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

const settlementMismatchSchema = new mongoose.Schema(
  {
    _id: stringId("smm"),
    tenantId: tenantField,
    branchId: branchField,
    runId: { type: String, required: true, index: true },
    itemId: { type: String, required: true },
    reason: { type: String, required: true },
    status: enumField(SettlementMismatchStatus, { default: SettlementMismatchStatus.OPEN }),
    version: { type: Number, default: 0 },
    resolutionHistory: [{
      action: { type: String, required: true },
      category: String,
      reason: { type: String, required: true },
      actorId: { type: String, required: true },
      at: { type: Date, required: true },
      idempotencyKey: String,
    }],
    resolvedAt: Date,
    resolvedBy: String,
  },
  baseOptions,
);
settlementMismatchSchema.index({ tenantId: 1, runId: 1, itemId: 1 }, { unique: true });
settlementMismatchSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export const SettlementRun = mongoose.model("SettlementRun", settlementRunSchema);
export const SettlementItem = mongoose.model("SettlementItem", settlementItemSchema);
export const SettlementMismatch = mongoose.model("SettlementMismatch", settlementMismatchSchema);
