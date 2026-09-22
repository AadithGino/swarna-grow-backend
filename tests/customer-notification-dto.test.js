import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNotificationContext,
  dedupeCustomerNotificationRows,
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

test("notification dedupe — WhatsApp and push rows collapse to one inbox item", () => {
  const base = {
    type: "PAYMENT_SUCCESS",
    schemeId: "sch_1",
    templateParams: { paymentId: "pay_1" },
    createdAt: "2026-09-22T05:06:00.000Z",
    readAt: null,
  };
  const deduped = dedupeCustomerNotificationRows([
    { _id: "msg_wa", channel: "WHATSAPP", ...base },
    { _id: "msg_push", channel: "PUSH", ...base },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]._id, "msg_push");
});

test("notification dedupe — separate due cycles for the same scheme stay distinct", () => {
  const deduped = dedupeCustomerNotificationRows([
    {
      _id: "due_a",
      type: "PAYMENT_DUE",
      schemeId: "sch_1",
      channel: "PUSH",
      templateParams: { installmentNumber: 2, reminderDate: "2026-08-01" },
      createdAt: "2026-08-01T09:00:00.000Z",
    },
    {
      _id: "due_b",
      type: "PAYMENT_DUE",
      schemeId: "sch_1",
      channel: "PUSH",
      templateParams: { installmentNumber: 3, reminderDate: "2026-09-01" },
      createdAt: "2026-09-01T09:00:00.000Z",
    },
  ]);
  assert.equal(deduped.length, 2);
});

test("notification dedupe — different event types for same scheme stay distinct", () => {
  const deduped = dedupeCustomerNotificationRows([
    {
      _id: "m1",
      type: "PAYMENT_DUE",
      schemeId: "sch_1",
      channel: "PUSH",
      templateParams: { installmentNumber: 1, reminderDate: "2026-09-01" },
      createdAt: "2026-09-01T09:00:00.000Z",
    },
    {
      _id: "m2",
      type: "SCHEME_MATURED",
      schemeId: "sch_1",
      channel: "PUSH",
      templateParams: { occurrenceKey: "maturity-2026-09-22" },
      createdAt: "2026-09-22T09:00:00.000Z",
    },
  ]);
  assert.equal(deduped.length, 2);
});
