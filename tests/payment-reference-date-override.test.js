import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/lib/app-error.js";
import {
  rejectClientReferenceDateFields,
  resolveInternalPayableReferenceDate,
} from "../src/lib/payment-reference-date-override.js";
import { createId } from "../src/lib/ids.js";
import { Customer, Scheme, Session, User } from "../src/models/index.js";
import { TenantRole, UserStatus, UserType } from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import argon2 from "argon2";
import { recordPayment } from "../src/services/payment.service.js";
import { bearerFor, resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("rejectClientReferenceDateFields blocks body and query referenceDate", () => {
  assert.throws(
    () => rejectClientReferenceDateFields({ body: { referenceDate: "2020-01-15" }, query: {} }),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
  assert.throws(
    () => rejectClientReferenceDateFields({ body: {}, query: { referenceDate: "2020-01-15" } }),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
});

test("resolveInternalPayableReferenceDate requires internal flag outside production", () => {
  assert.equal(resolveInternalPayableReferenceDate({}), undefined);
  assert.throws(
    () => resolveInternalPayableReferenceDate({ referenceDate: "2020-01-15" }),
    (error) => error instanceof AppError && error.code === "REFERENCE_DATE_OVERRIDE_FORBIDDEN",
  );
  assert.equal(
    resolveInternalPayableReferenceDate({
      referenceDate: "2020-01-15",
      internalReferenceDateOverride: true,
    }),
    "2020-01-15",
  );
});

test("resolveInternalPayableReferenceDate is forbidden in production subprocess", () => {
  const script = `
    import { resolveInternalPayableReferenceDate } from "./src/lib/payment-reference-date-override.js";
    try {
      resolveInternalPayableReferenceDate({
        referenceDate: "2020-01-15",
        internalReferenceDateOverride: true,
      });
      process.exit(2);
    } catch (error) {
      process.exit(error.code === "REFERENCE_DATE_OVERRIDE_FORBIDDEN" ? 0 : 1);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NODE_ENV: "production" },
    cwd: process.cwd(),
  });
  assert.equal(result.status, 0);
});

test("admin POST /payments rejects referenceDate in body", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C-REF",
    name: "Ref",
    mobile: "+919811100001",
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "ENR-REF",
    planSnapshot: { paymentPattern: "FIXED", paymentRules: { partialPaymentAllowed: true } },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 100_000,
    installments: [{
      number: 1, dueDate: "2026-01-05", amountPaise: 100_000, paidPaise: 0, status: "DUE", graceEndsAt: "2026-01-10",
    }],
    version: 1,
    createdBy: user._id,
  });
  const token = bearerFor(user);
  const response = await request(app)
    .post("/api/v1/admin/payments")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", randomUUID())
    .send({
      schemeId: scheme._id,
      amountPaise: 10_000,
      mode: "CASH",
      expectedVersion: 1,
      referenceDate: "2020-01-15",
    })
    .expect(400);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("staff POST /payments rejects referenceDate in body", async () => {
  const { tenant, branch } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const user = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role: TenantRole.BRANCH_STAFF,
    name: "Staff",
    mobile: `+9196${String(Date.now()).slice(-8)}`,
    passwordHash: await argon2.hash("1234", { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[TenantRole.BRANCH_STAFF],
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    tenantId: tenant._id,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals = { testSessionId: session._id };
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "ENR-REF2",
    planSnapshot: { paymentPattern: "FIXED", paymentRules: { partialPaymentAllowed: true } },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 100_000,
    installments: [{
      number: 1, dueDate: "2026-01-05", amountPaise: 100_000, paidPaise: 0, status: "DUE", graceEndsAt: "2026-01-10",
    }],
    version: 1,
    createdBy: user._id,
  });
  const token = bearerFor(user);
  const response = await request(app)
    .post("/api/v1/staff/payments")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", randomUUID())
    .send({
      schemeId: scheme._id,
      amountPaise: 10_000,
      mode: "CASH",
      expectedVersion: 1,
      referenceDate: "2020-01-15",
    })
    .expect(400);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("recordPayment service rejects referenceDate without internal flag", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("plan"),
    enrollmentNumber: "ENR-REF3",
    planSnapshot: { paymentPattern: "FIXED", paymentRules: { partialPaymentAllowed: true } },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 100_000,
    installments: [{
      number: 1, dueDate: "2026-01-05", amountPaise: 100_000, paidPaise: 0, status: "DUE", graceEndsAt: "2026-01-10",
    }],
    version: 1,
    createdBy: user._id,
  });
  const req = {
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    body: { schemeId: scheme._id, amountPaise: 10_000, mode: "CASH", expectedVersion: 1 },
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
  await assert.rejects(
    () => recordPayment(req, { referenceDate: "2020-01-15" }),
    (error) => error instanceof AppError && error.code === "REFERENCE_DATE_OVERRIDE_FORBIDDEN",
  );
  await assert.rejects(
    async () => recordPayment({ ...req, body: { ...req.body, referenceDate: "2020-01-15" } }),
    (error) => error instanceof AppError && error.code === "VALIDATION_FAILED",
  );
});
