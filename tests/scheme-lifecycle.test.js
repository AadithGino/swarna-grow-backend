import test from "node:test";
import assert from "node:assert/strict";
import { AuditEvent, Customer, Scheme } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { processScheduler } from "../src/workers/processors.js";
import { recordPayment } from "../src/services/payment.service.js";
import { applyFlexibleLock } from "../src/services/scheme.service.js";
import { FlexiblePhase, SchemeStatus, TenantRole } from "../src/constants/enums.js";
import { connectRedis, disconnectRedis } from "../src/config/redis.js";
import {
  MaintenanceScanStream,
  clearMaintenanceScanCursor,
  clearMaintenanceScanLease,
} from "../src/lib/maintenance-scan-cursor.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await connectRedis();
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
  await disconnectRedis().catch(() => {});
});
test.beforeEach(async () => {
  await resetTestDb();
  await clearMaintenanceScanCursor(MaintenanceScanStream.DEFAULTING);
  await clearMaintenanceScanCursor(MaintenanceScanStream.FLEXIBLE_LOCK);
  await clearMaintenanceScanLease(MaintenanceScanStream.DEFAULTING);
  await clearMaintenanceScanLease(MaintenanceScanStream.FLEXIBLE_LOCK);
});

async function seedFixedSchemeWithOverdues({ maxAllowedDefaults = 2, overdueCount = 2 }) {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
    mobile: `+9197${String(Date.now()).slice(-8)}`,
  });
  let overdueRemaining = overdueCount;
  const installments = [1, 2, 3].map((number) => {
    const paidPaise = number === 1 ? 10000 : 0;
    const amountPaise = 10000;
    let status;
    if (paidPaise >= amountPaise) {
      status = "PAID";
    } else if (overdueRemaining > 0) {
      status = "OVERDUE";
      overdueRemaining -= 1;
    } else {
      status = "PENDING";
    }
    return {
      number,
      dueDate: `2025-0${number}-05`,
      amountPaise,
      paidPaise,
      status,
      graceEndsAt: `2025-0${number}-10`,
    };
  });
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C-LC-${Date.now()}`,
    name: "Lifecycle Customer",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-LC-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      benefit: { eligibility: { maxAllowedDefaults } },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2025-01-01",
    maturityDate: "2025-12-01",
    installmentAmountPaise: 10000,
    installments,
    version: 1,
    createdBy: user._id,
  });
  return { tenant, branch, user, scheme };
}

test("defaulting job transitions scheme when overdue threshold met", async () => {
  // Default when overdue count *exceeds* maxAllowedDefaults (see processScheduler defaulting job).
  const { scheme } = await seedFixedSchemeWithOverdues({ maxAllowedDefaults: 1, overdueCount: 2 });
  await processScheduler({ name: "defaulting", data: {} });
  const updated = await Scheme.findById(scheme._id).lean();
  assert.equal(updated.status, SchemeStatus.DEFAULTED);
});

test("defaulting job is idempotent", async () => {
  const { scheme } = await seedFixedSchemeWithOverdues({ maxAllowedDefaults: 1, overdueCount: 2 });
  await processScheduler({ name: "defaulting", data: {} });
  const auditsBefore = await AuditEvent.countDocuments({ entityId: scheme._id, action: "SCHEME_DEFAULTED" });
  await processScheduler({ name: "defaulting", data: {} });
  const auditsAfter = await AuditEvent.countDocuments({ entityId: scheme._id, action: "SCHEME_DEFAULTED" });
  assert.equal(auditsBefore, 1);
  assert.equal(auditsAfter, 1);
});

test("payment clears DEFAULTED scheme when overdue is resolved", async () => {
  const { scheme, user } = await seedFixedSchemeWithOverdues({ maxAllowedDefaults: 1, overdueCount: 2 });
  await Scheme.updateOne({ _id: scheme._id }, { $set: { status: SchemeStatus.DEFAULTED } });
  const payReq = (expectedVersion) => ({
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    baseUrl: "/api/v1/admin",
    headers: {},
    ip: "127.0.0.1",
    body: { schemeId: scheme._id, amountPaise: 10000, mode: "CASH", expectedVersion },
    query: {},
  });
  await recordPayment(payReq(1));
  await recordPayment(payReq(2));
  const updated = await Scheme.findById(scheme._id).lean();
  assert.equal(updated.status, SchemeStatus.ACTIVE);
  assert.ok(updated.installments.every((row) => row.status !== "OVERDUE"));
});

test("apply-flexible-locks job applies cap after free window", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: createId("customer"),
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-FLX-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FLEXIBLE",
      flexibleRules: {
        flexiblePhaseCycles: 1,
        averagingDivisor: 1,
        flexiblePhase: { minTotalPaise: 0 },
        capComputation: {
          roundToNearestPaise: 100,
          minCycleCapPaise: 10000,
          maxCycleCapPaise: 500000,
          onZeroFlexiblePhaseTotal: "USE_MINIMUM",
          onBelowMinimumTotal: "USE_MINIMUM",
        },
      },
    },
    valueBasis: "CASH",
    paymentPattern: "FLEXIBLE",
    flexiblePhase: FlexiblePhase.FLEXIBLE,
    status: SchemeStatus.ACTIVE,
    startDate: "2024-01-01",
    maturityDate: "2025-12-01",
    cycles: [{ cycle: "2024-01", capPaise: 0, paidPaise: 50000, remainingPaise: 0, status: "PAID", expiresAt: "2024-01-31" }],
    version: 1,
    createdBy: user._id,
  });
  await processScheduler({ name: "apply-flexible-locks", data: {} });
  const locked = await Scheme.findById(scheme._id).lean();
  assert.equal(locked.flexiblePhase, FlexiblePhase.CAPPED);
  assert.ok(locked.lockedAveragePaise > 0);
  await applyFlexibleLock({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { schemeId: scheme._id },
    headers: {},
    ip: "test",
  }).then(
    () => assert.fail("expected LOCK_ALREADY_APPLIED"),
    (error) => assert.equal(error.code, "LOCK_ALREADY_APPLIED"),
  );
});
