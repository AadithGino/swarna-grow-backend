/**
 * Clear stuck digital-metal buy payment initiation (uncertain idempotency / no SDK token).
 * Usage: node --env-file=.env scripts/reset-digital-metal-buy-payment-attempt.js <buyOrderId>
 */
import process from "node:process";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { DigitalMetalBuyOrder, DigitalMetalBuyPaymentAttempt, IdempotencyRecord } from "../src/models/index.js";

const orderId = process.argv[2]?.trim();
if (!orderId) {
  console.error("Usage: reset-digital-metal-buy-payment-attempt.js <buyOrderId>");
  process.exit(1);
}

async function main() {
  await connectDatabase();
  const order = await DigitalMetalBuyOrder.findById(orderId).lean();
  if (!order) throw new Error(`Buy order not found: ${orderId}`);

  const attempts = await DigitalMetalBuyPaymentAttempt.find({
    tenantId: order.tenantId,
    orderId: order._id,
  }).lean();
  console.log(`Order ${orderId} status=${order.status} attempts=${attempts.length}`);

  for (const row of attempts) {
    if (row.sdkToken && row.status === "INITIATED") {
      console.log(`  skip initiated attempt ${row._id} (has sdk token)`);
      continue;
    }
    await DigitalMetalBuyPaymentAttempt.updateOne(
      { _id: row._id },
      {
        $set: { status: "PENDING" },
        $unset: {
          failureReason: "",
          sdkToken: "",
          providerOrderId: "",
          gatewayReconcileNextAt: "",
        },
        $inc: { version: 1 },
      },
    );
    console.log(`  reset attempt ${row._id}`);
    if (row.idempotencyKey) {
      const del = await IdempotencyRecord.deleteMany({
        tenantId: order.tenantId,
        key: row.idempotencyKey,
      });
      console.log(`  deleted ${del.deletedCount} idempotency row(s) for key ${row.idempotencyKey}`);
    }
  }

  if (order.status === "PAYMENT_PENDING" || order.status === "PAYMENT_FAILED") {
    await DigitalMetalBuyOrder.updateOne(
      { _id: order._id },
      { $set: { status: "QUOTE_ACCEPTED" }, $inc: { version: 1 } },
    );
    console.log("Order status set to QUOTE_ACCEPTED (payable again).");
  }
}

main()
  .then(() => disconnectDatabase())
  .catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });
