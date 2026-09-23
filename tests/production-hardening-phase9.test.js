import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AlertStatus, AlertType, TenantRole } from "../src/constants/enums.js";
import { AppError } from "../src/lib/app-error.js";
import { percentOfPaiseHalfUp } from "../src/lib/money.js";
import {
  reopenOperationalAlert,
  resolveOperationalAlert,
  upsertOperationalAlert,
} from "../src/lib/operational-alert.js";
import {
  phonePeProvider,
  submitPhonePeCheckoutPayment,
} from "../src/integrations/phonepe.provider.js";
import { reportDataScope } from "../src/services/report-builders/report-envelope.js";
import { createInvoice } from "../src/services/platform.service.js";
import { Alert, Invoice } from "../src/models/index.js";
import {
  bearerFor,
  resetTestDb,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("concurrent operational alert upserts leave a single OPEN alert", async () => {
  const tenantId = "tenant_alert_concurrency";
  const entityId = "pay_123";
  const payload = {
    tenantId,
    type: AlertType.GATEWAY_UNSUPPORTED_CALLBACK,
    entityId,
    title: "Unsupported callback",
    message: "Review required",
  };
  await Promise.all(Array.from({ length: 24 }, () => upsertOperationalAlert(payload)));
  const openCount = await Alert.countDocuments({
    tenantId,
    type: payload.type,
    entityId,
    status: AlertStatus.OPEN,
  });
  assert.equal(openCount, 1);
});

test("resolve then reopen operational alert", async () => {
  const tenantId = "tenant_alert_reopen";
  const entityId = "settlement_1";
  await upsertOperationalAlert({
    tenantId,
    type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
    entityId,
    title: "Mismatch",
    message: "Totals differ",
  });
  await resolveOperationalAlert({
    tenantId,
    type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
    entityId,
  });
  const resolved = await Alert.findOne({ tenantId, entityId, status: AlertStatus.RESOLVED }).lean();
  assert.ok(resolved?.resolvedAt);

  await reopenOperationalAlert({
    tenantId,
    type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
    entityId,
    title: "Mismatch reopened",
    message: "Still differs",
  });
  const open = await Alert.findOne({ tenantId, entityId, status: AlertStatus.OPEN }).lean();
  assert.ok(open);
  assert.equal(open.title, "Mismatch reopened");
  assert.ok(open.resolvedAt == null);
});

test("concurrent platform invoices receive unique sequential numbers", async () => {
  const { tenant } = await seedTenantUser({});
  const year = new Date().getFullYear();
  const invoices = await Promise.all(
    Array.from({ length: 8 }, () =>
      createInvoice(
        tenant._id,
        {
          amountPaise: 10_000,
          taxPercent: 18,
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          dueDate: "2026-02-07",
        },
        null,
      )),
  );
  const numbers = invoices.map((row) => row.invoiceNumber);
  assert.equal(new Set(numbers).size, numbers.length);
  for (const invoiceNumber of numbers) {
    assert.match(invoiceNumber, new RegExp(`^PLT/${year}/\\d{4}$`));
  }
  const persisted = await Invoice.find({ tenantId: tenant._id }).sort({ invoiceNumber: 1 }).lean();
  assert.equal(persisted.length, 8);
});

test("GST tax uses HALF_UP paise rounding boundaries", () => {
  assert.equal(percentOfPaiseHalfUp(999, 18), 180);
  assert.equal(percentOfPaiseHalfUp(994, 18), 179);
  assert.equal(percentOfPaiseHalfUp(1, 50), 1);
  assert.equal(percentOfPaiseHalfUp(0, 18), 0);
});

test("report export alias rejects invalid reportKey without 500", async () => {
  const { user } = await seedTenantUser({});
  const res = await request(app)
    .post("/api/v1/admin/reports/not-a-real-report/export")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ format: "CSV" });
  assert.ok(res.status >= 400 && res.status < 500);
  assert.notEqual(res.status, 500);
});

test("branch-scoped report data scope ignores foreign query branchId", async () => {
  const tenantId = "tenant_branch_scope";
  const branchA = "branch_a";
  const branchB = "branch_b";
  const req = {
    auth: { role: TenantRole.BRANCH_MANAGER, tenantId },
    scope: { tenantId, branchId: branchA },
    query: { branchId: branchB },
  };
  assert.equal(reportDataScope(req).branchId, branchA);
});

test("UPI-only PhonePe checkout does not fall back to standard checkout", async () => {
  let payCalls = 0;
  const client = {
    pay: async () => {
      payCalls += 1;
      throw new Error("restricted payment mode not supported");
    },
  };
  await assert.rejects(
    () =>
      submitPhonePeCheckoutPayment(client, {
        merchantOrderId: "intent_upi_only",
        amountPaise: 50_000,
        redirectUrl: "https://example.com/return",
        preferUpiIntentOnly: true,
      }),
    (error) =>
      error instanceof AppError && error.code === "PHONEPE_UPI_CHECKOUT_UNAVAILABLE",
  );
  assert.equal(payCalls, 1);
});

test("standard PhonePe checkout unchanged when UPI-only is disabled", async () => {
  const result = await phonePeProvider.createPayment({
    merchantOrderId: "intent_standard",
    amountPaise: 50_000,
    redirectUrl: "https://example.com/return",
    credentials: null,
    preferUpiIntentOnly: false,
  });
  assert.equal(result.status, "PENDING");
});
