import { z } from "zod";
import { positivePaise } from "./common.validators.js";

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

export const gatewaySettlementUploadBody = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(settlementItem).min(1).max(5000),
}).strict();
