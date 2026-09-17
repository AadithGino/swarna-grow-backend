import test from "node:test";
import assert from "node:assert/strict";
import { Customer } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { customerAnalytics } from "../src/services/customer.service.js";
import { CustomerStatus, TenantRole } from "../src/constants/enums.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import {
  assertAnalyticsPeriod,
  inferTrendGroupBy,
  rollupDailyRegistrationCounts,
} from "../src/lib/analytics-period.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("analytics period validation rejects invalid and oversized ranges", () => {
  assert.throws(
    () => assertAnalyticsPeriod({ period: "CUSTOM", from: "2026-09-10", to: "2026-09-01" }),
    (err) => err.code === "ANALYTICS_RANGE_INVALID",
  );
  assert.throws(
    () => assertAnalyticsPeriod({ period: "CUSTOM", from: "2010-01-01", to: "2026-12-31" }),
    (err) => err.code === "ANALYTICS_RANGE_TOO_LARGE",
  );
});

test("registration trend buckets are zero-filled by day", () => {
  const groupBy = inferTrendGroupBy("2026-09-01", "2026-09-03");
  assert.equal(groupBy, "DAY");
  const buckets = rollupDailyRegistrationCounts(
    [{ _id: "2026-09-02", count: 4 }],
    "2026-09-01",
    "2026-09-03",
    groupBy,
  );
  assert.deepEqual(buckets, [
    { key: "2026-09-01", count: 0 },
    { key: "2026-09-02", count: 4 },
    { key: "2026-09-03", count: 0 },
  ]);
});

test("customer analytics returns period-scoped registration trend", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  await Customer.create([
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerNumber: "C-ANA-1",
      name: "Period One",
      mobile: "+919811100001",
      status: CustomerStatus.ACTIVE,
      createdAt: new Date("2026-09-01T10:00:00+05:30"),
    },
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerNumber: "C-ANA-2",
      name: "Period Two",
      mobile: "+919811100002",
      status: CustomerStatus.ACTIVE,
      createdAt: new Date("2026-09-02T10:00:00+05:30"),
    },
    {
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerNumber: "C-ANA-3",
      name: "Outside Period",
      mobile: "+919811100003",
      status: CustomerStatus.ACTIVE,
      createdAt: new Date("2026-08-15T10:00:00+05:30"),
    },
  ]);

  const result = await customerAnalytics({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
    scope: { tenantId: tenant._id },
    query: { period: "CUSTOM", from: "2026-09-01", to: "2026-09-03" },
  });

  assert.equal(result.total, 3);
  assert.equal(result.newCustomersInPeriod, 2);
  assert.equal(result.period.from, "2026-09-01");
  assert.equal(result.period.to, "2026-09-03");
  const trend = result.charts.registrationTrend.series[0].data;
  assert.equal(trend.length, 3);
  assert.equal(trend[0].y, 1);
  assert.equal(trend[1].y, 1);
  assert.equal(trend[2].y, 0);
});
