import test from "node:test";
import assert from "node:assert/strict";
import { Customer, Scheme } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { listCustomers } from "../src/services/customer.service.js";
import { SchemeStatus, TenantRole } from "../src/constants/enums.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("customer list shows overdue amount from raw installments", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C-DUE-1",
    name: "=1+1",
    mobile: "+919811122233",
  });
  await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    planId: createId("schemePlan"),
    enrollmentNumber: "ENR-DUE-1",
    planSnapshot: { paymentPattern: "FIXED" },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: SchemeStatus.ACTIVE,
    startDate: "2025-01-01",
    maturityDate: "2025-12-01",
    installmentAmountPaise: 10000,
    installments: [
      { number: 1, dueDate: "2025-01-05", amountPaise: 10000, paidPaise: 10000, status: "PAID", graceEndsAt: "2025-01-10" },
      { number: 2, dueDate: "2025-02-05", amountPaise: 10000, paidPaise: 0, status: "OVERDUE", graceEndsAt: "2025-02-10" },
    ],
    version: 1,
    createdBy: user._id,
  });

  const result = await listCustomers({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER", role: TenantRole.TENANT_OWNER },
    scope: { tenantId: tenant._id },
    query: {},
  });
  const row = result.data.find((entry) => entry._id === customerId);
  assert.ok(row);
  assert.equal(row.overdue.amountPaise, 10000);
  assert.equal(row.nextDue.date, "2025-02-05");
  assert.equal(row.nextDue.amountPaise, 10000);
});
