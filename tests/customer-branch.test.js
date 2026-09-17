import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/lib/app-error.js";
import { createId } from "../src/lib/ids.js";
import { Branch } from "../src/models/index.js";
import { updateCustomer } from "../src/services/customer.service.js";
import { TenantRole, UserType } from "../src/constants/enums.js";
import { resetTestDb, seedBranch, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function customerReq({ user, customer, body, scopeBranchId }) {
  return {
    auth: { id: user._id, tenantId: customer.tenantId, role: user.role, type: UserType.TENANT_USER },
    scope: { tenantId: customer.tenantId, ...(scopeBranchId ? { branchId: scopeBranchId } : {}) },
    params: { customerId: customer._id },
    body,
    headers: { "user-agent": "customer-branch-test" },
    ip: "127.0.0.1",
  };
}

test("branch-scoped staff cannot reassign customers to another branch", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER });
  const otherBranch = await seedBranch({ tenantId: tenant._id, code: "BR3", name: "Third Branch" });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await assert.rejects(
    () => updateCustomer(customerReq({
      user,
      customer,
      scopeBranchId: branch._id,
      body: { branchId: otherBranch._id, expectedVersion: customer.version },
    })),
    (error) => error instanceof AppError && error.code === "FORBIDDEN",
  );
});

test("tenant owner can reassign customer to an active branch", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const otherBranch = await seedBranch({ tenantId: tenant._id, code: "BR3", name: "Third Branch" });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const updated = await updateCustomer(customerReq({
    user,
    customer,
    body: { branchId: otherBranch._id, expectedVersion: customer.version },
  }));
  assert.equal(updated.branchId, otherBranch._id);
});

test("branch reassignment rejects inactive target branch", async () => {
  const { tenant, branch, user } = await seedTenantUser({ role: TenantRole.TENANT_OWNER });
  const inactiveBranch = await Branch.create({
    _id: createId("branch"),
    tenantId: tenant._id,
    code: "OLD",
    name: "Closed Branch",
    active: false,
  });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await assert.rejects(
    () => updateCustomer(customerReq({
      user,
      customer,
      body: { branchId: inactiveBranch._id, expectedVersion: customer.version },
    })),
    (error) => error instanceof AppError && error.code === "BRANCH_INVALID",
  );
});
