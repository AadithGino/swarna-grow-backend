import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Session, Tenant } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { signAccessToken } from "../src/services/token.service.js";
import {
  assertKycTypeAllowed,
  isCustomerSelfKycEnabled,
  kycAllowedTypesForTenant,
} from "../src/lib/kyc-policy.js";
import {
  customerHasRequiredProfileFields,
  mergeCustomerProfileFields,
  profileCompletionUpdateOps,
} from "../src/lib/customer-profile-completion.js";
import { AppError } from "../src/lib/app-error.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

test("kyc policy — allowed types come from tenant.operations", () => {
  assert.deepEqual(kycAllowedTypesForTenant({ operations: { kycAllowedTypes: ["PAN"] } }), ["PAN"]);
  assert.throws(
    () => assertKycTypeAllowed({ operations: { kycAllowedTypes: ["PAN"] } }, "AADHAAR"),
    (err) => err instanceof AppError && err.code === "KYC_TYPE_NOT_ALLOWED",
  );
});

test("customer self KYC enabled when kycMandatory or requireKycForEnrolment", () => {
  assert.equal(isCustomerSelfKycEnabled({ operations: { kycMandatory: true } }), true);
  assert.equal(isCustomerSelfKycEnabled({ settings: { requireKycForEnrolment: true } }), true);
  assert.equal(isCustomerSelfKycEnabled({}), false);
});

test("profile completion — PATCH ops set profileCompletedAt only when required fields present", () => {
  const customer = {
    name: "Customer",
    mobile: "+919800000001",
    branchId: "br_1",
    address: null,
  };
  const merged = mergeCustomerProfileFields(customer, {
    name: "Ada Lovelace",
    address: "12 Church Street, Bengaluru",
  });
  const { $set } = profileCompletionUpdateOps(customer, merged);
  assert.ok($set.profileCompletedAt);
  assert.equal(customerHasRequiredProfileFields({ ...customer, ...merged }), true);
});

test("admin customer create rejects missing address", async () => {
  const { user, branch } = await seedTenantUser({});
  const res = await request(app)
    .post("/api/v1/admin/customers")
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({
      branchId: branch._id,
      name: "No Address",
      mobile: "+919811122233",
    });
  assert.ok([400, 422].includes(res.status));
});

test("admin KYC rejects type outside tenant kycAllowedTypes", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { operations: { kycAllowedTypes: ["PAN"] } } },
  );
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+919822233344",
    name: "KYC Test",
  });
  const res = await request(app)
    .put(`/api/v1/admin/customers/${customer._id}/kyc`)
    .set("authorization", `Bearer ${bearerFor(user)}`)
    .set("x-idempotency-key", randomUUID())
    .send({ type: "AADHAAR", number: "123456789012" });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code ?? res.body.code, "KYC_TYPE_NOT_ALLOWED");
});

test("app PATCH profile rejects profileCompletedAt and partial patch stays incomplete", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+919833344455",
    name: "Customer",
  });
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "customer-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const custToken = signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "customer-device",
    securityVersion: 0,
    sessionId: session._id,
  });

  const bad = await request(app)
    .patch("/api/v1/app/profile")
    .set("authorization", `Bearer ${custToken}`)
    .send({ name: "Only Name", profileCompletedAt: new Date().toISOString() });
  assert.ok([400, 422].includes(bad.status), `expected validation error, got ${bad.status}`);

  const partial = await request(app)
    .patch("/api/v1/app/profile")
    .set("authorization", `Bearer ${custToken}`)
    .send({ name: "Only Name" });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.data.profileComplete, false);
  assert.equal(partial.body.data.profileCompletedAt, undefined);
});

test("app POST profile/complete requires address and marks profile complete", async () => {
  const { tenant, branch } = await seedTenantUser({});
  const customer = await seedCustomer({
    tenantId: tenant._id,
    branchId: branch._id,
    mobile: "+919844455566",
    name: "Customer",
  });
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "customer-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const custToken = signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "customer-device",
    securityVersion: 0,
    sessionId: session._id,
  });

  const complete = await request(app)
    .post("/api/v1/app/profile/complete")
    .set("authorization", `Bearer ${custToken}`)
    .set("x-idempotency-key", randomUUID())
    .send({
      name: "Complete User",
      address: "221B Baker Street, London",
    });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.data.profileComplete, true);
});
