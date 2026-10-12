import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAdminOrderListMongoFilter,
  parseAdminOrderListDate,
} from "../src/lib/ecommerce-admin-order-list-filter.js";

test("parseAdminOrderListDate endOfDay for date-only strings", () => {
  const end = parseAdminOrderListDate("2026-01-15", { endOfDay: true });
  assert.ok(end);
  assert.equal(end.getUTCHours(), 23);
});

test("buildAdminOrderListMongoFilter applies status, payment, dates, q", () => {
  const filter = buildAdminOrderListMongoFilter("tenant_1", {
    status: "PAID",
    paymentMethod: "COD",
    paymentException: "true",
    createdFrom: "2026-01-01",
    createdTo: "2026-01-31",
    q: "EC-ABC",
  });
  assert.equal(filter.tenantId, "tenant_1");
  assert.equal(filter.status, "PAID");
  assert.equal(filter.paymentMethod, "COD");
  assert.ok(filter.paymentExceptionStatus);
  assert.ok(filter.createdAt?.$gte);
  assert.ok(filter.createdAt?.$lte);
  assert.ok(Array.isArray(filter.$or));
});
