import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNotificationContext,
  mapCustomerNotification,
} from "../src/lib/customer-notification-dto.js";

test("notification DTO — payment success avoids template key as title", () => {
  const ctx = buildNotificationContext({
    payments: [
      {
        _id: "pay_1",
        amountPaise: 750_000,
        receiptNumber: "RCP-1001",
        schemeId: "sch_1",
      },
    ],
    schemes: [
      {
        _id: "sch_1",
        enrollmentNumber: "ENR-0000123",
        planSnapshot: { name: "Akshaya 12 Month" },
      },
    ],
  });
  const dto = mapCustomerNotification(
    {
      _id: "msg_1",
      type: "PAYMENT_SUCCESS",
      templateKey: "PAYMENT_SUCCESS_TEXT_FALLBACK",
      templateParams: { paymentId: "pay_1" },
      schemeId: "sch_1",
      createdAt: "2026-09-15T14:21:00.000Z",
      readAt: null,
    },
    ctx,
  );
  assert.equal(dto.title, "Payment received");
  assert.match(dto.body, /₹/);
  assert.match(dto.body, /Akshaya 12 Month/);
  assert.match(dto.body, /ENR-0000123/);
  assert.equal(dto.type, "PAYMENT");
  assert.equal(dto.deepLink, "/payments/pay_1");
  assert.equal(dto.read, false);
});
