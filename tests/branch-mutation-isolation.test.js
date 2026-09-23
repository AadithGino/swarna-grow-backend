import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AuditEntityType } from "../src/constants/enums.js";
import { AuditEvent, Branch } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { bearerFor, resetTestDb, seedBranch, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function branchHeaders(user, key = createId("idem")) {
  return {
    authorization: `Bearer ${bearerFor(user)}`,
    "x-idempotency-key": key,
  };
}

test("valid branch creation succeeds with server-owned ids", async () => {
  const { tenant, user } = await seedTenantUser({});
  const before = await Branch.countDocuments({ tenantId: tenant._id });
  const res = await request(app)
    .post("/api/v1/admin/branches")
    .set(branchHeaders(user))
    .send({ code: "nbr1", name: "North Branch", address: "12 MG Road" });
  assert.equal(res.status, 201);
  assert.match(res.body.data._id, /^brn_/);
  assert.equal(res.body.data.tenantId, tenant._id);
  assert.equal(res.body.data.code, "NBR1");
  assert.equal(await Branch.countDocuments({ tenantId: tenant._id }), before + 1);
});

test("client _id and tenantId are rejected on create", async () => {
  const { tenant, user } = await seedTenantUser({});
  const foreignId = createId("branch");
  const foreignTenant = createId("tenant");
  for (const body of [
    { code: "X1", name: "Bad", _id: foreignId },
    { code: "X2", name: "Bad", tenantId: foreignTenant },
    { code: "X3", name: "Bad", version: 99 },
  ]) {
    const res = await request(app)
      .post("/api/v1/admin/branches")
      .set(branchHeaders(user))
      .send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, "VALIDATION_FAILED");
    assert.equal(await Branch.countDocuments({ _id: foreignId }), 0);
    assert.equal(await Branch.countDocuments({ tenantId: foreignTenant }), 0);
  }
  assert.equal(await Branch.countDocuments({ tenantId: tenant._id, code: "X1" }), 0);
});

test("unknown fields are rejected on create and update", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const createRes = await request(app)
    .post("/api/v1/admin/branches")
    .set(branchHeaders(user))
    .send({ code: "UNK", name: "Unknown field", injected: true });
  assert.equal(createRes.status, 400);
  const patchRes = await request(app)
    .patch(`/api/v1/admin/branches/${branch._id}`)
    .set(branchHeaders(user))
    .send({ name: "Renamed", tenantId: createId("tenant") });
  assert.equal(patchRes.status, 400);
  const row = await Branch.findById(branch._id).lean();
  assert.equal(row.tenantId, tenant._id);
  assert.notEqual(row.name, "Renamed");
});

test("foreign tenantId in body does not create branch for another tenant", async () => {
  const home = await seedTenantUser({ tenantCode: "HOME01" });
  const other = await seedTenantUser({ tenantCode: "OTH02", mobile: "+919811199991" });
  const beforeOther = await Branch.countDocuments({ tenantId: other.tenant._id });
  const res = await request(app)
    .post("/api/v1/admin/branches")
    .set(branchHeaders(home.user))
    .send({ code: "INJ", name: "Injected", tenantId: other.tenant._id });
  assert.equal(res.status, 400);
  assert.equal(await Branch.countDocuments({ tenantId: other.tenant._id }), beforeOther);
  const audits = await AuditEvent.find({
    entityType: AuditEntityType.BRANCH,
    action: "BRANCH_CREATED",
  }).lean();
  assert.equal(audits.length, 0);
});

test("duplicate branch code returns business error and leaves one row", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const res = await request(app)
    .post("/api/v1/admin/branches")
    .set(branchHeaders(user))
    .send({ code: branch.code, name: "Duplicate attempt" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "BRANCH_CODE_EXISTS");
  assert.equal(await Branch.countDocuments({ tenantId: tenant._id, code: branch.code }), 1);
});

test("branch update cannot change code or tenantId", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  const other = await seedBranch({ tenantId: tenant._id, code: "OTH", name: "Other" });
  const res = await request(app)
    .patch(`/api/v1/admin/branches/${branch._id}`)
    .set(branchHeaders(user))
    .send({ name: "Updated name", expectedVersion: branch.version ?? 0 });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.name, "Updated name");
  const fresh = await Branch.findById(branch._id).lean();
  assert.equal(fresh.code, branch.code);
  assert.equal(fresh.tenantId, tenant._id);
  assert.notEqual(fresh._id, other._id);
});
