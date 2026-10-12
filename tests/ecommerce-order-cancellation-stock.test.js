import test from "node:test";
import assert from "node:assert/strict";
import { EcommerceOrderStatus, EcommerceStockPolicy } from "../src/constants/enums.js";
import { orderCancellationStockDispositionRequired } from "../src/lib/ecommerce-order-cancellation-stock.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { createId } from "../src/lib/ids.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("PAID with consumption evidence requires disposition", async () => {
  const { tenant } = await seedTenantUser({});
  const productId = createId("eprd");
  const order = {
    tenantId: tenant._id,
    status: EcommerceOrderStatus.PAID,
    stockConsumptionEvidence: [
      {
        productId,
        quantityDeducted: 1,
        stockPolicyAtConsumption: EcommerceStockPolicy.QUANTITY_TRACKED,
      },
    ],
    lines: [{ productId, quantity: 1 }],
  };
  assert.equal(await orderCancellationStockDispositionRequired(order, null), true);
});

test("PAID with evidence quantityDeducted zero skips disposition", async () => {
  const { tenant } = await seedTenantUser({});
  const productId = createId("eprd");
  const order = {
    tenantId: tenant._id,
    status: EcommerceOrderStatus.PAID,
    paidAt: new Date(),
    stockConsumptionEvidence: [
      {
        productId,
        quantityDeducted: 0,
        stockPolicyAtConsumption: EcommerceStockPolicy.MADE_TO_ORDER,
      },
    ],
    lines: [{ productId, quantity: 1 }],
  };
  assert.equal(await orderCancellationStockDispositionRequired(order, null), false);
});

test("legacy stockConsumedAt without evidence requires disposition", async () => {
  const { tenant } = await seedTenantUser({});
  const order = {
    tenantId: tenant._id,
    status: EcommerceOrderStatus.PAID,
    stockConsumedAt: new Date(),
    paidAt: new Date(),
    lines: [{ productId: createId("eprd"), quantity: 1 }],
  };
  assert.equal(await orderCancellationStockDispositionRequired(order, null), true);
});
