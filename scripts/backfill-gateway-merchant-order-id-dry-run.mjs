#!/usr/bin/env node
/**
 * Read-only staging report for gatewayMerchantOrderId backfill (AUD-03).
 * Does not write to production databases.
 */
import { env } from "../src/config/env.js";
import mongoose from "mongoose";
import { PaymentMode } from "../src/constants/enums.js";
import { resolveGatewayMerchantOrderIdForPayment } from "../src/lib/phonepe-gateway-merchant-order-id.js";
import { Payment } from "../src/models/index.js";

const apply = process.argv.includes("--apply");
if (apply) {
  console.error("This tool is dry-run only. Remove --apply.");
  process.exit(2);
}

await mongoose.connect(env.MONGODB_URI);

const cursor = Payment.find({
  mode: PaymentMode.ONLINE_GATEWAY,
  $or: [{ gatewayMerchantOrderId: null }, { gatewayMerchantOrderId: { $exists: false } }],
})
  .select("_id tenantId receiptNumber gatewayMerchantOrderId providerTransactionId status")
  .lean()
  .cursor();

let scanned = 0;
let resolved = 0;
let ambiguous = 0;
const ambiguityReport = [];

for await (const payment of cursor) {
  scanned += 1;
  const candidate = await resolveGatewayMerchantOrderIdForPayment(payment);
  if (!candidate) {
    ambiguous += 1;
    ambiguityReport.push({
      paymentId: payment._id,
      tenantId: payment.tenantId,
      receiptNumber: payment.receiptNumber,
      providerTransactionId: payment.providerTransactionId ?? null,
      reason: "NO_VERIFIED_MERCHANT_ORDER_ID",
    });
    continue;
  }
  if (candidate === payment.providerTransactionId) {
    ambiguous += 1;
    ambiguityReport.push({
      paymentId: payment._id,
      tenantId: payment.tenantId,
      candidate,
      reason: "COLLIDES_WITH_PROVIDER_ORDER_ID",
    });
    continue;
  }
  resolved += 1;
}

console.log(JSON.stringify({
  dryRun: true,
  scanned,
  wouldSet: resolved,
  ambiguous,
  ambiguitySample: ambiguityReport.slice(0, 50),
}, null, 2));

await mongoose.disconnect();
