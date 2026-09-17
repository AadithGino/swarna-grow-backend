import test from "node:test";
import assert from "node:assert/strict";
import { Scheme } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { schemeAnalytics } from "../src/services/scheme.service.js";
import { PaymentPattern, SchemeStatus, TenantRole } from "../src/constants/enums.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("scheme analytics returns zero-filled enrollment trend for period", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Scheme.create([
    {
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: "ENR-ANA-1",
      planSnapshot: {
        name: "Gold 11",
        displayName: "Gold 11",
        installmentCount: 11,
        durationMonths: 11,
      },
      valueBasis: "CASH",
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-09-01",
      maturityDate: "2026-08-01",
      installmentAmountPaise: 100_000,
      installments: [{ number: 1, dueDate: "2026-09-01", amountPaise: 100_000, paidPaise: 0, status: "DUE" }],
      createdAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("scheme"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerId: createId("customer"),
      planId: createId("schemePlan"),
      enrollmentNumber: "ENR-ANA-2",
      planSnapshot: {
        name: "Gold 11",
        displayName: "Gold 11",
        installmentCount: 11,
        durationMonths: 11,
      },
      valueBasis: "CASH",
      paymentPattern: PaymentPattern.FIXED,
      status: SchemeStatus.ACTIVE,
      startDate: "2026-08-01",
      maturityDate: "2026-07-01",
      installmentAmountPaise: 100_000,
      installments: [{ number: 1, dueDate: "2026-08-01", amountPaise: 100_000, paidPaise: 0, status: "DUE" }],
      createdAt: new Date("2026-08-20T10:00:00+05:30"),
    },
  ]);

  const result = await schemeAnalytics({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
    scope: { tenantId: tenant._id },
    query: { period: "CUSTOM", from: "2026-09-01", to: "2026-09-03" },
  });

  assert.equal(result.total, 2);
  assert.equal(result.newEnrollmentsInPeriod, 1);
  const trend = result.charts.enrollmentTrend.series[0].data;
  assert.equal(trend.length, 3);
  assert.equal(trend[0].y, 0);
  assert.equal(trend[1].y, 1);
  assert.equal(trend[2].y, 0);
  assert.ok(result.charts.schemeStatusDistribution);
  assert.ok(result.charts.paymentPatternDistribution);
});
