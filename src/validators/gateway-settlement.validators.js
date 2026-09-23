import { z } from "zod";
import { positivePaise } from "./common.validators.js";
import { SettlementResolutionCategory } from "../models/gateway-settlement.models.js";

const settlementItem = z.object({
  providerTransactionId: z.string().trim().max(120).optional(),
  providerRefundId: z.string().trim().max(120).optional(),
  expectedAmountPaise: positivePaise.optional(),
  settledAmountPaise: positivePaise,
  matchedPaymentId: z.string().trim().max(80).optional(),
  matchedRefundId: z.string().trim().max(80).optional(),
}).strict().refine(
  (row) => Boolean(row.providerTransactionId || row.providerRefundId),
  { message: "Each row needs providerTransactionId or providerRefundId" },
);

export const GATEWAY_SETTLEMENT_MAX_ITEMS = 5000;

export const gatewaySettlementUploadBody = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  contentType: z.enum(["CSV", "JSON"]).optional(),
  sourceFileName: z.string().trim().max(200).optional(),
  items: z.array(settlementItem).min(1).max(GATEWAY_SETTLEMENT_MAX_ITEMS),
}).strict();

export const paymentRefundInitiationBody = z.object({
  amountPaise: positivePaise,
  reason: z.string().trim().min(3).max(500),
}).strict();

export const paymentRefundReleaseBody = z.object({
  reason: z.string().trim().min(3).max(500),
  evidence: z.string().trim().max(2000).optional(),
  providerConfirmedNotAccepted: z.boolean().optional(),
}).strict();

export const settlementMismatchResolveBody = z.object({
  category: z.enum(Object.values(SettlementResolutionCategory)),
  reason: z.string().trim().min(3).max(500),
  expectedVersion: z.number().int().min(0).optional(),
}).strict();

export const settlementMismatchReopenBody = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();
