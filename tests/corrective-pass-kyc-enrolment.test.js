import test from "node:test";
import assert from "node:assert/strict";
import { TenantStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { isKycMandatoryForEnrolment } from "../src/lib/kyc-policy.js";
import { Tenant } from "../src/models/index.js";
import { resetTestDb, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

async function seedTenant(overrides) {
  return Tenant.create({
    _id: createId("tenant"),
    code: `KYC${String(Math.floor(Math.random() * 9000) + 1000)}`,
    name: "KYC Policy Tenant",
    mobile: `+9197${String(Date.now()).slice(-8)}`,
    status: TenantStatus.ACTIVE,
    subscription: { status: "ACTIVE", tier: "STARTER" },
    ...overrides,
  });
}

test("legacy requireKycForEnrolment alone makes KYC mandatory on persisted tenant", async () => {
  const created = await seedTenant({
    settings: { requireKycForEnrolment: true },
  });
  const tenant = await Tenant.findById(created._id).lean();
  assert.equal(tenant.settings.requireKycForEnrolment, true);
  assert.equal(tenant.operations?.kycMandatory, undefined);
  assert.equal(isKycMandatoryForEnrolment(tenant), true);
});

test("explicit operations.kycMandatory true on persisted tenant", async () => {
  const created = await seedTenant({
    settings: { requireKycForEnrolment: false },
    operations: { kycMandatory: true },
  });
  const tenant = await Tenant.findById(created._id).lean();
  assert.equal(isKycMandatoryForEnrolment(tenant), true);
});

test("both unset on persisted tenant yields KYC not mandatory", async () => {
  const created = await seedTenant({
    settings: { requireKycForEnrolment: false },
  });
  const tenant = await Tenant.findById(created._id).lean();
  assert.equal(tenant.operations?.kycMandatory, undefined);
  assert.equal(isKycMandatoryForEnrolment(tenant), false);
});

test("explicit operations.kycMandatory false overrides legacy require flag", async () => {
  const created = await seedTenant({
    settings: { requireKycForEnrolment: true },
    operations: { kycMandatory: false },
  });
  const tenant = await Tenant.findById(created._id).lean();
  assert.equal(isKycMandatoryForEnrolment(tenant), false);
});
