import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  customerNotificationDedupeKey,
  dedupeCustomerNotificationRows,
} from "../src/lib/customer-notification-dto.js";
import { claimReminderMessage } from "../src/services/reminder-message.service.js";
import { Message } from "../src/models/index.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });

describe("notification dedupe matrix", { concurrency: false }, () => {
  test.beforeEach(async () => { await resetTestDb(); });

  test("two tenants may share reminder key text without index collision", async () => {
    const a = await seedTenantUser();
    const b = await seedTenantUser();
    const ca = await seedCustomer({ tenantId: a.tenant._id, branchId: a.branch._id });
    const cb = await seedCustomer({ tenantId: b.tenant._id, branchId: b.branch._id });
    const args = {
      schemeId: "sch_shared",
      type: "PAYMENT_DUE",
      channel: "PUSH",
      offsetKey: "D-0",
      reminderDate: "2026-09-22",
      installmentNumber: 1,
      templateKey: "PAYMENT_DUE",
      templateParams: {},
    };
    const idA = await claimReminderMessage({ ...args, tenantId: a.tenant._id, branchId: a.branch._id, customerId: ca._id });
    const idB = await claimReminderMessage({ ...args, tenantId: b.tenant._id, branchId: b.branch._id, customerId: cb._id });
    assert.ok(idA);
    assert.ok(idB);
    assert.notEqual(idA, idB);
  });

  test("pagination order stable after dedupe", () => {
    const rows = dedupeCustomerNotificationRows([
      { _id: "3", type: "PAYMENT_DUE", schemeId: "s1", channel: "PUSH", templateParams: { installmentNumber: 3, reminderDate: "2026-09-03" }, createdAt: "2026-09-03T09:00:00.000Z" },
      { _id: "2", type: "PAYMENT_DUE", schemeId: "s1", channel: "PUSH", templateParams: { installmentNumber: 2, reminderDate: "2026-09-02" }, createdAt: "2026-09-02T09:00:00.000Z" },
      { _id: "1", type: "PAYMENT_DUE", schemeId: "s1", channel: "PUSH", templateParams: { installmentNumber: 1, reminderDate: "2026-09-01" }, createdAt: "2026-09-01T09:00:00.000Z" },
    ]);
    assert.deepEqual(rows.map((r) => r._id), ["3", "2", "1"]);
  });

  test("dedupe keys are non-empty for reminder rows", async () => {
    const { tenant, branch } = await seedTenantUser();
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    await claimReminderMessage({
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: customer._id,
      schemeId: "sch_1",
      type: "PAYMENT_DUE",
      channel: "WHATSAPP",
      offsetKey: "D-2",
      reminderDate: "2026-09-24",
      installmentNumber: 4,
      templateKey: "PAYMENT_DUE",
      templateParams: {},
    });
    const row = await Message.findOne({ tenantId: tenant._id, schemeId: "sch_1" }).lean();
    assert.ok(row.reminderDedupeKey);
    assert.ok(customerNotificationDedupeKey(row).length > 8);
  });

  test("same cycle different occurrence keys stay distinct in inbox dedupe", () => {
    const a = customerNotificationDedupeKey({
      type: "PAYMENT_DUE",
      schemeId: "sch_1",
      templateParams: { installmentNumber: 2, reminderDate: "2026-09-01", occurrenceKey: "occ-a" },
    });
    const b = customerNotificationDedupeKey({
      type: "PAYMENT_DUE",
      schemeId: "sch_1",
      templateParams: { installmentNumber: 2, reminderDate: "2026-09-01", occurrenceKey: "occ-b" },
    });
    assert.notEqual(a, b);
  });

  test("outbox retry converges to one message", async () => {
    const { tenant, branch } = await seedTenantUser();
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    const args = {
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: customer._id,
      schemeId: "sch_retry",
      type: "PAYMENT_DUE",
      channel: "PUSH",
      offsetKey: "D-1",
      reminderDate: "2026-09-25",
      installmentNumber: 2,
      templateKey: "PAYMENT_DUE",
      templateParams: {},
    };
    assert.ok(await claimReminderMessage(args));
    assert.equal(await claimReminderMessage(args), null);
    assert.equal(await Message.countDocuments({ tenantId: tenant._id, schemeId: "sch_retry" }), 1);
  });
});
