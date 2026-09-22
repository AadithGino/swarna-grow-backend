import test from "node:test";
import assert from "node:assert/strict";
import {
  customerNotificationDedupeKey,
  dedupeCustomerNotificationRows,
} from "../src/lib/customer-notification-dto.js";
import { buildReminderDedupeKey } from "../src/lib/reminder-dedupe.js";
import { claimReminderMessage } from "../src/services/reminder-message.service.js";
import { Message } from "../src/models/index.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("dedupe key separates due cycles without paymentId", () => {
  const base = { type: "PAYMENT_DUE", schemeId: "sch_1", templateParams: {} };
  const a = customerNotificationDedupeKey({
    ...base,
    templateParams: { installmentNumber: 3, reminderDate: "2026-09-01" },
  });
  const b = customerNotificationDedupeKey({
    ...base,
    templateParams: { installmentNumber: 4, reminderDate: "2026-10-01" },
  });
  assert.notEqual(a, b);
});

test("dedupe key prefers reminderDedupeKey from outbox claim", () => {
  const key = buildReminderDedupeKey({
    tenantId: "tnt_1",
    schemeId: "sch_1",
    messageType: "PAYMENT_DUE",
    channel: "PUSH",
    offsetKey: "D-3",
    reminderDate: "2026-09-22",
    installmentNumber: 2,
  });
  assert.equal(
    customerNotificationDedupeKey({ type: "PAYMENT_DUE", schemeId: "sch_1", reminderDedupeKey: key }),
    key,
  );
});

test("same event sequential replay creates one reminder row", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const schemeId = "sch_dedupe_1";
  const args = {
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    schemeId,
    type: "PAYMENT_DUE",
    channel: "PUSH",
    offsetKey: "D-0",
    reminderDate: "2026-09-22",
    installmentNumber: 5,
    templateKey: "PAYMENT_DUE",
    templateParams: {},
  };
  const first = await claimReminderMessage(args);
  const second = await claimReminderMessage(args);
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(await Message.countDocuments({ schemeId }), 1);
});

test("concurrent claim of same reminder remains idempotent", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const schemeId = "sch_concurrent";
  const args = {
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    schemeId,
    type: "PAYMENT_DUE",
    channel: "WHATSAPP",
    offsetKey: "D-1",
    reminderDate: "2026-09-23",
    installmentNumber: 6,
    templateKey: "PAYMENT_DUE",
    templateParams: {},
  };
  const results = await Promise.all([
    claimReminderMessage(args),
    claimReminderMessage(args),
    claimReminderMessage(args),
  ]);
  const created = results.filter(Boolean);
  assert.equal(created.length, 1);
  assert.equal(await Message.countDocuments({ schemeId }), 1);
});

test("read state on one deduped channel row does not mark another event read", () => {
  const rows = dedupeCustomerNotificationRows([
    {
      _id: "a",
      type: "PAYMENT_DUE",
      schemeId: "sch_1",
      channel: "PUSH",
      templateParams: { installmentNumber: 1, reminderDate: "2026-08-01" },
      createdAt: "2026-08-01T10:00:00.000Z",
      readAt: new Date("2026-08-02T10:00:00.000Z"),
    },
    {
      _id: "b",
      type: "PAYMENT_DUE",
      schemeId: "sch_1",
      channel: "PUSH",
      templateParams: { installmentNumber: 2, reminderDate: "2026-09-01" },
      createdAt: "2026-09-01T10:00:00.000Z",
      readAt: null,
    },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r._id === "b")?.readAt, null);
});
