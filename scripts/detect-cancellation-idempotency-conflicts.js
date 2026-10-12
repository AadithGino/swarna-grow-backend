#!/usr/bin/env node
/**
 * Report tenant/idempotencyKey pairs used on more than one cancellation request
 * before applying unique index ecommerce_cancellation_idempotency_tenant_key.
 *
 * Usage: node --env-file=.env scripts/detect-cancellation-idempotency-conflicts.js
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { EcommerceOrderCancellationRequest } from "../src/models/index.js";

await connectDatabase();
try {
  const rows = await EcommerceOrderCancellationRequest.aggregate([
    { $match: { idempotencyKey: { $type: "string", $ne: "" } } },
    {
      $group: {
        _id: { tenantId: "$tenantId", idempotencyKey: "$idempotencyKey" },
        count: { $sum: 1 },
        orders: { $addToSet: "$orderId" },
        customers: { $addToSet: "$customerId" },
        requestIds: { $push: "$_id" },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (!rows.length) {
    console.log("No conflicting cancellation idempotency keys found.");
    process.exit(0);
  }
  console.error(`Found ${rows.length} conflicting idempotency key group(s):`);
  for (const row of rows) {
    console.error(JSON.stringify(row, null, 2));
  }
  process.exit(2);
} finally {
  await disconnectDatabase();
}
