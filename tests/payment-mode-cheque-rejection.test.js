import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/lib/app-error.js";
import { createId } from "../src/lib/ids.js";
import { Customer, Payment, Scheme, Session, User } from "../src/models/index.js";
import argon2 from "argon2";
import {
  ManualPaymentMode,
  PAYMENT_MODE_LABELS,
  PAYMENT_MODE_ORDER,
  PaymentMode,
  TenantRole,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { buildCollectionReport } from "../src/services/report-builders/collection.report.js";
import { listPayments } from "../src/services/payment.service.js";
import { recordPayment } from "../src/services/payment.service.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();
const UNSUPPORTED_CHEQUE = "CHEQUE";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

async function seedActiveScheme() {
  const { tenant, branch, user } = await seedTenantUser({
    role: TenantRole.TENANT_OWNER,
    mobile: `+9197${String(Date.now()).slice(-8)}`,
  });
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: `C${Date.now()}`,
    name: "Pay Customer",
    mobile: `+9188${String(Date.now()).slice(-8)}`,
  });
  const scheme = await Scheme.create({
    _id: createId("scheme"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId: customer._id,
    planId: createId("schemePlan"),
    enrollmentNumber: `ENR-${Date.now()}`,
    planSnapshot: {
      paymentPattern: "FIXED",
      paymentRules: { partialPaymentAllowed: true, advancePaymentAllowed: false, maxAdvanceInstallments: 0, minPaymentPaise: 1000 },
    },
    valueBasis: "CASH",
    paymentPattern: "FIXED",
    status: "ACTIVE",
    startDate: "2026-01-01",
    maturityDate: "2026-12-01",
    installmentAmountPaise: 100_000,
    installments: [{
      number: 1,
      dueDate: "2026-01-05",
      amountPaise: 100_000,
      paidPaise: 0,
      status: "DUE",
      graceEndsAt: "2026-01-10",
    }],
    version: 1,
    createdBy: user._id,
  });
  return { tenant, branch, user, scheme };
}

async function adminPaymentReq({ scheme, user, mode, amountPaise = 10_000, reference, remarks }) {
  const current = await Scheme.findById(scheme._id).lean();
  return {
    auth: { id: user._id, tenantId: scheme.tenantId, type: "TENANT_USER" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "cheque-rejection-test" },
    ip: "127.0.0.1",
    body: {
      schemeId: scheme._id,
      amountPaise,
      mode,
      expectedVersion: current.version,
      ...(reference !== undefined ? { reference } : {}),
      ...(remarks !== undefined ? { remarks } : {}),
    },
    query: {},
  };
}

test("V1 enums exclude CHEQUE from manual and ordered payment modes", () => {
  assert.equal(ManualPaymentMode.CHEQUE, undefined);
  assert.equal(PaymentMode.CHEQUE, undefined);
  assert.ok(!Object.values(ManualPaymentMode).includes(UNSUPPORTED_CHEQUE));
  assert.ok(!PAYMENT_MODE_ORDER.includes(UNSUPPORTED_CHEQUE));
  assert.equal(PAYMENT_MODE_LABELS.CHEQUE, undefined);
  assert.deepEqual(Object.values(ManualPaymentMode), ["CASH", "CARD", "UPI", "BANK_TRANSFER"]);
});

test("admin manual payment rejects CHEQUE at validation", async () => {
  const { user, scheme } = await seedActiveScheme();
  const token = bearerFor(user);
  const response = await request(app)
    .post("/api/v1/admin/payments")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", randomUUID())
    .send({ schemeId: scheme._id, amountPaise: 50_000, mode: UNSUPPORTED_CHEQUE, expectedVersion: 1 })
    .expect(400);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
  assert.equal(await Payment.countDocuments({ schemeId: scheme._id }), 0);
});

test("staff manual payment rejects CHEQUE at validation", async () => {
  const { tenant, branch, scheme } = await seedActiveScheme();
  const staff = await User.create({
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
    userId: staff._id,
    tenantId: tenant._id,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  staff.$locals = { testSessionId: session._id };
  const token = bearerFor(staff);
  const response = await request(app)
    .post("/api/v1/staff/payments")
    .set("authorization", `Bearer ${token}`)
    .set("x-idempotency-key", randomUUID())
    .send({ schemeId: scheme._id, amountPaise: 50_000, mode: UNSUPPORTED_CHEQUE, expectedVersion: 1 })
    .expect(400);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
  assert.equal(await Payment.countDocuments({ schemeId: scheme._id }), 0);
});

test("recordPayment rejects CHEQUE like other non-manual modes", async () => {
  const { scheme, user } = await seedActiveScheme();
  await assert.rejects(
    async () => recordPayment(await adminPaymentReq({ scheme, user, mode: UNSUPPORTED_CHEQUE })),
    (error) => error instanceof AppError && error.code === "MANUAL_GATEWAY_PAYMENT_NOT_ALLOWED",
  );
});

test("payment list mode breakdown exposes only supported V1 manual modes", async () => {
  const { tenant, user, scheme } = await seedActiveScheme();
  await recordPayment(await adminPaymentReq({ scheme, user, mode: ManualPaymentMode.CASH }));
  const listed = await listPayments({
    auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
    scope: { tenantId: tenant._id },
    query: { includeSummary: "true" },
  });
  const modes = listed.meta.summary.byMode.map((row) => row.mode);
  assert.ok(!modes.includes(UNSUPPORTED_CHEQUE));
  for (const supported of Object.values(ManualPaymentMode)) {
    assert.ok(modes.includes(supported));
  }
});

test("collection report columns omit cheque bucket", async () => {
  const { tenant, user } = await seedActiveScheme();
  const report = await buildCollectionReport(reportReq(user, tenant));
  const keys = report.columns.map((col) => col.key);
  assert.ok(!keys.includes("cheque"));
});

test("supported manual modes accept optional reference and remarks", async () => {
  const { scheme, user } = await seedActiveScheme();
  for (const mode of Object.values(ManualPaymentMode)) {
    const payment = await recordPayment(await adminPaymentReq({ scheme, user, mode }));
    assert.equal(payment.mode, mode);
    assert.equal(payment.reference ?? null, null);
    assert.equal(payment.remarks ?? null, null);
  }
  const withMeta = await recordPayment(await adminPaymentReq({
    scheme,
    user,
    mode: ManualPaymentMode.BANK_TRANSFER,
    reference: "UTR-123",
    remarks: "Branch deposit",
  }));
  assert.equal(withMeta.reference, "UTR-123");
  assert.equal(withMeta.remarks, "Branch deposit");
});

function reportReq(user, tenant, query = {}) {
  return {
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: "TENANT_USER",
      role: TenantRole.TENANT_OWNER,
    },
    scope: { tenantId: tenant._id },
    query,
  };
}
